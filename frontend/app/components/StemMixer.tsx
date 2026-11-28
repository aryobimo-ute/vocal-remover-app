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

const ONSET_HOP = 256;
// Toleransi: klik pertama boleh sedikit mendahului bunyi pertama lagu (dalam satuan ketukan)
const GATE_TOLERANCE_BEATS = 0.12;

type OnsetData = { env: Float32Array; hopSec: number; peak: number };

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

// Deteksi detik pertama lagu benar-benar berbunyi (melewati hening / intro kosong)
function detectMusicStartSec(buffers: AudioBuffer[]): number {
  if (buffers.length === 0) return 0;
  const sr = buffers[0].sampleRate;
  const block = Math.max(1, Math.floor(sr * 0.02));
  const maxLen = Math.max(...buffers.map((b) => b.length));
  const nBlocks = Math.floor(maxLen / block);
  if (nBlocks <= 0) return 0;

  const power = new Float64Array(nBlocks);
  for (const buf of buffers) {
    const ch = buf.getChannelData(0);
    for (let b = 0; b < nBlocks; b++) {
      const s = b * block;
      const e = Math.min(ch.length, s + block);
      let sum = 0;
      let cnt = 0;
      for (let i = s; i < e; i += 4) {
        sum += ch[i] * ch[i];
        cnt++;
      }
      if (cnt > 0) power[b] += sum / cnt;
    }
  }

  const rms = Array.from(power, (p) => Math.sqrt(p));
  const sorted = [...rms].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const threshold = Math.max(0.0015, p95 * 0.03);
  for (let b = 0; b < rms.length; b++) {
    if (rms[b] >= threshold) return (b * block) / sr;
  }
  return 0;
}

// Envelope onset sederhana (kenaikan energi) dari stem drum untuk "snap" ke hentakan asli
function computeOnsetEnvelope(buffer: AudioBuffer): OnsetData {
  const ch = buffer.getChannelData(0);
  const n = Math.floor(ch.length / ONSET_HOP);
  const energy = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let sum = 0;
    const s = f * ONSET_HOP;
    for (let i = s; i < s + ONSET_HOP; i++) sum += ch[i] * ch[i];
    energy[f] = Math.sqrt(sum / ONSET_HOP);
  }
  const env = new Float32Array(n);
  for (let f = 1; f < n; f++) env[f] = Math.max(0, energy[f] - energy[f - 1]);
  const sorted = Float32Array.from(env).sort();
  const peak = sorted[Math.floor(sorted.length * 0.99)] ?? 0;
  return { env, hopSec: ONSET_HOP / buffer.sampleRate, peak };
}

