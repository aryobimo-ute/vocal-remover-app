"use client";

import { useEffect, useState } from "react";
import StemMixer from "./StemMixer";

type StemName = "drums" | "bass" | "guitar" | "piano" | "other" | "vocals";

type StemJobStatus = {
  status: "processing" | "completed" | "failed";
  step: string;
  message: string;
  logs: string[];
  stems: StemName[];
  error: string | null;
};

export default function StemMixerTab({ apiUrl }: { apiUrl: string }) {
  const [file, setFile] = useState<File | null>(null);
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
    }, 2000);
    return () => clearInterval(timer);
  }, [jobId, apiUrl]);

  async function handleSeparate(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setLoading(true);
    setJobData(null);
    setJobId(null);

    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(`${apiUrl}/separate-stems`, {
      method: "POST",
      body: formData,
    });
    const data: { job_id: string } = await res.json();
    setJobId(data.job_id);
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">
          Stem Separator &amp; Live Mixer
        </h2>
        <p className="text-sm text-zinc-400 mt-1">
          Pisahkan drum, bass, gitar, keyboard/piano, vokal, dan instrumen lain,
          lalu atur volume, panning, dan metronome secara langsung.
        </p>
      </div>

      <form
        onSubmit={handleSeparate}
        className="flex flex-wrap gap-3 items-center"
      >
        <input
          type="file"
          accept="audio/*,video/mp4"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="text-sm text-zinc-300 file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-800 file:px-4 file:py-2 file:text-white"
        />
        <button
          type="submit"
          disabled={!file || loading}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {loading
            ? `Memproses (${jobData?.step || "STARTING"})...`
            : "Pisahkan Instrumen"}
        </button>
      </form>

      {jobData && (
        <pre className="max-h-36 overflow-y-auto rounded-lg bg-black/60 p-3 text-xs font-mono text-zinc-300">
          {jobData.logs.join("\n")}
        </pre>
      )}

      {jobData?.status === "completed" && jobId && jobData.stems.length > 0 && (
        <StemMixer apiUrl={apiUrl} jobId={jobId} stems={jobData.stems} />
      )}
    </div>
  );
}
