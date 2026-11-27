import os
import shutil
import subprocess
import time
import uuid
from pathlib import Path
from fastapi import FastAPI, File, UploadFile, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from faster_whisper import WhisperModel

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = Path(__file__).parent / "work"
BASE_DIR.mkdir(exist_ok=True)

print("[INIT] Memuat model Faster-Whisper (small)...")
t_init = time.perf_counter()
whisper_model = WhisperModel("small", device="cpu", compute_type="int8")
print(f"[INIT] Model Faster-Whisper siap dalam {time.perf_counter() - t_init:.1f}s")

STEMS_6S = ["drums", "bass", "guitar", "piano", "other", "vocals"]
jobs: dict[str, dict] = {}


def log_step(job_id: str, step: str, message: str):
    ts = time.strftime("%H:%M:%S")
    line = f"[{ts}] [{job_id[:8]}] [{step}] {message}"
    print(line, flush=True)
    if job_id in jobs:
        jobs[job_id]["step"] = step
        jobs[job_id]["message"] = message
        jobs[job_id]["logs"].append(line)


def run_cmd_with_log(job_id: str, step: str, cmd: list[str], label: str):
    start = time.perf_counter()
    log_step(job_id, step, f"Mulai {label}...")
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    assert proc.stdout is not None
    for raw_line in proc.stdout:
        clean = raw_line.strip()
        if clean and any(k in clean.lower() for k in ["%", "frame=", "time=", "error", "warning", "separating"]):
            print(f"    -> {clean}", flush=True)
    proc.wait()
    elapsed = time.perf_counter() - start
    if proc.returncode != 0:
        raise RuntimeError(f"{label} gagal (exit code {proc.returncode})")
    log_step(job_id, step, f"Selesai {label} ({elapsed:.1f}s)")


def format_srt_time(seconds: float) -> str:
    millis = int(round(seconds * 1000))
    hours = millis // 3_600_000
    millis %= 3_600_000
    minutes = millis // 60_000
    millis %= 60_000
    secs = millis // 1000
    ms = millis % 1000
    return f"{hours:02}:{minutes:02}:{secs:02},{ms:03}"


