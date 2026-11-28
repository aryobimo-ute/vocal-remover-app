"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  beat_offset_sec?: number;
  error: string | null;
};

type LibraryItem = {
  job_id: string;
  title: string;
  stems: StemName[];
  detected_bpm: number;
  beat_offset_sec?: number;
  created_at: string;
};

type ActiveMixerTrack = {
  jobId: string;
  title: string;
  stems: StemName[];
  bpm: number;
  beatOffsetSec: number;
};

const ACTIVE_TRACK_STORAGE_KEY = "stem_mixer_active_track_v1";

function readInitialActiveTrack(): ActiveMixerTrack | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(ACTIVE_TRACK_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ActiveMixerTrack>;
    if (!parsed.jobId || !Array.isArray(parsed.stems)) return null;
    return {
      jobId: parsed.jobId,
      title: parsed.title || parsed.jobId.slice(0, 8),
      stems: parsed.stems,
      bpm: typeof parsed.bpm === "number" ? parsed.bpm : 120,
      beatOffsetSec:
        typeof parsed.beatOffsetSec === "number" ? parsed.beatOffsetSec : 0,
    };
  } catch {
    return null;
  }
}

export default function StemMixerTab({ apiUrl }: { apiUrl: string }) {
  const [sourceType, setSourceType] = useState<"file" | "youtube">("file");
  const [file, setFile] = useState<File | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState("");

  const [jobId, setJobId] = useState<string | null>(null);
  const [jobData, setJobData] = useState<StemJobStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [editingJobId, setEditingJobId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [savingTitleId, setSavingTitleId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null,
  );
  const [deletingJobId, setDeletingJobId] = useState<string | null>(null);

  const [activeTrack, setActiveTrack] = useState<ActiveMixerTrack | null>(
    readInitialActiveTrack,
  );
  const activeTrackRef = useRef<ActiveMixerTrack | null>(activeTrack);

  useEffect(() => {
    activeTrackRef.current = activeTrack;
  }, [activeTrack]);

  useEffect(() => {
    let active = true;
    fetch(`${apiUrl}/stem-library`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { items?: LibraryItem[] } | null) => {
        if (!active || !data || !Array.isArray(data.items)) return;
        const items = data.items;
        setLibrary(items);

        const currentActive = activeTrackRef.current;
        if (currentActive) {
          const match = items.find((x) => x.job_id === currentActive.jobId);
          if (match) {
            setActiveTrack({
              ...currentActive,
              title: match.title,
              stems: match.stems,
              bpm: match.detected_bpm ?? currentActive.bpm,
              beatOffsetSec:
                typeof match.beat_offset_sec === "number"
                  ? match.beat_offset_sec
                  : currentActive.beatOffsetSec,
            });
          }
        }
      })
      .catch(() => {
        // Abaikan error sesaat
      });

    return () => {
      active = false;
    };
  }, [apiUrl]);

  const handleRefreshLibrary = useCallback(async () => {
    setLoadingLibrary(true);
    try {
      const res = await fetch(`${apiUrl}/stem-library`);
      if (!res.ok) return;
      const data: { items?: LibraryItem[] } = await res.json();
      const items = Array.isArray(data.items) ? data.items : [];
      setLibrary(items);

      const currentActive = activeTrackRef.current;
      if (currentActive) {
        const match = items.find((x) => x.job_id === currentActive.jobId);
        if (match) {
          setActiveTrack({
            ...currentActive,
            title: match.title,
            stems: match.stems,
            bpm: match.detected_bpm ?? currentActive.bpm,
            beatOffsetSec:
              typeof match.beat_offset_sec === "number"
                ? match.beat_offset_sec
                : currentActive.beatOffsetSec,
          });
        }
      }
    } catch {
      // Abaikan error sesaat
    } finally {
      setLoadingLibrary(false);
    }
  }, [apiUrl]);

  useEffect(() => {
    try {
      if (activeTrack) {
        window.sessionStorage.setItem(
          ACTIVE_TRACK_STORAGE_KEY,
          JSON.stringify(activeTrack),
        );
      } else {
        window.sessionStorage.removeItem(ACTIVE_TRACK_STORAGE_KEY);
      }
    } catch {
      // Abaikan error storage
    }
  }, [activeTrack]);

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
        if (data.status === "completed" && data.stems.length > 0) {
          const bpmVal = data.detected_bpm ?? 120;
          const offsetVal =
            typeof data.beat_offset_sec === "number" ? data.beat_offset_sec : 0;
          const label =
            sourceType === "file" && file?.name
              ? file.name
              : youtubeUrl.trim() || `Track ${jobId.slice(0, 8)}`;
          const newEntry: LibraryItem = {
            job_id: jobId,
            title: label,
            stems: data.stems,
            detected_bpm: bpmVal,
            beat_offset_sec: offsetVal,
            created_at: new Date().toISOString().slice(0, 19).replace("T", " "),
          };
          setActiveTrack({
            jobId,
            title: label,
            stems: data.stems,
            bpm: bpmVal,
            beatOffsetSec: offsetVal,
          });
          setLibrary((prev) => [
            newEntry,
            ...prev.filter((x) => x.job_id !== jobId),
          ]);
        }
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [jobId, apiUrl, sourceType, file, youtubeUrl]);

  const handlePersistSyncToLibrary = useCallback(
    async (targetJobId: string, nextBpm: number, nextBeatOffsetSec: number) => {
      try {
        const res = await fetch(`${apiUrl}/stem-library/${targetJobId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            detected_bpm: nextBpm,
            beat_offset_sec: nextBeatOffsetSec,
          }),
        });
        if (!res.ok) return;
        const data: { item?: LibraryItem } = await res.json();
        const savedOffset =
          typeof data.item?.beat_offset_sec === "number"
            ? data.item.beat_offset_sec
            : nextBeatOffsetSec;
        const savedBpm = data.item?.detected_bpm ?? nextBpm;

        setLibrary((prev) =>
          prev.map((x) =>
            x.job_id === targetJobId
              ? {
                  ...x,
                  detected_bpm: savedBpm,
                  beat_offset_sec: savedOffset,
                }
              : x,
          ),
        );

        // Simpan juga ke sessionStorage agar saat tab/halaman di-refresh tetap terbaca
        const currentActive = activeTrackRef.current;
        if (currentActive && currentActive.jobId === targetJobId) {
          const updatedActive: ActiveMixerTrack = {
            ...currentActive,
            bpm: savedBpm,
            beatOffsetSec: savedOffset,
          };
          activeTrackRef.current = updatedActive;
          try {
            window.sessionStorage.setItem(
              ACTIVE_TRACK_STORAGE_KEY,
              JSON.stringify(updatedActive),
            );
          } catch {
            // Abaikan error storage
          }
        }
      } catch {
        // Abaikan error sesaat
      }
    },
    [apiUrl],
  );

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

  function handleSelectFromLibrary(item: LibraryItem) {
    setActiveTrack({
      jobId: item.job_id,
      title: item.title,
      stems: item.stems,
      bpm: item.detected_bpm ?? 120,
      beatOffsetSec:
        typeof item.beat_offset_sec === "number" ? item.beat_offset_sec : 0,
    });
  }

  function handleStartRename(item: LibraryItem) {
    setConfirmingDeleteId(null);
    setEditingJobId(item.job_id);
    setEditingTitle(item.title);
  }

  function handleCancelRename() {
    setEditingJobId(null);
    setEditingTitle("");
  }

  async function handleSaveRename(targetJobId: string) {
    const trimmed = editingTitle.trim();
    if (!trimmed) return;
    setSavingTitleId(targetJobId);
    try {
      const res = await fetch(`${apiUrl}/stem-library/${targetJobId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      });
      if (!res.ok) return;
      const data: { item?: LibraryItem } = await res.json();
      const finalTitle = data.item?.title ?? trimmed;

      setLibrary((prev) =>
        prev.map((x) =>
          x.job_id === targetJobId ? { ...x, title: finalTitle } : x,
        ),
      );
      const currentActive = activeTrackRef.current;
      if (currentActive && currentActive.jobId === targetJobId) {
        setActiveTrack({ ...currentActive, title: finalTitle });
      }
      setEditingJobId(null);
      setEditingTitle("");
    } finally {
      setSavingTitleId(null);
    }
  }

  function handleRequestDelete(targetJobId: string) {
    setConfirmingDeleteId(targetJobId);
  }

  function handleCancelDelete() {
    if (deletingJobId) return;
    setConfirmingDeleteId(null);
  }

  async function handleDeleteFromLibrary(targetJobId: string) {
    setDeletingJobId(targetJobId);
    try {
      const res = await fetch(`${apiUrl}/stem-library/${targetJobId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setLibrary((prev) => prev.filter((x) => x.job_id !== targetJobId));
        if (editingJobId === targetJobId) {
          handleCancelRename();
        }
        if (activeTrackRef.current?.jobId === targetJobId) {
          setActiveTrack(null);
        }
        setConfirmingDeleteId(null);
      }
    } finally {
      setDeletingJobId(null);
    }
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
          Pilih lagu dari library yang sudah dipisah, atau pisahkan lagu baru
          dari file lokal / link YouTube.
        </p>
      </div>

      {/* Library Lagu yang Sudah Dipisah per Line */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">
              Library Lagu Terpisah ({library.length})
            </h3>
            <p className="text-xs text-zinc-400">
              Klik lagu untuk langsung masuk ke mixer tanpa extract/pisah ulang.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleRefreshLibrary()}
            className="rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
          >
            {loadingLibrary ? "Memuat..." : "Refresh Library"}
          </button>
        </div>

        {library.length === 0 ? (
          <p className="text-xs text-zinc-500 py-2">
            Belum ada lagu di library. Pisahkan lagu terlebih dahulu di bawah.
          </p>
        ) : (
          <div className="divide-y divide-zinc-800/80 max-h-56 overflow-y-auto">
            {library.map((item) => {
              const isSelected = activeTrack?.jobId === item.job_id;
              const isEditing = editingJobId === item.job_id;
              const isSaving = savingTitleId === item.job_id;
              const isConfirmingDelete = confirmingDeleteId === item.job_id;
              const isDeleting = deletingJobId === item.job_id;
              const itemOffset =
                typeof item.beat_offset_sec === "number"
                  ? item.beat_offset_sec
                  : 0;

              return (
                <div
                  key={item.job_id}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && isConfirmingDelete) {
                      handleCancelDelete();
                    }
                  }}
                  className={`py-2.5 flex flex-wrap items-center justify-between gap-2 ${
                    isSelected ? "bg-emerald-950/20 px-2 rounded-lg" : ""
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    {isEditing ? (
                      <div className="flex flex-wrap items-center gap-2 pr-2">
                        <input
                          type="text"
                          value={editingTitle}
                          onChange={(e) => setEditingTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void handleSaveRename(item.job_id);
                            } else if (e.key === "Escape") {
                              handleCancelRename();
                            }
                          }}
                          disabled={isSaving}
                          autoFocus
                          className="flex-1 min-w-[180px] rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => void handleSaveRename(item.job_id)}
                          disabled={isSaving || !editingTitle.trim()}
                          className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                        >
                          {isSaving ? "Menyimpan..." : "Simpan"}
                        </button>
                        <button
                          type="button"
                          onClick={handleCancelRename}
                          disabled={isSaving}
                          className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                        >
                          Batal
                        </button>
                      </div>
                    ) : (
                      <p className="text-sm font-medium text-zinc-100 truncate">
                        {item.title}
                      </p>
                    )}
                    <p className="text-[11px] font-mono text-zinc-400">
                      {item.detected_bpm} BPM • sync {itemOffset.toFixed(2)}s •{" "}
                      {item.stems.length} stem • {item.created_at}
                    </p>
                    {isConfirmingDelete && (
                      <p className="text-xs text-red-300 mt-1">
                        Hapus lagu ini dari library beserta file stem-nya?
                      </p>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleSelectFromLibrary(item)}
                      disabled={isDeleting}
                      className={`rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${
                        isSelected
                          ? "bg-emerald-600 text-white"
                          : "bg-zinc-800 text-zinc-100 hover:bg-zinc-700"
                      }`}
                    >
                      {isSelected ? "Sedang Dibuka" : "Buka di Mixer"}
                    </button>
                    {!isEditing && !isConfirmingDelete && (
                      <button
                        type="button"
                        onClick={() => handleStartRename(item)}
                        disabled={isDeleting}
                        className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                      >
                        Edit Nama
                      </button>
                    )}
                    {isConfirmingDelete ? (
                      <>
                        <button
                          type="button"
                          onClick={() =>
                            void handleDeleteFromLibrary(item.job_id)
                          }
                          disabled={isDeleting}
                          className="rounded-lg bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
                        >
                          {isDeleting ? "Menghapus..." : "Ya, Hapus"}
                        </button>
                        <button
                          type="button"
                          onClick={handleCancelDelete}
                          disabled={isDeleting}
                          className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                        >
                          Batal
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleRequestDelete(item.job_id)}
                        disabled={isDeleting}
                        className="rounded-lg border border-zinc-800 px-2.5 py-1.5 text-xs text-zinc-400 hover:border-red-800 hover:text-red-300 disabled:opacity-50"
                      >
                        Hapus
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Form Pisahkan Lagu Baru */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 space-y-4">
        <span className="block text-xs font-semibold uppercase tracking-wide text-zinc-400">
          Pisahkan Lagu Baru
        </span>

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
      </div>

      {/* Mixer Aktif */}
      {activeTrack && activeTrack.stems.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono text-emerald-400">
              MIXER AKTIF: {activeTrack.title}
            </span>
          </div>
          <StemMixer
            key={activeTrack.jobId}
            apiUrl={apiUrl}
            jobId={activeTrack.jobId}
            stems={activeTrack.stems}
            initialBpm={activeTrack.bpm}
            initialBeatOffset={activeTrack.beatOffsetSec}
            onSyncChange={handlePersistSyncToLibrary}
          />
        </div>
      )}
    </div>
  );
}
