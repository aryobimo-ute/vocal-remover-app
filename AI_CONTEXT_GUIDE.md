# Panduan Konteks Proyek & Instruksi AI — Vocal Remover, Subtitle & Stem Mixer

Dokumen ini menjadi acuan konteks utama bagi asisten AI maupun pengembang saat melanjutkan, memperbaiki, atau menambah fitur pada proyek **Vocal Remover, Subtitle & Stem Mixer**.

---

## 1. Gambaran Umum Aplikasi

Aplikasi web lokal berbasis **FastAPI (Python)** dan **Next.js (TypeScript / Tailwind CSS)** untuk pemrosesan audio/video serta latihan/mixing musik secara lokal:

1. **Tab 1 — Hapus Vokal & Subtitle (`VocalSubtitleTab.tsx`):**
   - Mendukung dua sumber input: **Choose File** (audio/video lokal) dan **Link YouTube** (`yt-dlp`).
   - Jika input berasal dari **Link YouTube** berupa video, tersedia pilihan hasil akhir: **Tetap Video** (hapus vokal + transkripsi subtitle `.srt` + _hardsub_ + _muxing_ ke `.mp4`) atau **Ke Musik / Audio Saja** (hapus vokal menjadi `.mp3`).
   - Pemisahan vokal memakai **Demucs** (`htdemucs`, `--two-stems=vocals`), transkripsi memakai **Faster-Whisper** dari trek vokal terpisah, dan pengolahan media memakai **FFmpeg**.
   - Dilengkapi log progres real-time, persentase (`progress` `0–100%`), dan tombol unduh hasil.

2. **Tab 2 — Pisah Instrumen & Mixer (`StemMixerTab.tsx` & `StemMixer.tsx`):**
   - Mendukung **Choose File** dan **Link YouTube** (video otomatis diarahkan ke audio/musik untuk diproses).
   - Memisahkan audio menjadi **6 stem** menggunakan **Demucs** (`htdemucs_6s`): `drums`, `bass`, `guitar`, `piano`, `other`, dan `vocals`.
   - **Library Lagu Terpisah:** Hasil pemisahan 6 _stem_ disimpan di `backend/work/<job_id>/demucs_out/htdemucs_6s/source/` dan metadatanya dicatat ke `backend/work/stem_library.json` (via `/stem-library` & `DELETE /stem-library/{job_id}`), sehingga lagu yang sudah dipisah dapat dibuka kembali di _mixer_ tanpa proses _extract_ atau pisah _stem_ ulang (serta aman saat _refresh_ atau pindah tab).
   - Mendeteksi BPM lagu secara otomatis menggunakan `librosa` (`detected_bpm`) sebagai nilai awal _metronome_.
   - **Real-Time Web Audio Mixer:**
     - Pemutaran _play / pause / stop_, **timeline** (_seek_ ke menit/detik tertentu + tombol loncat cepat), dan **kecepatan putar** (`playbackRate`, misal `0.5x`–`2x`).
     - **Master Volume khusus 6 stem** yang terpisah dari _metronome_ (menggeser master 6 stem membesarkan/mengecilkan seluruh 6 instrumen/vokal tanpa mengubah volume _metronome_).
     - Kontrol tiap _stem_: **Volume**, **Panning (Kiri/Kanan)**, **Solo (`S`)**, dan **Mute (`M`)**.
     - **Metronome** terpisah: _toggle_ aktif/nonaktif, **BPM** (auto/manual), **Tap BPM**, **Pas Beat di Posisi Ini** + **Geser Ketukan (Beat Grid)** untuk menyelaraskan fase ketukan dengan lagu/drum, **Volume Metronome**, dan **Panning Metronome**.
     - Tombol **Reset BPM** dan **Reset Semua** untuk mengembalikan kontrol ke kondisi awal.
     - Tombol **Download Hasil Mix (.wav)** yang me-render _mix_ aktif + _metronome_ (jika aktif) menggunakan `OfflineAudioContext`.

