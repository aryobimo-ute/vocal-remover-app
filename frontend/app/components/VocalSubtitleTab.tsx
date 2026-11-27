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
  message: string;
  logs: string[];
  result: ProcessResult | null;
  error: string | null;
};

export default function VocalSubtitleTab({ apiUrl }: { apiUrl: string }) {
  const [file, setFile] = useState<File | null>(null);
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
    }, 2000);

    return () => clearInterval(interval);
  }, [jobId, apiUrl]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;

    setLoading(true);
    setError(null);
    setStatusData(null);
    setJobId(null);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch(`${apiUrl}/process`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || "Gagal mengunggah file.");
      }

      const data: { job_id: string } = await res.json();
      setJobId(data.job_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Terjadi kesalahan.");
      setLoading(false);
    }
  }

  const result = statusData?.status === "completed" ? statusData.result : null;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">
          Vocal Remover &amp; Auto Subtitle
        </h2>
        <p className="text-sm text-zinc-400 mt-1">
          Pantau tahap proses secara langsung dari ekstraksi audio, pemisahan
          vokal, transkripsi subtitle, hingga render akhir.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <input
          type="file"
          accept="audio/*,video/*"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm text-zinc-300 file:mr-4 file:rounded-lg file:border-0 file:bg-zinc-800 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-zinc-700"
        />

        <button
          type="submit"
          disabled={!file || loading}
          className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {loading
            ? `Memproses (${statusData?.step || "STARTING"})...`
            : "Proses File"}
        </button>
      </form>

      {statusData && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-mono font-semibold text-emerald-400">
              STEP: {statusData.step}
            </span>
            <span className="text-zinc-400 uppercase">{statusData.status}</span>
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
              Unduh {result.download_file}
            </a>
            {result.subtitle_file && (
              <a
                href={`${apiUrl}/download/${result.job_id}/${result.subtitle_file}`}
                download
                className="rounded-lg border border-zinc-700 px-3.5 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-800"
              >
                Unduh {result.subtitle_file}
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
