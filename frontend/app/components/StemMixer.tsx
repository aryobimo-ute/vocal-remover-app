"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type StemName = "drums" | "bass" | "guitar" | "piano" | "other" | "vocals";

type TrackControl = {
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
};

const STEM_LABELS: Record<StemName, string> = {
  drums: "Drum",
  bass: "Bass",
  guitar: "Gitar",
  piano: "Keyboard / Piano",
  other: "Instrumen Lain",
  vocals: "Vokal",
};

const DEFAULT_TRACK: TrackControl = {
  volume: 1,
  pan: 0,
  muted: false,
  solo: false,
};

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "00:00";
  const totalSec = Math.floor(sec);
  const mins = Math.floor(totalSec / 60);
  const remSec = totalSec % 60;
  return `${String(mins).padStart(2, "0")}:${String(remSec).padStart(2, "0")}`;
}

function createInitialTracks(): Record<StemName, TrackControl> {
  return {
    drums: { ...DEFAULT_TRACK },
    bass: { ...DEFAULT_TRACK },
    guitar: { ...DEFAULT_TRACK },
    piano: { ...DEFAULT_TRACK },
    other: { ...DEFAULT_TRACK },
    vocals: { ...DEFAULT_TRACK },
  };
}

function audioBufferToWavBlob(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1;
  const bitDepth = 16;
  const numSamples = buffer.length;
  const blockAlign = (numChannels * bitDepth) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;
  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  const channelData = Array.from({ length: numChannels }, (_, ch) =>
    buffer.getChannelData(ch),
  );
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channelData[ch][i]));
      view.setInt16(
        offset,
        sample < 0 ? sample * 0x8000 : sample * 0x7fff,
        true,
      );
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: "audio/wav" });
}

