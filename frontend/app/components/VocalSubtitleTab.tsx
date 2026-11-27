"use client";

import { useEffect, useState } from "react";

type ProcessResult = {
  job_id: string;
  type: "audio" | "video";
  download_file: string;
  subtitle_file?: string;
};

type JobStatusResponse = {
  status: "processing" | "completed" | "failed";
  step: string;
  progress?: number;
  message: string;
  logs: string[];
  result: ProcessResult | null;
  error: string | null;
};

export default function VocalSubtitleTab({ apiUrl }: { apiUrl: string }) {
  const [sourceType, setSourceType] = useState<"file" | "youtube">("file");
  const [file, setFile] = useState<File | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [outputMode, setOutputMode] = useState<"video" | "audio">("video");

  const [jobId, setJobId] = useState<string | null>(null);
  const [statusData, setStatusData] = useState<JobStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${apiUrl}/status/${jobId}`);
        if (!res.ok) return;
        const data: JobStatusResponse = await res.json();
        setStatusData(data);

        if (data.status === "completed" || data.status === "failed") {
          clearInterval(interval);
          setLoading(false);
          if (data.status === "failed") {
            setError(data.error || "Proses gagal.");
          }
        }
      } catch {
        // Abaikan error sesaat saat polling
      }
    }, 1500);

    return () => clearInterval(interval);
  }, [jobId, apiUrl]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (sourceType === "file" && !file) return;
    if (sourceType === "youtube" && !youtubeUrl.trim()) return;

    setLoading(true);
    setError(null);
    setStatusData(null);
    setJobId(null);

    try {
      const formData = new FormData();
      if (sourceType === "file" && file) {
        formData.append("file", file);
        formData.append("output_mode", "auto");
      } else {
        formData.append("youtube_url", youtubeUrl.trim());
        formData.append("output_mode", outputMode);
      }

      const res = await fetch(`${apiUrl}/process`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || "Gagal mengunggah/memproses.");
      }

      const data: { job_id: string } = await res.json();
      setJobId(data.job_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Terjadi kesalahan.");
      setLoading(false);
    }
  }

  const result = statusData?.status === "completed" ? statusData.result : null;
  const pct = statusData?.progress ?? (loading ? 1 : 0);
  const canSubmit =
    !loading &&
    ((sourceType === "file" && Boolean(file)) ||
      (sourceType === "youtube" && Boolean(youtubeUrl.trim())));

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">
          Vocal Remover &amp; Auto Subtitle
        </h2>
        <p className="text-sm text-zinc-400 mt-1">
          Pilih file lokal atau masukkan link YouTube untuk menghapus vokal dan
          menambahkan subtitle otomatis.
        </p>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setSourceType("file")}
          className={`rounded-lg px-3 py-1.5 text-xs font-medium border ${
            sourceType === "file"
              ? "bg-zinc-100 text-zinc-950 border-zinc-100"
              : "bg-zinc-950 text-zinc-300 border-zinc-700 hover:bg-zinc-800"
          }`}
        >
          Choose File
        </button>
        <button
          type="button"
          onClick={() => setSourceType("youtube")}
          className={`rounded-lg px-3 py-1.5 text-xs font-medium border ${
            sourceType === "youtube"
              ? "bg-zinc-100 text-zinc-950 border-zinc-100"
              : "bg-zinc-950 text-zinc-300 border-zinc-700 hover:bg-zinc-800"
          }`}
        >
          Link YouTube
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {sourceType === "file" ? (
          <input
            key="vocal-file-input"
            type="file"
            accept="audio/*,video/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-zinc-300 file:mr-4 file:rounded-lg file:border-0 file:bg-zinc-800 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-zinc-700"
          />
        ) : (
          <div className="space-y-3">
            <input
              key="vocal-youtube-input"
              type="url"
              placeholder="https://www.youtube.com/watch?v=..."
              value={youtubeUrl}
              onChange={(e) => setYoutubeUrl(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3.5 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
            />

            <div className="space-y-1.5">
              <span className="block text-xs text-zinc-400">
                Pilihan hasil untuk link YouTube video:
              </span>
              <div className="flex flex-wrap gap-3 text-xs">
                <label className="inline-flex items-center gap-2 cursor-pointer rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2">
                  <input
                    type="radio"
                    name="ytOutputMode"
                    value="video"
                    checked={outputMode === "video"}
                    onChange={() => setOutputMode("video")}
                    className="accent-emerald-500"
                  />
                  <span>Tetap Video (No Vocal + Subtitle .mp4)</span>
                </label>
                <label className="inline-flex items-center gap-2 cursor-pointer rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2">
                  <input
                    type="radio"
                    name="ytOutputMode"
                    value="audio"
                    checked={outputMode === "audio"}
                    onChange={() => setOutputMode("audio")}
                    className="accent-emerald-500"
                  />
                  <span>Ke Musik / Audio Saja (.mp3)</span>
                </label>
              </div>
            </div>
          </div>
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {loading
            ? `Memproses ${pct}% (${statusData?.step || "STARTING"})...`
            : "Proses & Siapkan Download"}
        </button>
      </form>

      {statusData && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 space-y-2.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-mono font-semibold text-emerald-400">
              STEP: {statusData.step}
            </span>
            <span className="font-mono font-semibold text-zinc-200">
              {pct}% ({statusData.status.toUpperCase()})
            </span>
          </div>

          <div className="w-full h-2.5 rounded-full bg-zinc-800 overflow-hidden">
            <div
              className="h-full bg-emerald-500 transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>

          <p className="text-sm text-zinc-200">{statusData.message}</p>
          <pre className="mt-2 max-h-48 overflow-y-auto rounded-lg bg-black/60 p-3 text-xs font-mono text-zinc-300 whitespace-pre-wrap">
            {statusData.logs.join("\n")}
          </pre>
        </div>
      )}

      {error && (
        <p className="rounded-lg bg-red-950/60 border border-red-800 p-3 text-sm text-red-300">
          {error}
        </p>
      )}

      {result && (
        <div className="rounded-xl border border-emerald-800/60 bg-emerald-950/30 p-4 space-y-2">
          <p className="text-sm font-medium text-emerald-300">
            Selesai diproses!
          </p>
          <div className="flex flex-wrap gap-3 pt-1">
            <a
              href={`${apiUrl}/download/${result.job_id}/${result.download_file}`}
              download
              className="rounded-lg bg-zinc-100 px-3.5 py-2 text-xs font-semibold text-zinc-900 hover:bg-white"
            >
              Download {result.download_file}
            </a>
            {result.subtitle_file && (
              <a
                href={`${apiUrl}/download/${result.job_id}/${result.subtitle_file}`}
                download
                className="rounded-lg border border-zinc-700 px-3.5 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-800"
              >
                Download {result.subtitle_file}
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
