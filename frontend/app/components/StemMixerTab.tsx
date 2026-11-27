"use client";

import { useEffect, useState } from "react";
import StemMixer from "./StemMixer";

type StemName = "drums" | "bass" | "guitar" | "piano" | "other" | "vocals";

type StemJobStatus = {
  status: "processing" | "completed" | "failed";
  step: string;
  progress?: number;
  message: string;
  logs: string[];
  stems: StemName[];
  detected_bpm?: number;
  error: string | null;
};

export default function StemMixerTab({ apiUrl }: { apiUrl: string }) {
  const [sourceType, setSourceType] = useState<"file" | "youtube">("file");
  const [file, setFile] = useState<File | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState("");

  const [jobId, setJobId] = useState<string | null>(null);
  const [jobData, setJobData] = useState<StemJobStatus | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!jobId) return;
    const timer = setInterval(async () => {
      const res = await fetch(`${apiUrl}/status/${jobId}`);
      if (!res.ok) return;
      const data: StemJobStatus = await res.json();
      setJobData(data);
      if (data.status === "completed" || data.status === "failed") {
        clearInterval(timer);
        setLoading(false);
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [jobId, apiUrl]);

  async function handleSeparate(e: React.FormEvent) {
    e.preventDefault();
    if (sourceType === "file" && !file) return;
    if (sourceType === "youtube" && !youtubeUrl.trim()) return;

    setLoading(true);
    setJobData(null);
    setJobId(null);

    const formData = new FormData();
    if (sourceType === "file" && file) {
      formData.append("file", file);
    } else {
      formData.append("youtube_url", youtubeUrl.trim());
    }

    const res = await fetch(`${apiUrl}/separate-stems`, {
      method: "POST",
      body: formData,
    });
    const data: { job_id: string } = await res.json();
    setJobId(data.job_id);
  }

  const pct = jobData?.progress ?? (loading ? 1 : 0);
  const canSubmit =
    !loading &&
    ((sourceType === "file" && Boolean(file)) ||
      (sourceType === "youtube" && Boolean(youtubeUrl.trim())));

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">
          Stem Separator &amp; Live Mixer
        </h2>
        <p className="text-sm text-zinc-400 mt-1">
          Pilih file atau link YouTube (video otomatis dikonversi ke musik),
          pisahkan instrumen, deteksi BPM otomatis, lalu atur mixer &amp;
          metronome.
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
          Link YouTube (Auto ke Musik)
        </button>
      </div>

      <form
        onSubmit={handleSeparate}
        className="flex flex-wrap gap-3 items-center"
      >
        {sourceType === "file" ? (
          <input
            key="stem-file-input"
            type="file"
            accept="audio/*,video/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-sm text-zinc-300 file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-800 file:px-4 file:py-2 file:text-white"
          />
        ) : (
          <input
            key="stem-youtube-input"
            type="url"
            placeholder="https://www.youtube.com/watch?v=..."
            value={youtubeUrl}
            onChange={(e) => setYoutubeUrl(e.target.value)}
            className="flex-1 min-w-[240px] rounded-lg border border-zinc-700 bg-zinc-950 px-3.5 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
          />
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {loading
            ? `Memproses ${pct}% (${jobData?.step || "STARTING"})...`
            : "Pisahkan Instrumen"}
        </button>
      </form>

      {jobData && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 space-y-2.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-mono font-semibold text-emerald-400">
              STEP: {jobData.step}
            </span>
            <span className="font-mono font-semibold text-zinc-200">
              {pct}% ({jobData.status.toUpperCase()})
            </span>
          </div>

          <div className="w-full h-2.5 rounded-full bg-zinc-800 overflow-hidden">
            <div
              className="h-full bg-emerald-500 transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>

          <p className="text-sm text-zinc-200">{jobData.message}</p>
          <pre className="max-h-36 overflow-y-auto rounded-lg bg-black/60 p-3 text-xs font-mono text-zinc-300 whitespace-pre-wrap">
            {jobData.logs.join("\n")}
          </pre>
        </div>
      )}

      {jobData?.status === "completed" && jobId && jobData.stems.length > 0 && (
        <StemMixer
          key={`${jobId}-${jobData.detected_bpm ?? 120}`}
          apiUrl={apiUrl}
          jobId={jobId}
          stems={jobData.stems}
          initialBpm={jobData.detected_bpm ?? 120}
        />
      )}
    </div>
  );
}