export default function StemMixer({
  apiUrl,
  jobId,
  stems,
  initialBpm = 120,
}: {
  apiUrl: string;
  jobId: string;
  stems: StemName[];
  initialBpm?: number;
}) {
  const [buffers, setBuffers] = useState<
    Partial<Record<StemName, AudioBuffer>>
  >({});
  const [loadingStems, setLoadingStems] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playbackRate, setPlaybackRate] = useState<number>(1);

  // Master volume khusus 6 stem (terpisah dari metronome)
  const [masterStemsVolume, setMasterStemsVolume] = useState<number>(1);

  const [tracks, setTracks] =
    useState<Record<StemName, TrackControl>>(createInitialTracks);

  // Metronome + sinkronisasi fase ketukan (beatOffsetSec)
  const [metroEnabled, setMetroEnabled] = useState(false);
  const [bpm, setBpm] = useState<number>(initialBpm);
  const [beatOffsetSec, setBeatOffsetSec] = useState<number>(0);
  const [metroVolume, setMetroVolume] = useState(0.5);
  const [metroPan, setMetroPan] = useState(0);
  const [exporting, setExporting] = useState(false);

  const tapTimesRef = useRef<number[]>([]);
  const bpmRef = useRef<number>(initialBpm);
  const beatOffsetRef = useRef<number>(0);
  const rateRef = useRef<number>(1);
  const masterStemsVolRef = useRef<number>(1);
  const tracksRef = useRef<Record<StemName, TrackControl>>(tracks);
  const metroRef = useRef({
    enabled: metroEnabled,
    volume: metroVolume,
    pan: metroPan,
  });

  const ctxRef = useRef<AudioContext | null>(null);
  const masterStemsGainRef = useRef<GainNode | null>(null);
  const stemSourcesRef = useRef<
    Partial<
      Record<
        StemName,
        {
          source: AudioBufferSourceNode;
          gain: GainNode;
          panner: StereoPannerNode;
        }
      >
    >
  >({});
  const metroGainRef = useRef<GainNode | null>(null);
  const metroPannerRef = useRef<StereoPannerNode | null>(null);
  const metroTimerRef = useRef<number | null>(null);
  const playheadRafRef = useRef<number | null>(null);
  const nextSongBeatTimeRef = useRef<number>(0);
  const beatCounterRef = useRef<number>(0);
  const anchorCtxTimeRef = useRef<number>(0);
  const anchorSongTimeRef = useRef<number>(0);
  const currentSongPosRef = useRef<number>(0);

  useEffect(() => {
    bpmRef.current = bpm;
  }, [bpm]);

  useEffect(() => {
    beatOffsetRef.current = beatOffsetSec;
  }, [beatOffsetSec]);

  useEffect(() => {
    rateRef.current = playbackRate;
  }, [playbackRate]);

  useEffect(() => {
    masterStemsVolRef.current = masterStemsVolume;
    if (masterStemsGainRef.current) {
      masterStemsGainRef.current.gain.value = masterStemsVolume;
    }
  }, [masterStemsVolume]);

  useEffect(() => {
    tracksRef.current = tracks;
  }, [tracks]);

  useEffect(() => {
    metroRef.current = {
      enabled: metroEnabled,
      volume: metroVolume,
      pan: metroPan,
    };
  }, [metroEnabled, metroVolume, metroPan]);

  const stopAudioNodes = useCallback(() => {
    if (metroTimerRef.current) {
      clearInterval(metroTimerRef.current);
      metroTimerRef.current = null;
    }
    if (playheadRafRef.current) {
      cancelAnimationFrame(playheadRafRef.current);
      playheadRafRef.current = null;
    }
    Object.values(stemSourcesRef.current).forEach((ns) => {
      try {
        ns?.source.stop();
        ns?.source.disconnect();
      } catch {
        // Abaikan jika sudah berhenti
      }
    });
    stemSourcesRef.current = {};
    masterStemsGainRef.current = null;
    metroGainRef.current = null;
    metroPannerRef.current = null;
  }, []);

  const scheduleMetronomeClickAtCtxTime = useCallback(
    (ctxTime: number, beatIndex: number) => {
      const ctx = ctxRef.current;
      if (!ctx || !metroGainRef.current || !metroPannerRef.current) return;
      if (ctxTime < ctx.currentTime) return;

      const isDownbeat = ((beatIndex % 4) + 4) % 4 === 0;
      const osc = ctx.createOscillator();
      const clickGain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(isDownbeat ? 1050 : 750, ctxTime);

      clickGain.gain.setValueAtTime(0.001, ctxTime);
      clickGain.gain.exponentialRampToValueAtTime(1.0, ctxTime + 0.003);
      clickGain.gain.exponentialRampToValueAtTime(0.0001, ctxTime + 0.045);

      osc.connect(clickGain);
      clickGain.connect(metroGainRef.current);
      metroGainRef.current.connect(metroPannerRef.current);
      metroPannerRef.current.connect(ctx.destination);

      osc.start(ctxTime);
      osc.stop(ctxTime + 0.05);
    },
    [],
  );

  const startMetronomeScheduler = useCallback(
    (fromSongSec: number) => {
      const ctx = ctxRef.current;
      if (!ctx) return;

      const safeBpm = Math.max(40, Math.min(240, bpmRef.current || 120));
      const beatSec = 60 / safeBpm;
      const offset = beatOffsetRef.current || 0;

      // Hitung indeks beat berikutnya relatif terhadap grid lagu (offset + k * beatSec)
      const rawSteps = (fromSongSec - offset) / beatSec;
      const nextStepIdx = Math.ceil(rawSteps - 1e-6);
      beatCounterRef.current = nextStepIdx;
      nextSongBeatTimeRef.current = offset + nextStepIdx * beatSec;

      if (metroTimerRef.current) {
        clearInterval(metroTimerRef.current);
      }

      metroTimerRef.current = window.setInterval(() => {
        if (!ctxRef.current) return;
        const activeBpm = Math.max(40, Math.min(240, bpmRef.current || 120));
        const activeBeatSec = 60 / activeBpm;
        const activeRate = Math.max(0.25, rateRef.current || 1);

        const elapsedAudioSec =
          (ctxRef.current.currentTime - anchorCtxTimeRef.current) * activeRate;
        const currentSongSec = anchorSongTimeRef.current + elapsedAudioSec;
        const lookaheadSongSec = currentSongSec + 0.12 * activeRate;

        while (nextSongBeatTimeRef.current <= lookaheadSongSec) {
          const songDeltaSec =
            nextSongBeatTimeRef.current - anchorSongTimeRef.current;
          const ctxTime = anchorCtxTimeRef.current + songDeltaSec / activeRate;
          scheduleMetronomeClickAtCtxTime(ctxTime, beatCounterRef.current);

          beatCounterRef.current += 1;
          nextSongBeatTimeRef.current += activeBeatSec;
        }
      }, 25);
    },
    [scheduleMetronomeClickAtCtxTime],
  );

  const startPlaybackFromOffset = useCallback(
    async (offsetSec: number, rateToUse: number) => {
      if (loadingStems || duration <= 0) return;
      const clampedOffset = Math.max(0, Math.min(duration, offsetSec));

      stopAudioNodes();
      if (ctxRef.current) {
        await ctxRef.current.close().catch(() => {});
        ctxRef.current = null;
      }

      if (clampedOffset >= duration) {
        currentSongPosRef.current = 0;
        setCurrentTime(0);
        setIsPlaying(false);
        return;
      }

      const ctx = new AudioContext();
      ctxRef.current = ctx;

      // Master bus khusus 6 stem (terpisah dari metronome)
      const masterStemsGain = ctx.createGain();
      masterStemsGain.gain.value = masterStemsVolRef.current;
      masterStemsGain.connect(ctx.destination);
      masterStemsGainRef.current = masterStemsGain;

      // Jalur metronome terpisah langsung ke destination
      const metroGain = ctx.createGain();
      metroGain.gain.value = metroRef.current.enabled
        ? metroRef.current.volume
        : 0;
      const metroPanner = ctx.createStereoPanner();
      metroPanner.pan.value = metroRef.current.pan;
      metroGain.connect(metroPanner);
      metroPanner.connect(ctx.destination);
      metroGainRef.current = metroGain;
      metroPannerRef.current = metroPanner;

      const currentTracks = tracksRef.current;
      const hasSolo = stems.some((s) => currentTracks[s]?.solo);

      anchorCtxTimeRef.current = ctx.currentTime;
      anchorSongTimeRef.current = clampedOffset;
      currentSongPosRef.current = clampedOffset;
      setCurrentTime(clampedOffset);

      for (const s of stems) {
        const buf = buffers[s];
        if (!buf) continue;
        const ctrl = currentTracks[s] ?? DEFAULT_TRACK;

        const source = ctx.createBufferSource();
        source.buffer = buf;
        source.playbackRate.value = rateToUse;

        const gain = ctx.createGain();
        const audible = !ctrl.muted && (!hasSolo || ctrl.solo);
        gain.gain.value = audible ? ctrl.volume : 0;

        const panner = ctx.createStereoPanner();
        panner.pan.value = ctrl.pan;

        source.connect(gain);
        gain.connect(panner);
        panner.connect(masterStemsGain);

        source.start(0, clampedOffset);
        stemSourcesRef.current[s] = { source, gain, panner };
      }

      startMetronomeScheduler(clampedOffset);
      setIsPlaying(true);

      const tickPlayhead = () => {
        if (!ctxRef.current) return;
        const elapsedAudioSec =
          (ctxRef.current.currentTime - anchorCtxTimeRef.current) *
          rateRef.current;
        const nextPos = anchorSongTimeRef.current + elapsedAudioSec;

        if (nextPos >= duration) {
          currentSongPosRef.current = 0;
          setCurrentTime(0);
          stopAudioNodes();
          ctxRef.current?.close().catch(() => {});
          ctxRef.current = null;
          setIsPlaying(false);
          return;
        }

        currentSongPosRef.current = nextPos;
        setCurrentTime(nextPos);
        playheadRafRef.current = requestAnimationFrame(tickPlayhead);
      };

      playheadRafRef.current = requestAnimationFrame(tickPlayhead);
    },
    [
      buffers,
      duration,
      loadingStems,
      startMetronomeScheduler,
      stems,
      stopAudioNodes,
    ],
  );

  useEffect(() => {
    let cancelled = false;
    async function loadAll() {
      setLoadingStems(true);
      setLoadError(null);
      let tempCtx: AudioContext | null = null;

      try {
        tempCtx = new AudioContext();
        const loaded: Partial<Record<StemName, AudioBuffer>> = {};
        let maxDur = 0;

        for (const s of stems) {
          const res = await fetch(`${apiUrl}/stem/${jobId}/${s}`);
          if (!res.ok) {
            throw new Error(`Gagal memuat stem '${s}' (status ${res.status})`);
          }
          const arr = await res.arrayBuffer();
          const decoded = await tempCtx.decodeAudioData(arr);
          loaded[s] = decoded;
          if (decoded.duration > maxDur) maxDur = decoded.duration;
        }

        if (!cancelled) {
          setBuffers(loaded);
          setDuration(maxDur);
          setCurrentTime(0);
          currentSongPosRef.current = 0;
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(
            err instanceof Error
              ? err.message
              : "Gagal memuat file audio stem.",
          );
        }
      } finally {
        if (tempCtx) {
          await tempCtx.close().catch(() => {});
        }
        if (!cancelled) {
          setLoadingStems(false);
        }
      }
    }

    loadAll();
    return () => {
      cancelled = true;
    };
  }, [apiUrl, jobId, stems]);

  useEffect(() => {
    const hasSolo = stems.some((s) => tracks[s]?.solo);
    for (const s of stems) {
      const nodeSet = stemSourcesRef.current[s];
      const ctrl = tracks[s];
      if (!nodeSet || !ctrl) continue;

      const audible = !ctrl.muted && (!hasSolo || ctrl.solo);
      nodeSet.gain.gain.value = audible ? ctrl.volume : 0;
      nodeSet.panner.pan.value = ctrl.pan;
    }
  }, [tracks, stems, isPlaying]);

  useEffect(() => {
    if (metroGainRef.current) {
      metroGainRef.current.gain.value = metroEnabled ? metroVolume : 0;
    }
    if (metroPannerRef.current) {
      metroPannerRef.current.pan.value = metroPan;
    }
  }, [metroEnabled, metroVolume, metroPan]);

  // Saat BPM atau Beat Offset diubah saat sedang play, hitung ulang jadwal ketukan berikutnya
  useEffect(() => {
    if (!isPlaying || !ctxRef.current) return;
    const elapsedAudioSec =
      (ctxRef.current.currentTime - anchorCtxTimeRef.current) * rateRef.current;
    const nowSongSec = anchorSongTimeRef.current + elapsedAudioSec;
    startMetronomeScheduler(nowSongSec);
  }, [bpm, beatOffsetSec, isPlaying, startMetronomeScheduler]);

  async function handlePlay() {
    if (isPlaying || loadingStems) return;
    await startPlaybackFromOffset(currentSongPosRef.current, playbackRate);
  }

  async function handlePause() {
    if (!isPlaying || !ctxRef.current) return;
    const elapsedAudioSec =
      (ctxRef.current.currentTime - anchorCtxTimeRef.current) * rateRef.current;
    const pausedAt = Math.min(
      duration,
      anchorSongTimeRef.current + elapsedAudioSec,
    );
    currentSongPosRef.current = pausedAt;
    setCurrentTime(pausedAt);
    stopAudioNodes();
    await ctxRef.current.close().catch(() => {});
    ctxRef.current = null;
    setIsPlaying(false);
  }

  async function handleStop() {
    stopAudioNodes();
    if (ctxRef.current) {
      await ctxRef.current.close().catch(() => {});
      ctxRef.current = null;
    }
    currentSongPosRef.current = 0;
    setCurrentTime(0);
    setIsPlaying(false);
  }

  async function handleSeekChange(nextSec: number) {
    const clamped = Math.max(0, Math.min(duration, nextSec));
    currentSongPosRef.current = clamped;
    setCurrentTime(clamped);
    if (isPlaying) {
      await startPlaybackFromOffset(clamped, playbackRate);
    }
  }

  async function handleRateChange(nextRate: number) {
    setPlaybackRate(nextRate);
    rateRef.current = nextRate;
    if (isPlaying && ctxRef.current) {
      const elapsedAudioSec =
        (ctxRef.current.currentTime - anchorCtxTimeRef.current) * nextRate;
      const nowPos = Math.min(
        duration,
        anchorSongTimeRef.current + elapsedAudioSec,
      );
      await startPlaybackFromOffset(nowPos, nextRate);
    }
  }

  function handleTapTempo() {
    const now = performance.now();
    const recent = tapTimesRef.current.filter((t) => now - t < 2500);
    recent.push(now);
    tapTimesRef.current = recent;

    if (recent.length >= 2) {
      const intervals: number[] = [];
      for (let i = 1; i < recent.length; i++) {
        intervals.push(recent[i] - recent[i - 1]);
      }
      const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const tappedBpm = Math.round(60000 / avgMs);
      if (tappedBpm >= 40 && tappedBpm <= 240) {
        setBpm(tappedBpm);
        bpmRef.current = tappedBpm;
      }
    }
  }

  function handleAlignBeatNow() {
    const activePos =
      isPlaying && ctxRef.current
        ? Math.min(
            duration,
            anchorSongTimeRef.current +
              (ctxRef.current.currentTime - anchorCtxTimeRef.current) *
                rateRef.current,
          )
        : currentSongPosRef.current;
    const roundedOffset = Number(activePos.toFixed(2));
    setBeatOffsetSec(roundedOffset);
    beatOffsetRef.current = roundedOffset;
  }

  function handleResetBpm() {
    setBpm(initialBpm);
    bpmRef.current = initialBpm;
    setBeatOffsetSec(0);
    beatOffsetRef.current = 0;
  }

  async function handleResetAll() {
    setTracks(createInitialTracks());
    setMasterStemsVolume(1);
    masterStemsVolRef.current = 1;
    setBpm(initialBpm);
    bpmRef.current = initialBpm;
    setBeatOffsetSec(0);
    beatOffsetRef.current = 0;
    setMetroVolume(0.5);
    setMetroPan(0);
    setMetroEnabled(false);
    setPlaybackRate(1);
    rateRef.current = 1;
    await handleStop();
  }

  useEffect(() => {
    return () => {
      stopAudioNodes();
      ctxRef.current?.close().catch(() => {});
    };
  }, [stopAudioNodes]);

  async function handleDownloadMix() {
    if (duration <= 0) return;
    setExporting(true);
    try {
      const sampleRate = 44100;
      const totalSamples = Math.ceil(duration * sampleRate);
      const offlineCtx = new OfflineAudioContext(2, totalSamples, sampleRate);
      const hasSolo = stems.some((s) => tracks[s]?.solo);

      // Master bus 6 stem saat export
      const offlineMasterStems = offlineCtx.createGain();
      offlineMasterStems.gain.value = masterStemsVolume;
      offlineMasterStems.connect(offlineCtx.destination);

      for (const s of stems) {
        const buf = buffers[s];
        if (!buf) continue;
        const ctrl = tracks[s] ?? DEFAULT_TRACK;
        const audible = !ctrl.muted && (!hasSolo || ctrl.solo);

        const src = offlineCtx.createBufferSource();
        src.buffer = buf;

        const gain = offlineCtx.createGain();
        gain.gain.value = audible ? ctrl.volume : 0;

        const panner = offlineCtx.createStereoPanner();
        panner.pan.value = ctrl.pan;

        src.connect(gain);
        gain.connect(panner);
        panner.connect(offlineMasterStems);
        src.start(0);
      }

      if (metroEnabled && metroVolume > 0) {
        const safeBpm = Math.max(40, Math.min(240, bpm || 120));
        const secondsPerBeat = 60 / safeBpm;
        const offset = beatOffsetSec || 0;
        const firstStep = Math.ceil((0 - offset) / secondsPerBeat);

        for (let step = firstStep; ; step++) {
          const t = offset + step * secondsPerBeat;
          if (t >= duration) break;
          if (t < 0) continue;

          const isDownbeat = ((step % 4) + 4) % 4 === 0;
          const osc = offlineCtx.createOscillator();
          const g = offlineCtx.createGain();
          const p = offlineCtx.createStereoPanner();

          osc.type = "triangle";
          osc.frequency.setValueAtTime(isDownbeat ? 1050 : 750, t);

          g.gain.setValueAtTime(0.001, t);
          g.gain.exponentialRampToValueAtTime(metroVolume, t + 0.003);
          g.gain.exponentialRampToValueAtTime(
            0.0001,
            Math.min(duration, t + 0.045),
          );

          p.pan.value = metroPan;

          osc.connect(g);
          g.connect(p);
          p.connect(offlineCtx.destination);

          osc.start(t);
          osc.stop(Math.min(duration, t + 0.05));
        }
      }

      const rendered = await offlineCtx.startRendering();
      const wavBlob = audioBufferToWavBlob(rendered);
      const url = URL.createObjectURL(wavBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `mixed_${jobId.slice(0, 8)}.wav`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  function updateTrack(stem: StemName, patch: Partial<TrackControl>) {
    setTracks((prev) => ({
      ...prev,
      [stem]: { ...prev[stem], ...patch },
    }));
  }

  if (loadingStems) {
    return (
      <p className="text-sm text-zinc-400">
        Memuat audio tiap instrumen ke mixer...
      </p>
    );
  }

  if (loadError) {
    return (
      <p className="rounded-lg bg-red-950/60 border border-red-800 p-3 text-sm text-red-300">
        {loadError}
      </p>
    );
  }

  return (
    <div className="space-y-5">
      {/* Transport + Kecepatan + Reset + Download */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
        <div className="flex flex-wrap items-center gap-2">
          {!isPlaying ? (
            <button
              type="button"
              onClick={handlePlay}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
            >
              Play Mix
            </button>
          ) : (
            <button
              type="button"
              onClick={handlePause}
              className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-500"
            >
              Pause
            </button>
          )}
          <button
            type="button"
            onClick={handleStop}
            className="rounded-lg border border-zinc-700 px-3.5 py-2 text-sm text-zinc-200 hover:bg-zinc-800"
          >
            Stop
          </button>
          <button
            type="button"
            onClick={handleResetAll}
            className="rounded-lg border border-zinc-700 px-3.5 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            Reset Semua
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-zinc-300">
            <span>Kecepatan:</span>
            <select
              value={playbackRate}
              onChange={(e) => handleRateChange(Number(e.target.value))}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 font-mono text-xs text-zinc-100"
            >
              {PLAYBACK_RATES.map((r) => (
                <option key={r} value={r}>
                  {r}x
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            onClick={handleDownloadMix}
            disabled={exporting}
            className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-900 hover:bg-white disabled:opacity-50"
          >
            {exporting ? "Merender Mix..." : "Download Hasil Mix (.wav)"}
          </button>
        </div>
      </div>

      {/* Master Volume Khusus 6 Stem (Terpisah dari Metronome) */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold text-sm text-zinc-100">
            Master Volume (6 Line Instrumen &amp; Vokal)
          </span>
          <span className="font-mono text-emerald-400">
            {Math.round(masterStemsVolume * 100)}%
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={1.5}
          step={0.01}
          value={masterStemsVolume}
          onChange={(e) => setMasterStemsVolume(Number(e.target.value))}
          className="w-full accent-emerald-500"
        />
      </div>

      {/* Timeline Lagu */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 space-y-2">
        <div className="flex items-center justify-between text-xs font-mono text-zinc-300">
          <span>Posisi: {formatTime(currentTime)}</span>
          <span>Durasi: {formatTime(duration)}</span>
        </div>
        <input
          type="range"
          min={0}
          max={duration > 0 ? duration : 1}
          step={0.1}
          value={Math.min(currentTime, duration || 1)}
          onChange={(e) => handleSeekChange(Number(e.target.value))}
          className="w-full accent-emerald-500 cursor-pointer"
        />
        <div className="flex flex-wrap gap-1.5 pt-1">
          {[0, 30, 60, 90, 120, 150, 180]
            .filter((sec) => sec < duration)
            .map((sec) => (
              <button
                key={sec}
                type="button"
                onClick={() => handleSeekChange(sec)}
                className="rounded border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-[11px] font-mono text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800"
              >
                {formatTime(sec)}
              </button>
            ))}
        </div>
      </div>

      {/* Metronome (Volume & Panning Sendiri + Tap Tempo + Beat Sync) */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-zinc-100">
              Metronome
            </span>
            <span className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] font-mono text-emerald-400">
              Auto Lagu: {initialBpm} BPM
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleTapTempo}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
            >
              Tap BPM
            </button>
            <button
              type="button"
              onClick={handleAlignBeatNow}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
            >
              Pas Beat di Posisi Ini
            </button>
            {(bpm !== initialBpm || beatOffsetSec !== 0) && (
              <button
                type="button"
                onClick={handleResetBpm}
                className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
              >
                Reset BPM ({initialBpm})
              </button>
            )}
            <label className="inline-flex items-center gap-2 text-sm cursor-pointer ml-1">
              <input
                type="checkbox"
                checked={metroEnabled}
                onChange={(e) => setMetroEnabled(e.target.checked)}
                className="rounded accent-emerald-500"
              />
              <span>Aktifkan Metronome</span>
            </label>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 text-xs">
          <div>
            <div className="flex justify-between mb-1">
              <span>BPM</span>
              <span className="font-mono">{bpm}</span>
            </div>
            <input
              type="range"
              min={40}
              max={240}
              value={bpm}
              onChange={(e) => setBpm(Number(e.target.value))}
              className="w-full accent-emerald-500"
            />
          </div>

          <div>
            <div className="flex justify-between mb-1">
              <span>Geser Ketukan (Beat Grid)</span>
              <span className="font-mono">{beatOffsetSec.toFixed(2)}s</span>
            </div>
            <input
              type="range"
              min={-2}
              max={2}
              step={0.01}
              value={beatOffsetSec}
              onChange={(e) => setBeatOffsetSec(Number(e.target.value))}
              className="w-full accent-emerald-500"
            />
          </div>

          <div>
            <div className="flex justify-between mb-1">
              <span>Volume Metronome</span>
              <span className="font-mono">
                {Math.round(metroVolume * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={1.5}
              step={0.01}
              value={metroVolume}
              onChange={(e) => setMetroVolume(Number(e.target.value))}
              className="w-full accent-emerald-500"
            />
          </div>

          <div>
            <div className="flex justify-between mb-1">
              <span>Panning (Kiri / Kanan)</span>
              <span className="font-mono">
                {metroPan === 0
                  ? "Center"
                  : metroPan < 0
                    ? `L ${Math.abs(Math.round(metroPan * 100))}%`
                    : `R ${Math.round(metroPan * 100)}%`}
              </span>
            </div>
            <input
              type="range"
              min={-1}
              max={1}
              step={0.05}
              value={metroPan}
              onChange={(e) => setMetroPan(Number(e.target.value))}
              className="w-full accent-emerald-500"
            />
          </div>
        </div>
      </div>

      {/* Channel Strip 6 Instrumen / Vokal */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {stems.map((stem) => {
          const ctrl = tracks[stem] ?? DEFAULT_TRACK;
          return (
            <div
              key={stem}
              className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 space-y-3"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">
                  {STEM_LABELS[stem]}
                </span>
                <div className="flex gap-1.5 text-xs">
                  <button
                    type="button"
                    onClick={() => updateTrack(stem, { solo: !ctrl.solo })}
                    className={`rounded px-2 py-0.5 border ${
                      ctrl.solo
                        ? "bg-amber-500/20 border-amber-400 text-amber-300"
                        : "border-zinc-700 text-zinc-400"
                    }`}
                  >
                    S
                  </button>
                  <button
                    type="button"
                    onClick={() => updateTrack(stem, { muted: !ctrl.muted })}
                    className={`rounded px-2 py-0.5 border ${
                      ctrl.muted
                        ? "bg-red-500/20 border-red-400 text-red-300"
                        : "border-zinc-700 text-zinc-400"
                    }`}
                  >
                    M
                  </button>
                </div>
              </div>

              <div className="text-xs">
                <div className="flex justify-between mb-1">
                  <span>Volume</span>
                  <span className="font-mono">
                    {Math.round(ctrl.volume * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={1.5}
                  step={0.01}
                  value={ctrl.volume}
                  onChange={(e) =>
                    updateTrack(stem, { volume: Number(e.target.value) })
                  }
                  className="w-full accent-emerald-500"
                />
              </div>

              <div className="text-xs">
                <div className="flex justify-between mb-1">
                  <span>Panning</span>
                  <span className="font-mono">
                    {ctrl.pan === 0
                      ? "Center"
                      : ctrl.pan < 0
                        ? `L ${Math.abs(Math.round(ctrl.pan * 100))}%`
                        : `R ${Math.round(ctrl.pan * 100)}%`}
                  </span>
                </div>
                <input
                  type="range"
                  min={-1}
                  max={1}
                  step={0.05}
                  value={ctrl.pan}
                  onChange={(e) =>
                    updateTrack(stem, { pan: Number(e.target.value) })
                  }
                  className="w-full accent-emerald-500"
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
