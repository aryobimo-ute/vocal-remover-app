import json
import math
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Optional
from fastapi import FastAPI, File, Form, UploadFile, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from faster_whisper import WhisperModel
import librosa
import numpy as np
from pydantic import BaseModel
import torch

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = Path(__file__).parent / "work"
BASE_DIR.mkdir(parents=True, exist_ok=True)
LIBRARY_FILE = BASE_DIR / "stem_library.json"
library_lock = threading.RLock()

whisper_device = "cuda" if torch.cuda.is_available() else "cpu"
whisper_compute_type = "float16" if whisper_device == "cuda" else "int8"

print(
    f"[INIT] Memuat model Faster-Whisper (small) di {whisper_device.upper()} ({whisper_compute_type})..."
)
t_init = time.perf_counter()
whisper_model = WhisperModel("small", device=whisper_device, compute_type=whisper_compute_type)
print(f"[INIT] Model Faster-Whisper siap dalam {time.perf_counter() - t_init:.1f}s")

STEMS_6S = ["drums", "bass", "guitar", "piano", "other", "vocals"]
jobs: dict[str, dict] = {}
PERCENT_RE = re.compile(r"(\d{1,3}(?:\.\d+)?)%")


class LibraryUpdateRequest(BaseModel):
    title: Optional[str] = None
    beat_offset_sec: Optional[float] = None
    detected_bpm: Optional[int] = None


