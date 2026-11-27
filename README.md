# Vocal Remover, Subtitle & Stem Mixer

Aplikasi web lokal untuk:

1. **Hapus Vokal & Subtitle:** Menghapus vokal dari file lokal maupun link YouTube menggunakan Demucs (`htdemucs`), membuat _subtitle_ `.srt` dari trek vokal menggunakan Faster-Whisper, dan menggabungkan _hardsub_ + audio instrumental dengan FFmpeg (atau memilih hasil audio `.mp3` saja).
2. **Pisah Instrumen & Mixer:** Memisahkan 6 _stem_ (`drums`, `bass`, `guitar`, `piano`, `other`, `vocals`) menggunakan `htdemucs_6s` dari file lokal maupun link YouTube (video otomatis dikonversi ke audio), mendeteksi tempo (BPM) secara otomatis dengan `librosa`, memutarnya secara _real-time_ di _browser_ dengan kontrol volume, _panning_ kiri/kanan, _solo_, _mute_, _metronome_ (auto BPM / manual, _tap BPM_, _beat grid sync_, volume, _panning_), timeline & kecepatan putar, serta _export_ hasil _mix_ ke `.wav`.

---

## Prasyarat Sistem (Wajib Diinstal Sebelum Menjalankan)

1. **Git**
2. **Python 3.10–3.12** (`python --version`)
3. **Node.js (LTS, v18/v20+)** & **npm** (`node -v`)
4. **FFmpeg** tersedia di `PATH` sistem (`ffmpeg -version`):
   - **Windows (PowerShell):** `winget install Gyan.FFmpeg`
   - **macOS (Homebrew):** `brew install ffmpeg`
   - **Linux (Ubuntu/Debian):** `sudo apt update && sudo apt install -y ffmpeg`
5. _(Opsional untuk akselerasi GPU NVIDIA)_ **Driver NVIDIA** terpasang dan terbaca lewat `nvidia-smi`.

---

## Cara Menjalankan (Pertama Kali Setelah Clone / Pull dari GitHub)

### 1. Clone / Pull Repository

Jika baru pertama kali mengambil proyek:

```bash
git clone <URL_REPOSITORY_KAMU>
cd vocal-remover-app
```

Jika repository sudah ada di lokal dan baru melakukan _pull_ pembaruan:

```bash
git pull origin main
```

### 2. Setup & Jalankan Backend (FastAPI + Demucs + Whisper + yt-dlp + Librosa)

Buka terminal, masuk ke folder `backend`, lalu buat dan aktifkan _virtual environment_:

```bash
cd backend
python -m venv .venv
```

Aktifkan `.venv`:

- **Windows (PowerShell):**
  ```powershell
  .\.venv\Scripts\Activate.ps1
  ```
- **Git Bash (Windows):**
  ```bash
  source .venv/Scripts/activate
  ```
- **macOS / Linux:**
  ```bash
  source .venv/bin/activate
  ```

#### Pilih Salah Satu Cara Instalasi Dependencies Python Sesuai Perangkat:

- **Opsi A — PC / Laptop CPU saja atau perangkat non-NVIDIA:**

  ```bash
  pip install --upgrade pip
  pip install fastapi uvicorn python-multipart demucs faster-whisper yt-dlp librosa
  ```

- **Opsi B — PC dengan GPU NVIDIA (Akselerasi CUDA):**
  Cek dulu versi CUDA pada output `nvidia-smi`, lalu pasang PyTorch dengan _index URL_ CUDA yang sesuai (contoh di bawah menggunakan `cu124`; sesuaikan jika perlu):
  ```bash
  pip install --upgrade pip
  pip uninstall -y torch torchaudio torchvision
  pip install torch torchaudio --index-url [https://download.pytorch.org/whl/cu124](https://download.pytorch.org/whl/cu124)
  pip install fastapi uvicorn python-multipart demucs faster-whisper yt-dlp librosa
  ```
  Verifikasi bahwa GPU terbaca oleh PyTorch:
  ```bash
  python -c "import torch; print('CUDA available:', torch.cuda.is_available(), '| GPU:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU')"
  ```
  _(Pastikan juga konfigurasi `WhisperModel` di `backend/main.py` menggunakan `device="cuda"` dan `compute_type="float16"` saat `torch.cuda.is_available()` bernilai `True`.)_

Jalankan _server_ backend:

```bash
uvicorn main:app --reload --port 8000
```

> **Catatan:**
>
> - Saat pertama kali memproses file, Demucs (`htdemucs` / `htdemucs_6s`) dan Faster-Whisper akan mengunduh bobot model AI ke _cache_ lokal. Proses ini membutuhkan internet di awal saja; setelah terunduh, pemrosesan file lokal dapat berjalan secara _offline_.
> - Koneksi internet diperlukan jika menggunakan fitur input dari **Link YouTube** (`yt-dlp`).

### 3. Setup & Jalankan Frontend (Next.js)

Buka terminal baru, masuk ke folder `frontend`, instal _package_, lalu jalankan _dev server_:

```bash
cd frontend
npm install
npm run dev
```

Buka aplikasi di _browser_ pada alamat:

- **Frontend:** `http://localhost:3000`
- **Backend API Docs:** `http://localhost:8000/docs`

---

## Struktur Folder

```text
vocal-remover-app/
├── .gitignore
├── README.md
├── AI_CONTEXT_GUIDE.md
├── backend/
│   └── main.py
└── frontend/
    ├── package.json
    └── app/
        ├── layout.tsx
        ├── page.tsx
        └── components/
            ├── VocalSubtitleTab.tsx
            ├── StemMixerTab.tsx
            └── StemMixer.tsx
```

---

## Troubleshooting Singkat

- **Perintah `ffmpeg` tidak dikenali:** Pastikan FFmpeg sudah terpasang dan terminal dibuka ulang setelah instalasi.
- **GPU NVIDIA tidak terpakai (`CUDA available: False`):** Pastikan driver NVIDIA terpasang (`nvidia-smi` berhasil), PyTorch terinstal versi CUDA (bukan _wheel_ CPU saja), dan `WhisperModel` di `backend/main.py` diarahkan ke `"cuda"` saat GPU tersedia.
- **VRAM GPU penuh / Out of Memory:** Gunakan model Whisper yang lebih ringan (misalnya `"small"` atau `"base"`) atau tutup aplikasi berat lain saat memproses file berdurasi panjang.
- **Unduh link YouTube gagal:** Perbarui `yt-dlp` ke versi terbaru dengan `pip install -U yt-dlp`.
- **Proses terasa lambat:** Pemrosesan di CPU memakan waktu lebih lama dibanding GPU NVIDIA (CUDA). Kamu bisa mengganti model Whisper ke `"base"` atau `"tiny"` di `backend/main.py` untuk mempercepat transkripsi.
- **Port 3000 atau 8000 sudah dipakai:** Jalankan Next.js dengan `npm run dev -- -p 3001` atau FastAPI dengan `--port 8001` (sesuaikan `API_URL` di `frontend/app/page.tsx` jika mengubah _port_ backend).