def execute_job(job_id: str, input_path: Path, is_video: bool, job_dir: Path):
    total_start = time.perf_counter()
    try:
        # 1. Ekstrak audio WAV
        wav_path = job_dir / "source.wav"
        run_cmd_with_log(
            job_id,
            "1/4 EXTRACT",
            ["ffmpeg", "-i", str(input_path), "-vn", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2", str(wav_path), "-y"],
            "ekstraksi audio WAV",
        )

        # 2. Pisahkan vokal & instrumen dengan Demucs
        demucs_out = job_dir / "demucs_out"
        run_cmd_with_log(
            job_id,
            "2/4 DEMUCS",
            ["demucs", "-n", "htdemucs", "--two-stems=vocals", str(wav_path), "-o", str(demucs_out)],
            "pemisahan vokal Demucs",
        )

        vocal_wav = demucs_out / "htdemucs" / "source" / "vocals.wav"
        no_vocal_wav = demucs_out / "htdemucs" / "source" / "no_vocals.wav"

        if not is_video:
            out_mp3 = job_dir / "instrumental.mp3"
            run_cmd_with_log(
                job_id,
                "3/3 EXPORT",
                ["ffmpeg", "-i", str(no_vocal_wav), "-codec:a", "libmp3lame", "-q:a", "2", str(out_mp3), "-y"],
                "encode MP3 instrumental",
            )
            total_s = time.perf_counter() - total_start
            log_step(job_id, "DONE", f"Semua selesai dalam {total_s:.1f}s")
            jobs[job_id]["status"] = "completed"
            jobs[job_id]["result"] = {
                "job_id": job_id,
                "type": "audio",
                "download_file": "instrumental.mp3",
            }
            return

        # 3. Transkripsi subtitle (.srt) dari trek vokal
        t_wh = time.perf_counter()
        log_step(job_id, "3/4 WHISPER", "Mulai transkripsi subtitle dari trek vokal...")
        segments, _ = whisper_model.transcribe(str(vocal_wav), beam_size=5)
        srt_path = job_dir / "subtitle.srt"
        seg_count = 0
        with open(srt_path, "w", encoding="utf-8") as srt_file:
            for seg in segments:
                text = seg.text.strip()
                if text:
                    seg_count += 1
                    start_str = format_srt_time(seg.start)
                    end_str = format_srt_time(seg.end)
                    srt_file.write(f"{seg_count}\n{start_str} --> {end_str}\n{text}\n\n")
        log_step(
            job_id,
            "3/4 WHISPER",
            f"Selesai transkripsi ({seg_count} baris subtitle) dalam {time.perf_counter() - t_wh:.1f}s",
        )

        # 4. Gabungkan video + audio instrumental + subtitle
        out_video = job_dir / "output_no_vocal_subtitled.mp4"
        escaped_srt = str(srt_path).replace("\\", "/").replace(":", "\\:")
        run_cmd_with_log(
            job_id,
            "4/4 MUXING",
            [
                "ffmpeg",
                "-i", str(input_path),
                "-i", str(no_vocal_wav),
                "-vf", f"subtitles='{escaped_srt}'",
                "-map", "0:v:0",
                "-map", "1:a:0",
                "-c:v", "libx264",
                "-preset", "veryfast",
                "-crf", "23",
                "-c:a", "aac",
                "-b:a", "192k",
                str(out_video),
                "-y",
            ],
            "render video + audio + subtitle",
        )

        total_s = time.perf_counter() - total_start
        log_step(job_id, "DONE", f"Semua selesai dalam {total_s:.1f}s")
        jobs[job_id]["status"] = "completed"
        jobs[job_id]["result"] = {
            "job_id": job_id,
            "type": "video",
            "download_file": "output_no_vocal_subtitled.mp4",
            "subtitle_file": "subtitle.srt",
        }

    except Exception as exc:
        log_step(job_id, "ERROR", str(exc))
        jobs[job_id]["status"] = "failed"
        jobs[job_id]["error"] = str(exc)


def execute_stem_job(job_id: str, input_path: Path, job_dir: Path):
    total_start = time.perf_counter()
    try:
        wav_path = job_dir / "source.wav"
        run_cmd_with_log(
            job_id,
            "1/2 EXTRACT",
            ["ffmpeg", "-i", str(input_path), "-vn", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2", str(wav_path), "-y"],
            "ekstraksi audio WAV",
        )

        demucs_out = job_dir / "demucs_out"
        run_cmd_with_log(
            job_id,
            "2/2 DEMUCS_6S",
            ["demucs", "-n", "htdemucs_6s", str(wav_path), "-o", str(demucs_out)],
            "pemisahan 6 stem (drums, bass, guitar, piano, other, vocals)",
        )

        stem_dir = demucs_out / "htdemucs_6s" / "source"
        available_stems = [s for s in STEMS_6S if (stem_dir / f"{s}.wav").exists()]

        total_s = time.perf_counter() - total_start
        log_step(job_id, "DONE", f"Pemisahan stem selesai dalam {total_s:.1f}s")
        jobs[job_id]["status"] = "completed"
        jobs[job_id]["stems"] = available_stems
    except Exception as exc:
        log_step(job_id, "ERROR", str(exc))
        jobs[job_id]["status"] = "failed"
        jobs[job_id]["error"] = str(exc)


@app.post("/process")
async def process_media(background_tasks: BackgroundTasks, file: UploadFile = File(...)):
    ext = Path(file.filename or "").suffix.lower()
    video_exts = {".mp4", ".mkv", ".mov", ".webm"}
    audio_exts = {".mp3", ".wav", ".m4a", ".flac", ".ogg"}

    if ext not in video_exts | audio_exts:
        raise HTTPException(status_code=400, detail="Format file tidak didukung.")

    is_video = ext in video_exts
    job_id = str(uuid.uuid4())
    job_dir = BASE_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    input_path = job_dir / f"input{ext}"
    with open(input_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    jobs[job_id] = {
        "status": "processing",
        "step": "QUEUED",
        "message": "File diterima, menyiapkan proses...",
        "logs": [],
        "stems": [],
        "result": None,
        "error": None,
    }
    log_step(job_id, "UPLOAD", f"File '{file.filename}' ({'video' if is_video else 'audio'}) siap diproses.")

    background_tasks.add_task(execute_job, job_id, input_path, is_video, job_dir)
    return {"job_id": job_id}


@app.post("/separate-stems")
async def separate_stems(background_tasks: BackgroundTasks, file: UploadFile = File(...)):
    ext = Path(file.filename or "").suffix.lower()
    allowed = {".mp3", ".wav", ".m4a", ".flac", ".ogg", ".mp4"}
    if ext not in allowed:
        raise HTTPException(status_code=400, detail="Format file tidak didukung.")

    job_id = str(uuid.uuid4())
    job_dir = BASE_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    input_path = job_dir / f"input{ext}"
    with open(input_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    jobs[job_id] = {
        "status": "processing",
        "step": "QUEUED",
        "message": "Menyiapkan pemisahan 6 stem...",
        "logs": [],
        "stems": [],
        "result": None,
        "error": None,
    }
    log_step(job_id, "UPLOAD", f"File '{file.filename}' masuk antrean stem.")
    background_tasks.add_task(execute_stem_job, job_id, input_path, job_dir)
    return {"job_id": job_id}


@app.get("/status/{job_id}")
def get_status(job_id: str):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job tidak ditemukan.")
    return jobs[job_id]


@app.get("/stem/{job_id}/{stem_name}")
def get_stem_file(job_id: str, stem_name: str):
    safe_stem = os.path.basename(stem_name)
    if safe_stem not in STEMS_6S:
        raise HTTPException(status_code=400, detail="Nama stem tidak valid.")
    file_path = BASE_DIR / job_id / "demucs_out" / "htdemucs_6s" / "source" / f"{safe_stem}.wav"
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File stem tidak ditemukan.")
    return FileResponse(path=str(file_path), media_type="audio/wav", filename=f"{safe_stem}.wav")


@app.get("/download/{job_id}/{filename}")
def download_file(job_id: str, filename: str):
    safe_name = os.path.basename(filename)
    file_path = BASE_DIR / job_id / safe_name
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File tidak ditemukan.")
    return FileResponse(path=str(file_path), filename=safe_name)