def _read_library_unlocked() -> list[dict]:
    if not LIBRARY_FILE.exists():
        return []
    try:
        data = json.loads(LIBRARY_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def load_stem_library() -> list[dict]:
    with library_lock:
        items = _read_library_unlocked()
        for item in items:
            if "beat_offset_sec" not in item:
                item["beat_offset_sec"] = 0.0
        return items


def save_stem_to_library(entry: dict):
    with library_lock:
        BASE_DIR.mkdir(parents=True, exist_ok=True)
        items = _read_library_unlocked()
        items = [x for x in items if x.get("job_id") != entry.get("job_id")]
        items.insert(0, entry)
        LIBRARY_FILE.write_text(
            json.dumps(items, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )


def update_stem_in_library(
    job_id: str,
    new_title: Optional[str] = None,
    beat_offset_sec: Optional[float] = None,
    detected_bpm: Optional[int] = None,
) -> Optional[dict]:
    with library_lock:
        items = _read_library_unlocked()
        updated_item: Optional[dict] = None
        for item in items:
            if item.get("job_id") == job_id:
                if new_title is not None:
                    item["title"] = new_title
                if beat_offset_sec is not None and math.isfinite(beat_offset_sec):
                    item["beat_offset_sec"] = round(float(beat_offset_sec), 3)
                if detected_bpm is not None:
                    item["detected_bpm"] = int(max(40, min(240, detected_bpm)))
                if "beat_offset_sec" not in item:
                    item["beat_offset_sec"] = 0.0
                updated_item = item
                break
        if updated_item is None:
            return None
        BASE_DIR.mkdir(parents=True, exist_ok=True)
        LIBRARY_FILE.write_text(
            json.dumps(items, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        return updated_item


def remove_stem_from_library(job_id: str) -> bool:
    with library_lock:
        items = _read_library_unlocked()
        new_items = [x for x in items if x.get("job_id") != job_id]
        if len(new_items) == len(items):
            return False
        LIBRARY_FILE.write_text(
            json.dumps(new_items, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        return True


def log_step(job_id: str, step: str, message: str, progress: Optional[int] = None):
    ts = time.strftime("%H:%M:%S")
    line = f"[{ts}] [{job_id[:8]}] [{step}] {message}"
    print(line, flush=True)
    if job_id in jobs:
        jobs[job_id]["step"] = step
        jobs[job_id]["message"] = message
        jobs[job_id]["logs"].append(line)
        if progress is not None:
            jobs[job_id]["progress"] = max(0, min(100, int(round(progress))))


def run_cmd_with_log(
    job_id: str,
    step: str,
    cmd: list[str],
    label: str,
    start_pct: Optional[int] = None,
    end_pct: Optional[int] = None,
):
    start = time.perf_counter()
    log_step(job_id, step, f"Mulai {label}...", progress=start_pct)
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
        if not clean:
            continue

        match = PERCENT_RE.search(clean)
        if match and start_pct is not None and end_pct is not None and job_id in jobs:
            sub_pct = max(0.0, min(100.0, float(match.group(1))))
            mapped = start_pct + (end_pct - start_pct) * (sub_pct / 100.0)
            jobs[job_id]["progress"] = int(round(mapped))
            jobs[job_id]["message"] = f"{label} ({int(round(sub_pct))}%)"

        if any(k in clean.lower() for k in ["%", "frame=", "time=", "error", "warning", "separating", "download"]):
            print(f"    -> {clean}", flush=True)

    proc.wait()
    elapsed = time.perf_counter() - start
    if proc.returncode != 0:
        raise RuntimeError(f"{label} gagal (exit code {proc.returncode})")
    log_step(job_id, step, f"Selesai {label} ({elapsed:.1f}s)", progress=end_pct)


def download_from_youtube(job_id: str, url: str, job_dir: Path, prefer_audio_only: bool) -> tuple[Path, bool]:
    out_template = str(job_dir / "yt_source.%(ext)s")
    if prefer_audio_only:
        cmd = [
            "yt-dlp",
            "--no-playlist",
            "--newline",
            "-f",
            "bestaudio/best",
            "-o",
            out_template,
            url,
        ]
    else:
        cmd = [
            "yt-dlp",
            "--no-playlist",
            "--newline",
            "-f",
            "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
            "--merge-output-format",
            "mp4",
            "-o",
            out_template,
            url,
        ]

    run_cmd_with_log(job_id, "YT_DLP", cmd, "unduh media dari link YouTube", start_pct=2, end_pct=15)

    matches = [p for p in job_dir.glob("yt_source.*") if p.is_file()]
    if not matches:
        raise RuntimeError("File hasil unduhan YouTube tidak ditemukan.")

    downloaded = matches[0]
    video_exts = {".mp4", ".mkv", ".webm", ".mov"}
    is_video = (not prefer_audio_only) and (downloaded.suffix.lower() in video_exts)
    return downloaded, is_video


def analyze_bpm_and_beat_offset(
    audio_path: Path,
    job_id: str,
    progress: Optional[int] = None,
    fallback_bpm: int = 120,
) -> tuple[int, float]:
    """Mendeteksi BPM serta fase offset ketukan (detik) agar selaras dengan ketukan drum."""
    try:
        y, sr = librosa.load(str(audio_path), sr=22050, mono=True)
        if y.size == 0:
            return fallback_bpm, 0.0

        onset_env = librosa.onset.onset_strength(y=y, sr=sr)
        tempo, beat_frames = librosa.beat.beat_track(
            y=y,
            sr=sr,
            onset_envelope=onset_env,
            units="frames",
        )

        raw_bpm = float(np.asarray(tempo).reshape(-1)[0])
        beat_times = librosa.frames_to_time(beat_frames, sr=sr)

        # Jika interval antar beat konsisten, gunakan median interval sebagai BPM yang lebih stabil
        if len(beat_times) >= 4:
            diffs = np.diff(beat_times)
            valid_diffs = diffs[(diffs > 0.2) & (diffs < 1.6)]
            if valid_diffs.size >= 3:
                median_period = float(np.median(valid_diffs))
                interval_bpm = 60.0 / median_period
                if 40.0 <= interval_bpm <= 240.0:
                    raw_bpm = interval_bpm

        if math.isnan(raw_bpm) or raw_bpm <= 0:
            bpm_int = fallback_bpm
        else:
            bpm_int = int(max(40, min(240, round(raw_bpm))))

        beat_period = 60.0 / float(bpm_int)
        beat_offset_sec = 0.0

        if len(beat_times) > 0:
            # Cari fase ketukan (mod beat_period) yang paling sering muncul di beat_times
            phases = np.mod(beat_times, beat_period)
            # Gunakan circular mean / histogram binning pada [0, beat_period)
            num_bins = 72
            hist, bin_edges = np.histogram(phases, bins=num_bins, range=(0.0, beat_period))
            best_bin = int(np.argmax(hist))
            in_bin = phases[(phases >= bin_edges[best_bin]) & (phases <= bin_edges[best_bin + 1])]
            if in_bin.size > 0:
                phase_sec = float(np.mean(in_bin))
            else:
                phase_sec = float(phases[0])

            # Haluskan lagi dengan puncak onset terdekat di sekitar fase awal
            search_window = min(0.08, beat_period * 0.2)
            onset_times = librosa.times_like(onset_env, sr=sr)
            if onset_times.size > 0 and onset_env.size > 0:
                # Cari transient kuat pertama atau sesuaikan ke beat_times[0] jika sangat dekat
                first_beat = float(beat_times[0])
                if abs(((first_beat - phase_sec + beat_period / 2) % beat_period) - beat_period / 2) <= search_window:
                    phase_sec = float(first_beat % beat_period)

            beat_offset_sec = round(phase_sec % beat_period, 3)

        log_step(
            job_id,
            "BPM",
            f"Tempo & sinkronisasi drum: {bpm_int} BPM (offset ketukan {beat_offset_sec:.2f}s)",
            progress=progress,
        )
        return bpm_int, beat_offset_sec
    except Exception as exc:
        log_step(
            job_id,
            "BPM",
            f"Gagal deteksi BPM/sinkron otomatis ({exc}), default {fallback_bpm} BPM / 0.00s",
            progress=progress,
        )
        return fallback_bpm, 0.0


def format_srt_time(seconds: float) -> str:
    millis = int(round(seconds * 1000))
    hours = millis // 3_600_000
    millis %= 3_600_000
    minutes = millis // 60_000
    millis %= 60_000
    secs = millis // 1000
    ms = millis % 1000
    return f"{hours:02}:{minutes:02}:{secs:02},{ms:03}"


def execute_job(job_id: str, input_path: Path, is_video: bool, job_dir: Path, output_mode: str = "auto"):
    total_start = time.perf_counter()
    try:
        treat_as_video = is_video and (output_mode != "audio")

        wav_path = job_dir / "source.wav"
        run_cmd_with_log(
            job_id,
            "1/4 EXTRACT",
            ["ffmpeg", "-i", str(input_path), "-vn", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2", str(wav_path), "-y"],
            "ekstraksi audio WAV",
            start_pct=15,
            end_pct=22,
        )

        demucs_out = job_dir / "demucs_out"
        run_cmd_with_log(
            job_id,
            "2/4 DEMUCS",
            ["demucs", "-n", "htdemucs", "--two-stems=vocals", str(wav_path), "-o", str(demucs_out)],
            "pemisahan vokal Demucs",
            start_pct=22,
            end_pct=68 if treat_as_video else 88,
        )

        vocal_wav = demucs_out / "htdemucs" / "source" / "vocals.wav"
        no_vocal_wav = demucs_out / "htdemucs" / "source" / "no_vocals.wav"

        if not treat_as_video:
            out_mp3 = job_dir / "instrumental.mp3"
            run_cmd_with_log(
                job_id,
                "3/3 EXPORT",
                ["ffmpeg", "-i", str(no_vocal_wav), "-codec:a", "libmp3lame", "-q:a", "2", str(out_mp3), "-y"],
                "encode MP3 instrumental",
                start_pct=88,
                end_pct=99,
            )
            total_s = time.perf_counter() - total_start
            log_step(job_id, "DONE", f"Semua selesai dalam {total_s:.1f}s", progress=100)
            jobs[job_id]["status"] = "completed"
            jobs[job_id]["result"] = {
                "job_id": job_id,
                "type": "audio",
                "download_file": "instrumental.mp3",
            }
            return

        t_wh = time.perf_counter()
        log_step(job_id, "3/4 WHISPER", "Mulai transkripsi subtitle dari trek vokal...", progress=70)
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
            progress=85,
        )

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
            start_pct=85,
            end_pct=99,
        )

        total_s = time.perf_counter() - total_start
        log_step(job_id, "DONE", f"Semua selesai dalam {total_s:.1f}s", progress=100)
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
            "1/3 EXTRACT",
            ["ffmpeg", "-i", str(input_path), "-vn", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2", str(wav_path), "-y"],
            "konversi/ekstraksi audio WAV untuk mixer",
            start_pct=15,
            end_pct=22,
        )

        initial_bpm, initial_offset = analyze_bpm_and_beat_offset(
            wav_path, job_id, progress=25, fallback_bpm=120
        )
        jobs[job_id]["detected_bpm"] = initial_bpm
        jobs[job_id]["beat_offset_sec"] = initial_offset

        demucs_out = job_dir / "demucs_out"
        run_cmd_with_log(
            job_id,
            "2/3 DEMUCS_6S",
            ["demucs", "-n", "htdemucs_6s", str(wav_path), "-o", str(demucs_out)],
            "pemisahan 6 stem (drums, bass, guitar, piano, other, vocals)",
            start_pct=25,
            end_pct=92,
        )

        stem_dir = demucs_out / "htdemucs_6s" / "source"
        available_stems = [s for s in STEMS_6S if (stem_dir / f"{s}.wav").exists()]

        drums_wav = stem_dir / "drums.wav"
        if drums_wav.exists():
            drum_bpm, drum_offset = analyze_bpm_and_beat_offset(
                drums_wav, job_id, progress=96, fallback_bpm=initial_bpm
            )
            jobs[job_id]["detected_bpm"] = drum_bpm
            jobs[job_id]["beat_offset_sec"] = drum_offset

        final_bpm = jobs[job_id].get("detected_bpm", 120)
        final_offset = jobs[job_id].get("beat_offset_sec", 0.0)
        library_entry = {
            "job_id": job_id,
            "title": jobs[job_id].get("source_label") or f"Track {job_id[:8]}",
            "stems": available_stems,
            "detected_bpm": final_bpm,
            "beat_offset_sec": final_offset,
            "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        }

        try:
            save_stem_to_library(library_entry)
            log_step(job_id, "LIBRARY", "Berhasil menyimpan ke Library Lagu Terpisah.", progress=98)
        except Exception as lib_exc:
            log_step(job_id, "LIBRARY", f"Gagal menyimpan ke library ({lib_exc}), tetap lanjutkan ke mixer.", progress=98)

        total_s = time.perf_counter() - total_start
        log_step(job_id, "DONE", f"Pemisahan stem selesai dalam {total_s:.1f}s", progress=100)
        jobs[job_id]["stems"] = available_stems
        jobs[job_id]["status"] = "completed"
    except Exception as exc:
        log_step(job_id, "ERROR", str(exc))
        jobs[job_id]["status"] = "failed"
        jobs[job_id]["error"] = str(exc)


def run_process_wrapper(
    job_id: str,
    job_dir: Path,
    uploaded_path: Optional[Path],
    is_video: bool,
    youtube_url: Optional[str],
    output_mode: str,
):
    try:
        if youtube_url and youtube_url.strip():
            prefer_audio = output_mode == "audio"
            source_path, yt_is_video = download_from_youtube(job_id, youtube_url.strip(), job_dir, prefer_audio)
            execute_job(job_id, source_path, yt_is_video, job_dir, output_mode=output_mode)
        elif uploaded_path:
            execute_job(job_id, uploaded_path, is_video, job_dir, output_mode=output_mode)
        else:
            raise RuntimeError("Pilih file atau masukkan link YouTube terlebih dahulu.")
    except Exception as exc:
        log_step(job_id, "ERROR", str(exc))
        jobs[job_id]["status"] = "failed"
        jobs[job_id]["error"] = str(exc)


def run_stem_wrapper(
    job_id: str,
    job_dir: Path,
    uploaded_path: Optional[Path],
    youtube_url: Optional[str],
):
    try:
        if youtube_url and youtube_url.strip():
            source_path, _ = download_from_youtube(job_id, youtube_url.strip(), job_dir, prefer_audio_only=True)
            execute_stem_job(job_id, source_path, job_dir)
        elif uploaded_path:
            execute_stem_job(job_id, uploaded_path, job_dir)
        else:
            raise RuntimeError("Pilih file atau masukkan link YouTube terlebih dahulu.")
    except Exception as exc:
        log_step(job_id, "ERROR", str(exc))
        jobs[job_id]["status"] = "failed"
        jobs[job_id]["error"] = str(exc)


@app.post("/process")
async def process_media(
    background_tasks: BackgroundTasks,
    file: Optional[UploadFile] = File(default=None),
    youtube_url: Optional[str] = Form(default=None),
    output_mode: str = Form(default="auto"),
):
    job_id = str(uuid.uuid4())
    job_dir = BASE_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    uploaded_path: Optional[Path] = None
    is_video = False

    if file and file.filename:
        ext = Path(file.filename).suffix.lower()
        video_exts = {".mp4", ".mkv", ".mov", ".webm"}
        audio_exts = {".mp3", ".wav", ".m4a", ".flac", ".ogg"}
        if ext not in video_exts | audio_exts:
            raise HTTPException(status_code=400, detail="Format file tidak didukung.")
        is_video = ext in video_exts
        uploaded_path = job_dir / f"input{ext}"
        with open(uploaded_path, "wb") as f:
            shutil.copyfileobj(file.file, f)
    elif not (youtube_url and youtube_url.strip()):
        raise HTTPException(status_code=400, detail="Wajib mengunggah file atau mengisi link YouTube.")

    jobs[job_id] = {
        "status": "processing",
        "step": "QUEUED",
        "progress": 1,
        "message": "File/link diterima, menyiapkan proses...",
        "logs": [],
        "stems": [],
        "detected_bpm": 120,
        "beat_offset_sec": 0.0,
        "result": None,
        "error": None,
    }
    log_step(job_id, "UPLOAD", f"Job masuk antrean (mode output: {output_mode}).", progress=2)

    background_tasks.add_task(
        run_process_wrapper,
        job_id,
        job_dir,
        uploaded_path,
        is_video,
        youtube_url,
        output_mode,
    )
    return {"job_id": job_id}


@app.post("/separate-stems")
async def separate_stems(
    background_tasks: BackgroundTasks,
    file: Optional[UploadFile] = File(default=None),
    youtube_url: Optional[str] = Form(default=None),
):
    job_id = str(uuid.uuid4())
    job_dir = BASE_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    uploaded_path: Optional[Path] = None
    source_label = f"Track {job_id[:8]}"

    if file and file.filename:
        ext = Path(file.filename).suffix.lower()
        allowed = {".mp3", ".wav", ".m4a", ".flac", ".ogg", ".mp4", ".mkv", ".mov", ".webm"}
        if ext not in allowed:
            raise HTTPException(status_code=400, detail="Format file tidak didukung.")
        source_label = file.filename
        uploaded_path = job_dir / f"input{ext}"
        with open(uploaded_path, "wb") as f:
            shutil.copyfileobj(file.file, f)
    elif youtube_url and youtube_url.strip():
        source_label = youtube_url.strip()
    else:
        raise HTTPException(status_code=400, detail="Wajib mengunggah file atau mengisi link YouTube.")

    jobs[job_id] = {
        "status": "processing",
        "step": "QUEUED",
        "progress": 1,
        "message": "Menyiapkan pemisahan 6 stem...",
        "logs": [],
        "stems": [],
        "source_label": source_label,
        "detected_bpm": 120,
        "beat_offset_sec": 0.0,
        "result": None,
        "error": None,
    }
    log_step(job_id, "UPLOAD", "Job pemisahan stem masuk antrean.", progress=2)
    background_tasks.add_task(run_stem_wrapper, job_id, job_dir, uploaded_path, youtube_url)
    return {"job_id": job_id}


@app.get("/stem-library")
def get_stem_library():
    return {"items": load_stem_library()}


@app.patch("/stem-library/{job_id}")
def update_stem_library_item(job_id: str, payload: LibraryUpdateRequest):
    safe_id = os.path.basename(job_id)
    cleaned_title: Optional[str] = None
    if payload.title is not None:
        cleaned_title = payload.title.strip()
        if not cleaned_title:
            raise HTTPException(status_code=400, detail="Nama label tidak boleh kosong.")
    updated = update_stem_in_library(
        safe_id,
        new_title=cleaned_title,
        beat_offset_sec=payload.beat_offset_sec,
        detected_bpm=payload.detected_bpm,
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Item library tidak ditemukan.")
    return {"updated": True, "item": updated}


@app.delete("/stem-library/{job_id}")
def delete_stem_library_item(job_id: str):
    safe_id = os.path.basename(job_id)
    removed = remove_stem_from_library(safe_id)
    job_dir = BASE_DIR / safe_id
    if job_dir.exists():
        shutil.rmtree(job_dir, ignore_errors=True)
    if not removed and not job_dir.exists():
        raise HTTPException(status_code=404, detail="Item library tidak ditemukan.")
    return {"deleted": True, "job_id": safe_id}


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