function snapToOnset(
  data: OnsetData | null,
  loSec: number,
  hiSec: number,
): number | null {
  if (!data || data.env.length === 0) return null;
  const lo = Math.max(0, Math.floor(loSec / data.hopSec));
  const hi = Math.min(data.env.length - 1, Math.ceil(hiSec / data.hopSec));
  let best = -1;
  let bestVal = 0;
  for (let i = lo; i <= hi; i++) {
    if (data.env[i] > bestVal) {
      bestVal = data.env[i];
      best = i;
    }
  }
  if (best < 0 || bestVal < data.peak * 0.12) return null;
  return best * data.hopSec;
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
  initialBeatOffset = 0,
  onSyncChange,
}: {
  apiUrl: string;
  jobId: string;
  stems: StemName[];
  initialBpm?: number;
  initialBeatOffset?: number;
  onSyncChange?: (jobId: string, bpm: number, beatOffsetSec: number) => void;
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
  const [beatFlash, setBeatFlash] = useState<"none" | "down" | "beat">("none");

  // Master volume khusus 6 stem (terpisah dari metronome)
  const [masterStemsVolume, setMasterStemsVolume] = useState<number>(1);

  const [tracks, setTracks] =
    useState<Record<StemName, TrackControl>>(createInitialTracks);

  // Metronome + sinkronisasi fase ketukan drum (beatOffsetSec)
  const [metroEnabled, setMetroEnabled] = useState(false);
  const [bpm, setBpm] = useState<number>(initialBpm);
  const [beatOffsetSec, setBeatOffsetSec] = useState<number>(initialBeatOffset);
  const [metroVolume, setMetroVolume] = useState(0.5);
  const [metroPan, setMetroPan] = useState(0);
  const [exporting, setExporting] = useState(false);

  // Metronome baru mulai saat lagu masuk (bukan dari detik 0 / saat hening)
  const [gateEnabled, setGateEnabled] = useState(true);
  const [musicStartAuto, setMusicStartAuto] = useState(0);
  const [customStart, setCustomStart] = useState<number | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeMsg, setAnalyzeMsg] = useState<string | null>(null);

  const gateRef = useRef<number | null>(null);
  const onsetRef = useRef<OnsetData | null>(null);
  const playTokenRef = useRef<number>(0);
  const autoAnalyzedRef = useRef<string | null>(null);
  const onSyncRef = useRef(onSyncChange);

  const syncedSeedKeyRef = useRef<string>(
    `${jobId}|${initialBpm}|${initialBeatOffset}`,
  );
  const tapTimesRef = useRef<number[]>([]);
  const bpmRef = useRef<number>(initialBpm);
  const beatOffsetRef = useRef<number>(initialBeatOffset);
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
  const scheduledOscsRef = useRef<Set<OscillatorNode>>(new Set());
  const flashTimeoutRef = useRef<number | null>(null);
  const metroTimerRef = useRef<number | null>(null);
  const playheadRafRef = useRef<number | null>(null);
  const nextBeatIndexRef = useRef<number>(0);
  const anchorCtxTimeRef = useRef<number>(0);
  const anchorSongTimeRef = useRef<number>(0);
  const currentSongPosRef = useRef<number>(0);
  const isPlayingRef = useRef<boolean>(false);

  useEffect(() => {
    onSyncRef.current = onSyncChange;
  }, [onSyncChange]);

  useEffect(() => {
    gateRef.current = gateEnabled ? (customStart ?? musicStartAuto) : null;
  }, [gateEnabled, customStart, musicStartAuto]);

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

  const clearScheduledClicks = useCallback(() => {
    scheduledOscsRef.current.forEach((osc) => {
      try {
        osc.stop();
        osc.disconnect();
      } catch {
        // Abaikan jika sudah selesai/terputus
      }
    });
    scheduledOscsRef.current.clear();
  }, []);

  const getCurrentSongPos = useCallback((): number => {
    if (!isPlayingRef.current || !ctxRef.current) {
      return currentSongPosRef.current;
    }
    const elapsedAudioSec =
      (ctxRef.current.currentTime - anchorCtxTimeRef.current) * rateRef.current;
    return Math.max(
      0,
      Math.min(
        duration || Infinity,
        anchorSongTimeRef.current + elapsedAudioSec,
      ),
    );
  }, [duration]);

  const stopAudioNodes = useCallback(() => {
    isPlayingRef.current = false;
    if (metroTimerRef.current) {
      clearInterval(metroTimerRef.current);
      metroTimerRef.current = null;
    }
    if (playheadRafRef.current) {
      cancelAnimationFrame(playheadRafRef.current);
      playheadRafRef.current = null;
    }
    if (flashTimeoutRef.current) {
      clearTimeout(flashTimeoutRef.current);
      flashTimeoutRef.current = null;
    }
    setBeatFlash("none");
    clearScheduledClicks();
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
  }, [clearScheduledClicks]);

  const triggerVisualFlash = useCallback((isDownbeat: boolean) => {
    setBeatFlash(isDownbeat ? "down" : "beat");
    if (flashTimeoutRef.current) {
      clearTimeout(flashTimeoutRef.current);
    }
    flashTimeoutRef.current = window.setTimeout(() => {
      setBeatFlash("none");
    }, 90);
  }, []);

  const scheduleMetronomeClickAtCtxTime = useCallback(
    (ctxTime: number, isDownbeat: boolean) => {
      const ctx = ctxRef.current;
      if (!ctx || !metroGainRef.current) return;
      if (ctxTime < ctx.currentTime - 0.005) return;

      const safeStart = Math.max(ctx.currentTime, ctxTime);
      const osc = ctx.createOscillator();
      const clickGain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(isDownbeat ? 1100 : 780, safeStart);

      clickGain.gain.setValueAtTime(0.0001, safeStart);
      clickGain.gain.exponentialRampToValueAtTime(1.0, safeStart + 0.002);
      clickGain.gain.exponentialRampToValueAtTime(0.0001, safeStart + 0.04);

      osc.connect(clickGain);
      clickGain.connect(metroGainRef.current);

      scheduledOscsRef.current.add(osc);
      osc.onended = () => {
        scheduledOscsRef.current.delete(osc);
        try {
          osc.disconnect();
          clickGain.disconnect();
        } catch {
          // Abaikan
        }
      };

      const delayMs = Math.max(0, (safeStart - ctx.currentTime) * 1000);
      window.setTimeout(() => {
        if (isPlayingRef.current) {
          triggerVisualFlash(isDownbeat);
        }
      }, delayMs);

      osc.start(safeStart);
      osc.stop(safeStart + 0.045);
    },
    [triggerVisualFlash],
  );

  // Hitung beat grid secara konsisten: beatTime(k) = offset + k * beatSec
  const resetAndRunMetronomeFromSongTime = useCallback(
    (fromSongSec: number) => {
      clearScheduledClicks();
      if (metroTimerRef.current) {
        clearInterval(metroTimerRef.current);
        metroTimerRef.current = null;
      }

      const ctx = ctxRef.current;
      if (!ctx || !isPlayingRef.current) return;

      const safeBpm = Math.max(40, Math.min(240, bpmRef.current || 120));
      const beatSec = 60 / safeBpm;
      const offset = beatOffsetRef.current || 0;

      const k = Math.ceil((fromSongSec - offset) / beatSec - 1e-4);
      nextBeatIndexRef.current = k;

      const pumpClicks = () => {
        const currentCtx = ctxRef.current;
        if (!currentCtx || !isPlayingRef.current) return;

        const activeBpm = Math.max(40, Math.min(240, bpmRef.current || 120));
        const activeBeatSec = 60 / activeBpm;
        const activeOffset = beatOffsetRef.current || 0;
        const activeRate = Math.max(0.25, rateRef.current || 1);

        const elapsedAudioSec =
          (currentCtx.currentTime - anchorCtxTimeRef.current) * activeRate;
        const nowSongSec = anchorSongTimeRef.current + elapsedAudioSec;
        const lookaheadSongSec = nowSongSec + 0.2 * activeRate;

        // Ketukan pertama yang boleh berbunyi = ketukan grid pertama saat lagu masuk
        const gate = gateRef.current;
        const startIdx =
          gate === null
            ? Number.NEGATIVE_INFINITY
            : Math.ceil(
                (gate - activeOffset) / activeBeatSec - GATE_TOLERANCE_BEATS,
              );

        while (true) {
          const idx = nextBeatIndexRef.current;
          const beatSongTime = activeOffset + idx * activeBeatSec;
          if (beatSongTime > lookaheadSongSec) break;

          if (
            idx >= startIdx &&
            beatSongTime >= nowSongSec - 0.015 * activeRate
          ) {
            const deltaSongSec = beatSongTime - anchorSongTimeRef.current;
            const targetCtxTime =
              anchorCtxTimeRef.current + deltaSongSec / activeRate;
            // Hitungan 1-2-3-4 dimulai dari ketukan pertama lagu
            const rel = gate === null ? idx : idx - startIdx;
            scheduleMetronomeClickAtCtxTime(targetCtxTime, mod(rel, 4) === 0);
          }
          nextBeatIndexRef.current += 1;
        }
      };

      pumpClicks();
      metroTimerRef.current = window.setInterval(pumpClicks, 25);
    },
    [clearScheduledClicks, scheduleMetronomeClickAtCtxTime],
  );

  // Sinkronkan nilai awal dari library saat load awal / ganti lagu tanpa me-remount mixer
  useEffect(() => {
    const nextSeedKey = `${jobId}|${initialBpm}|${initialBeatOffset}`;
    if (syncedSeedKeyRef.current === nextSeedKey) return;
    syncedSeedKeyRef.current = nextSeedKey;

    const timer = window.setTimeout(() => {
      setBpm(initialBpm);
      bpmRef.current = initialBpm;
      setBeatOffsetSec(initialBeatOffset);
      beatOffsetRef.current = initialBeatOffset;
      if (isPlayingRef.current) {
        resetAndRunMetronomeFromSongTime(getCurrentSongPos());
      }
    }, 0);

    return () => window.clearTimeout(timer);
  }, [
    jobId,
    initialBpm,
    initialBeatOffset,
    getCurrentSongPos,
    resetAndRunMetronomeFromSongTime,
  ]);

  const startPlaybackFromOffset = useCallback(
    async (offsetSec: number, rateToUse: number) => {
      if (loadingStems || duration <= 0) return;
      const clampedOffset = Math.max(0, Math.min(duration, offsetSec));

      // Token: bila ada seek/ganti kecepatan beruntun, hanya permintaan terakhir yang boleh jalan
      // (mencegah dua AudioContext hidup bersamaan -> audio dobel & metronome terasa tidak sinkron)
      const token = ++playTokenRef.current;

      stopAudioNodes();
      if (ctxRef.current) {
        await ctxRef.current.close().catch(() => {});
        ctxRef.current = null;
      }
      if (token !== playTokenRef.current) return;

      if (clampedOffset >= duration) {
        currentSongPosRef.current = 0;
        setCurrentTime(0);
        setIsPlaying(false);
        return;
      }

      const ctx = new AudioContext();
      // Pastikan jam audio benar-benar berjalan sebelum mengunci titik anchor
      if (ctx.state === "suspended") {
        await ctx.resume().catch(() => {});
      }
      if (token !== playTokenRef.current) {
        ctx.close().catch(() => {});
        return;
      }
      ctxRef.current = ctx;

      // Master bus khusus 6 stem (terpisah dari metronome)
      const masterStemsGain = ctx.createGain();
      masterStemsGain.gain.value = masterStemsVolRef.current;
      masterStemsGain.connect(ctx.destination);
      masterStemsGainRef.current = masterStemsGain;

      // Jalur metronome terpisah: hubungkan sekali saja
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

      const startCtxTime = ctx.currentTime + 0.05;
      anchorCtxTimeRef.current = startCtxTime;
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

        source.start(startCtxTime, clampedOffset);
        stemSourcesRef.current[s] = { source, gain, panner };
      }

      isPlayingRef.current = true;
      setIsPlaying(true);
      resetAndRunMetronomeFromSongTime(clampedOffset);

      const tickPlayhead = () => {
        if (!ctxRef.current || !isPlayingRef.current) return;
        const elapsedAudioSec =
          (ctxRef.current.currentTime - anchorCtxTimeRef.current) *
          rateRef.current;
        const nextPos = Math.max(
          clampedOffset,
          anchorSongTimeRef.current + elapsedAudioSec,
        );

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
      resetAndRunMetronomeFromSongTime,
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
          const loadedList = Object.values(loaded).filter(
            (b): b is AudioBuffer => Boolean(b),
          );
          const onsetSource = loaded.drums ?? loadedList[0];
          onsetRef.current = onsetSource
            ? computeOnsetEnvelope(onsetSource)
            : null;
          setMusicStartAuto(detectMusicStartSec(loadedList));
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

  async function handlePlay() {
    if (isPlayingRef.current || loadingStems) return;
    await startPlaybackFromOffset(currentSongPosRef.current, playbackRate);
  }

  async function handlePause() {
    if (!isPlayingRef.current || !ctxRef.current) return;
    playTokenRef.current += 1;
    const pausedAt = Math.min(duration, getCurrentSongPos());
    currentSongPosRef.current = pausedAt;
    setCurrentTime(pausedAt);
    stopAudioNodes();
    await ctxRef.current.close().catch(() => {});
    ctxRef.current = null;
    setIsPlaying(false);
  }

  async function handleStop() {
    playTokenRef.current += 1;
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
    if (isPlayingRef.current) {
      await startPlaybackFromOffset(clamped, playbackRate);
    }
  }

  async function handleRateChange(nextRate: number) {
    const nowPos = Math.min(duration, getCurrentSongPos());
    setPlaybackRate(nextRate);
    rateRef.current = nextRate;
    currentSongPosRef.current = nowPos;
    setCurrentTime(nowPos);

    if (isPlayingRef.current) {
      await startPlaybackFromOffset(nowPos, nextRate);
    }
  }

  function applyBpmValue(nextBpmVal: number) {
    if (!Number.isFinite(nextBpmVal)) return;
    const clampedBpm = Number(
      Math.max(40, Math.min(240, nextBpmVal)).toFixed(2),
    );

    // Pertahankan ketukan terdekat dari playhead (atau awal lagu) agar fase tidak
    // bergeser saat BPM diubah; selisih BPM baru baru terasa menjauh dari titik itu.
    const oldBeatSec = 60 / Math.max(40, Math.min(240, bpmRef.current || 120));
    const oldOffset = beatOffsetRef.current || 0;
    const pivotSong = Math.max(getCurrentSongPos(), gateRef.current ?? 0);
    const pivotBeatTime =
      oldOffset + Math.round((pivotSong - oldOffset) / oldBeatSec) * oldBeatSec;
    const newBeatSec = 60 / clampedBpm;
    const newOffset = Number(mod(pivotBeatTime, newBeatSec).toFixed(3));

    setBpm(clampedBpm);
    bpmRef.current = clampedBpm;
    setBeatOffsetSec(newOffset);
    beatOffsetRef.current = newOffset;
    if (isPlayingRef.current) {
      resetAndRunMetronomeFromSongTime(getCurrentSongPos());
    }
    onSyncChange?.(jobId, clampedBpm, newOffset);
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
      const tappedBpm = Number((60000 / avgMs).toFixed(1));
      if (tappedBpm >= 40 && tappedBpm <= 240) {
        applyBpmValue(tappedBpm);
      }
    }
  }

  function handleAlignBeatNow() {
    const activePos = getCurrentSongPos();
    const safeBpm = Math.max(40, Math.min(240, bpmRef.current || 120));
    const beatSec = 60 / safeBpm;

    // Cari hentakan drum terdekat (jendela tidak simetris karena reaksi manusia terlambat)
    const snapped = snapToOnset(
      onsetRef.current,
      activePos - Math.min(0.22, beatSec * 0.45),
      activePos + Math.min(0.08, beatSec * 0.2),
    );
    const anchorSec = snapped ?? activePos;
    const phaseSec = Number(mod(anchorSec, beatSec).toFixed(3));
    setBeatOffsetSec(phaseSec);
    beatOffsetRef.current = phaseSec;
    if (isPlayingRef.current) {
      resetAndRunMetronomeFromSongTime(activePos);
    }
    onSyncChange?.(jobId, safeBpm, phaseSec);
  }

  function handleBeatOffsetChange(nextOffset: number) {
    if (!Number.isFinite(nextOffset)) return;
    const rounded = Number(nextOffset.toFixed(3));
    setBeatOffsetSec(rounded);
    beatOffsetRef.current = rounded;
    if (isPlayingRef.current) {
      resetAndRunMetronomeFromSongTime(getCurrentSongPos());
    }
    onSyncChange?.(jobId, bpmRef.current, rounded);
  }

  function handleNudgeBeatMs(deltaMs: number) {
    const next = Number(
      Math.max(-2, Math.min(2, beatOffsetRef.current + deltaMs / 1000)).toFixed(
        3,
      ),
    );
    handleBeatOffsetChange(next);
  }

  function handleResetBpm() {
    setBpm(initialBpm);
    bpmRef.current = initialBpm;
    setBeatOffsetSec(initialBeatOffset);
    beatOffsetRef.current = initialBeatOffset;
    if (isPlayingRef.current) {
      resetAndRunMetronomeFromSongTime(getCurrentSongPos());
    }
    onSyncChange?.(jobId, initialBpm, initialBeatOffset);
  }

  function updateGate(enabled: boolean, custom: number | null) {
    setGateEnabled(enabled);
    setCustomStart(custom);
    gateRef.current = enabled ? (custom ?? musicStartAuto) : null;
    if (isPlayingRef.current) {
      resetAndRunMetronomeFromSongTime(getCurrentSongPos());
    }
  }

  // Terapkan hasil analisis backend ke mixer (dipakai tombol & auto-upgrade lagu lama)
  const applyAnalysis = useCallback(
    (nextBpm: number, nextOffset: number) => {
      setBpm(nextBpm);
      bpmRef.current = nextBpm;
      setBeatOffsetSec(nextOffset);
      beatOffsetRef.current = nextOffset;
      if (isPlayingRef.current) {
        resetAndRunMetronomeFromSongTime(getCurrentSongPos());
      }
      onSyncRef.current?.(jobId, nextBpm, nextOffset);
    },
    [getCurrentSongPos, jobId, resetAndRunMetronomeFromSongTime],
  );

  async function handleReanalyze() {
    setAnalyzing(true);
    setAnalyzeMsg(null);
    try {
      const res = await fetch(`${apiUrl}/stem-library/${jobId}/reanalyze`, {
        method: "POST",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || "Gagal menganalisis ulang beat.");
      }
      const data: {
        item?: { detected_bpm?: number; beat_offset_sec?: number };
      } = await res.json();
      if (
        typeof data.item?.detected_bpm === "number" &&
        typeof data.item?.beat_offset_sec === "number"
      ) {
        applyAnalysis(data.item.detected_bpm, data.item.beat_offset_sec);
        setAnalyzeMsg(
          `Terdeteksi ${data.item.detected_bpm.toFixed(2)} BPM • offset ${data.item.beat_offset_sec.toFixed(3)}s`,
        );
      }
    } catch (err) {
      setAnalyzeMsg(
        err instanceof Error ? err.message : "Gagal menganalisis ulang beat.",
      );
    } finally {
      setAnalyzing(false);
    }
  }

  // Lagu lama di library (analisis v1: BPM dibulatkan) di-upgrade otomatis sekali saja
  useEffect(() => {
    if (autoAnalyzedRef.current === jobId) return;
    autoAnalyzedRef.current = jobId;
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(
          `${apiUrl}/stem-library/${jobId}/reanalyze?only_if_outdated=true`,
          { method: "POST" },
        );
        if (!res.ok || cancelled) return;
        const data: {
          skipped?: boolean;
          item?: { detected_bpm?: number; beat_offset_sec?: number };
        } = await res.json();
        if (
          !data.skipped &&
          typeof data.item?.detected_bpm === "number" &&
          typeof data.item?.beat_offset_sec === "number"
        ) {
          applyAnalysis(data.item.detected_bpm, data.item.beat_offset_sec);
          setAnalyzeMsg(
            "Sinkron beat lagu ini diperbarui otomatis (lebih akurat).",
          );
        }
      } catch {
        // Abaikan: mixer tetap memakai nilai sinkron yang ada
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [apiUrl, jobId, applyAnalysis]);

  async function handleResetAll() {
    setTracks(createInitialTracks());
    setMasterStemsVolume(1);
    masterStemsVolRef.current = 1;
    setBpm(initialBpm);
    bpmRef.current = initialBpm;
    setBeatOffsetSec(initialBeatOffset);
    beatOffsetRef.current = initialBeatOffset;
    setMetroVolume(0.5);
    setMetroPan(0);
    setMetroEnabled(false);
    setGateEnabled(true);
    setCustomStart(null);
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
        const gate = gateEnabled ? (customStart ?? musicStartAuto) : null;
        const startIdx =
          gate === null
            ? Number.NEGATIVE_INFINITY
            : Math.ceil(
                (gate - offset) / secondsPerBeat - GATE_TOLERANCE_BEATS,
              );
        const firstStep = Math.max(
          Math.ceil((0 - offset) / secondsPerBeat),
          startIdx,
        );

        for (let step = firstStep; ; step++) {
          const t = offset + step * secondsPerBeat;
          if (t >= duration) break;
          if (t < 0) continue;

          const rel = gate === null ? step : step - startIdx;
          const isDownbeat = mod(rel, 4) === 0;
          const osc = offlineCtx.createOscillator();
          const g = offlineCtx.createGain();
          const p = offlineCtx.createStereoPanner();

          osc.type = "triangle";
          osc.frequency.setValueAtTime(isDownbeat ? 1100 : 780, t);

          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(metroVolume, t + 0.002);
          g.gain.exponentialRampToValueAtTime(
            0.0001,
            Math.min(duration, t + 0.04),
          );

          p.pan.value = metroPan;

          osc.connect(g);
          g.connect(p);
          p.connect(offlineCtx.destination);

          osc.start(t);
          osc.stop(Math.min(duration, t + 0.045));
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
            <span
              className={`h-3 w-3 rounded-full transition-transform duration-75 ${
                beatFlash === "down"
                  ? "bg-emerald-400 scale-125 shadow-[0_0_10px_#34d399]"
                  : beatFlash === "beat"
                    ? "bg-amber-300 scale-110"
                    : "bg-zinc-700"
              }`}
              title="Indikator Ketukan Metronome"
            />
            <span className="text-sm font-semibold text-zinc-100">
              Metronome
            </span>
            <span className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] font-mono text-emerald-400">
              Auto Lagu: {initialBpm.toFixed(2)} BPM • Sync{" "}
              {initialBeatOffset.toFixed(3)}s
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => applyBpmValue(bpm / 2)}
              className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] font-mono text-zinc-300 hover:bg-zinc-800"
            >
              ÷2 BPM
            </button>
            <button
              type="button"
              onClick={() => applyBpmValue(bpm * 2)}
              className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] font-mono text-zinc-300 hover:bg-zinc-800"
            >
              ×2 BPM
            </button>
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
            <button
              type="button"
              onClick={() => handleNudgeBeatMs(-50)}
              className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] font-mono text-zinc-300 hover:bg-zinc-800"
            >
              -50ms
            </button>
            <button
              type="button"
              onClick={() => handleNudgeBeatMs(-10)}
              className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] font-mono text-zinc-300 hover:bg-zinc-800"
            >
              -10ms
            </button>
            <button
              type="button"
              onClick={() => handleNudgeBeatMs(10)}
              className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] font-mono text-zinc-300 hover:bg-zinc-800"
            >
              +10ms
            </button>
            <button
              type="button"
              onClick={() => handleNudgeBeatMs(50)}
              className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] font-mono text-zinc-300 hover:bg-zinc-800"
            >
              +50ms
            </button>
            {(bpm !== initialBpm || beatOffsetSec !== initialBeatOffset) && (
              <button
                type="button"
                onClick={handleResetBpm}
                className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
              >
                Reset Sync ({initialBpm.toFixed(2)} /{" "}
                {initialBeatOffset.toFixed(3)}s)
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
            <div className="flex items-center justify-between mb-1 gap-2">
              <span>BPM</span>
              <input
                type="number"
                min={40}
                max={240}
                step={0.01}
                value={bpm}
                onChange={(e) => applyBpmValue(Number(e.target.value))}
                className="w-20 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-right font-mono text-xs text-zinc-100"
              />
            </div>
            <input
              type="range"
              min={40}
              max={240}
              step={0.01}
              value={bpm}
              onChange={(e) => applyBpmValue(Number(e.target.value))}
              className="w-full accent-emerald-500"
            />
          </div>

          <div>
            <div className="flex justify-between mb-1">
              <span>Geser Ketukan (Beat Grid)</span>
              <span className="font-mono">{beatOffsetSec.toFixed(3)}s</span>
            </div>
            <input
              type="range"
              min={-2}
              max={2}
              step={0.001}
              value={beatOffsetSec}
              onChange={(e) => handleBeatOffsetChange(Number(e.target.value))}
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

        <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-3 text-xs">
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={gateEnabled}
              onChange={(e) => updateGate(e.target.checked, customStart)}
              className="rounded accent-emerald-500"
            />
            <span>Metronome mulai saat lagu masuk</span>
          </label>
          {gateEnabled && (
            <span className="rounded bg-zinc-800 px-2 py-0.5 font-mono text-emerald-400">
              Mulai di {(customStart ?? musicStartAuto).toFixed(2)}s
              {customStart === null ? " (auto)" : " (manual)"}
            </span>
          )}
          <button
            type="button"
            onClick={() =>
              updateGate(true, Number(getCurrentSongPos().toFixed(3)))
            }
            className="rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
          >
            Mulai dari posisi ini
          </button>
          {customStart !== null && (
            <button
              type="button"
              onClick={() => updateGate(gateEnabled, null)}
              className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
            >
              Kembali ke auto ({musicStartAuto.toFixed(2)}s)
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleReanalyze()}
            disabled={analyzing}
            className="rounded-md border border-emerald-700 bg-emerald-950/40 px-2.5 py-1 text-xs text-emerald-300 hover:bg-emerald-900/40 disabled:opacity-50"
          >
            {analyzing ? "Menganalisis..." : "Deteksi Ulang Beat (Akurat)"}
          </button>
          {analyzeMsg && (
            <span className="font-mono text-[11px] text-zinc-400">
              {analyzeMsg}
            </span>
          )}
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