---

## 2. Struktur Folder & Tanggung Jawab File

```text
vocal-remover-app/
├── .gitignore
├── README.md
├── AI_CONTEXT_GUIDE.md
├── backend/
│   ├── .venv/                   # Diabaikan di Git
│   ├── work/                    # File sementara job, output & stem_library.json (diabaikan di Git)
│   └── main.py                  # FastAPI endpoints, yt-dlp, ffmpeg, demucs, faster-whisper, librosa, stem_library.json
└── frontend/
    ├── node_modules/            # Diabaikan di Git
    ├── .next/                   # Diabaikan di Git
    ├── package.json
    └── app/
        ├── layout.tsx           # Root layout (sertakan suppressHydrationWarning bila perlu ekstensi browser)
        ├── page.tsx             # Wadah navigasi 2 tab (Tab 1: Hapus Vokal & Subtitle | Tab 2: Pisah Instrumen & Mixer)
        └── components/
            ├── VocalSubtitleTab.tsx
            ├── StemMixerTab.tsx
            └── StemMixer.tsx
```

---

## 3. Aturan Penting Saat Mengubah atau Menambah Kode

1. **Jangan merusak fitur yang sudah berjalan:** Pertahankan pemisahan antara **Tab 1** dan **Tab 2**; jika menambah fitur baru, tambahkan secara modular tanpa menghapus fungsionalitas eksisting kecuali diminta eksplisit.
2. **Pemrosesan panjang harus asinkron (`BackgroundTasks` + polling status):** Jangan membuat _endpoint_ memblokir _request_ HTTP tanpa update status/log/persen.
3. **Jalur audio 6 Stem vs Metronome harus terpisah:** `masterStemsGain` hanya mengatur 6 _stem_ (`drums`, `bass`, `guitar`, `piano`, `other`, `vocals`), sedangkan _metronome_ memakai `metroGain` dan `metroPanner` sendiri.
4. **Pertahankan persistensi Library Stem:** Jangan menghapus penyimpanan `stem_library.json` atau _endpoint_ `/stem-library` saat mengubah alur `StemMixerTab.tsx` maupun `main.py`.
5. **Hindari _warning_ React/Next.js:**
   - Jangan memanggil `setState` secara sinkron di dalam `useEffect` (gunakan _key_ komponen jika perlu _re-init_ state awal dari _prop_).
   - Berikan `key` unik pada `<input type="file" />` vs `<input type="url" />` saat berpindah mode sumber input agar tidak memicu _uncontrolled to controlled_ warning.
6. **Jaga kebersihan repository Git:** Pastikan tidak ada `.git` bersarang (_nested git repo_ di dalam `frontend/`) dan pastikan `.venv`, `node_modules`, serta `backend/work/` tetap masuk `.gitignore`.

---

## 4. Template Prompt Saat Bertanya ke AI di Lain Hari

Salin dan sesuaikan template ini saat membuka sesi baru:

> "Saya melanjutkan proyek **Vocal Remover, Subtitle & Stem Mixer** (FastAPI + Demucs `htdemucs` & `htdemucs_6s` + Faster-Whisper + FFmpeg + `yt-dlp` + `librosa` + Library Stem `stem_library.json` di backend, dan Next.js TypeScript + Web Audio API di frontend).
>
> Aturan penting:
>
> - Jangan merusak fitur yang sudah ada (Tab 1: Hapus Vokal & Subtitle, Tab 2: Library Lagu Terpisah + Pisah Instrumen 6-Stem + Live Mixer + Timeline + Master 6-Stem terpisah dari Metronome + Auto/Tap/Beat-Sync BPM + Download WAV).
> - Berikan kode lengkap pada file yang diubah serta jelaskan dampak perubahannya.
>
> File terkait saat ini: `[sebutkan nama file, misal: StemMixer.tsx / main.py]`.
> Permintaan saya: `[jelaskan perbaikan atau fitur baru yang diinginkan]`."
