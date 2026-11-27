"use client";

import { useEffect, useRef, useState } from "react";

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
}: {
  apiUrl: string;
  jobId: string;
  stems: StemName[];
}) {
  const [buffers, setBuffers] = useState<
    Partial<Record<StemName, AudioBuffer>>
  >({});
  const [loadingStems, setLoadingStems] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);

  const [tracks, setTracks] = useState<Record<StemName, TrackControl>>(() => ({
    drums: { ...DEFAULT_TRACK },
    bass: { ...DEFAULT_TRACK },
    guitar: { ...DEFAULT_TRACK },
    piano: { ...DEFAULT_TRACK },
    other: { ...DEFAULT_TRACK },
    vocals: { ...DEFAULT_TRACK },
  }));

  const [metroEnabled, setMetroEnabled] = useState(false);
  const [bpm, setBpm] = useState(120);
  const [metroVolume, setMetroVolume] = useState(0.5);
  const [metroPan, setMetroPan] = useState(0);
  const [exporting, setExporting] = useState(false);

  const ctxRef = useRef<AudioContext | null>(null);
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
  const nextClickTimeRef = useRef<number>(0);
  const beatCountRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);
  const pauseOffsetRef = useRef<number>(0);

  useEffect(() => {
    let cancelled = false;
    async function loadAll() {
      setLoadingStems(true);
      const tempCtx = new AudioContext();
      const loaded: Partial<Record<StemName, AudioBuffer>> = {};
      let maxDur = 0;

      for (const s of stems) {
        const res = await fetch(`${apiUrl}/stem/${jobId}/${s}`);
        const arr = await res.arrayBuffer();
        const decoded = await tempCtx.decodeAudioData(arr);
        loaded[s] = decoded;
        if (decoded.duration > maxDur) maxDur = decoded.duration;
      }
      await tempCtx.close();

      if (!cancelled) {
        setBuffers(loaded);
        setDuration(maxDur);
        setLoadingStems(false);
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

  function scheduleMetronomeClick(time: number, isDownbeat: boolean) {
    const ctx = ctxRef.current;
    if (!ctx || !metroGainRef.current || !metroPannerRef.current) return;

    const osc = ctx.createOscillator();
    const clickGain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(isDownbeat ? 1050 : 750, time);

    clickGain.gain.setValueAtTime(0.001, time);
    clickGain.gain.exponentialRampToValueAtTime(1.0, time + 0.003);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.045);

    osc.connect(clickGain);
    clickGain.connect(metroGainRef.current);
    metroGainRef.current.connect(metroPannerRef.current);
    metroPannerRef.current.connect(ctx.destination);

    osc.start(time);
    osc.stop(time + 0.05);
  }

  function startMetronomeScheduler() {
    const ctx = ctxRef.current;
    if (!ctx) return;

    nextClickTimeRef.current = ctx.currentTime + 0.02;
    beatCountRef.current = 0;

    metroTimerRef.current = window.setInterval(() => {
      if (!ctxRef.current) return;
      const currentBeatSec = 60 / bpm;
      while (nextClickTimeRef.current < ctxRef.current.currentTime + 0.1) {
        const isDownbeat = beatCountRef.current % 4 === 0;
        scheduleMetronomeClick(nextClickTimeRef.current, isDownbeat);
        nextClickTimeRef.current += currentBeatSec;
        beatCountRef.current += 1;
      }
    }, 25);
  }

  function stopAudioNodes() {
    if (metroTimerRef.current) {
      clearInterval(metroTimerRef.current);
      metroTimerRef.current = null;
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
  }

  async function handlePlay() {
    if (isPlaying || loadingStems) return;
    const ctx = new AudioContext();
    ctxRef.current = ctx;

    const metroGain = ctx.createGain();
    metroGain.gain.value = metroEnabled ? metroVolume : 0;
    const metroPanner = ctx.createStereoPanner();
    metroPanner.pan.value = metroPan;
    metroGain.connect(metroPanner);
    metroPanner.connect(ctx.destination);
    metroGainRef.current = metroGain;
    metroPannerRef.current = metroPanner;

    const hasSolo = stems.some((s) => tracks[s]?.solo);
    const offset = pauseOffsetRef.current;
    startTimeRef.current = ctx.currentTime - offset;

    for (const s of stems) {
      const buf = buffers[s];
      if (!buf) continue;
      const ctrl = tracks[s] ?? DEFAULT_TRACK;

      const source = ctx.createBufferSource();
      source.buffer = buf;

      const gain = ctx.createGain();
      const audible = !ctrl.muted && (!hasSolo || ctrl.solo);
      gain.gain.value = audible ? ctrl.volume : 0;

      const panner = ctx.createStereoPanner();
      panner.pan.value = ctrl.pan;

      source.connect(gain);
      gain.connect(panner);
      panner.connect(ctx.destination);

      source.start(0, offset);
      stemSourcesRef.current[s] = { source, gain, panner };
    }

    startMetronomeScheduler();
    setIsPlaying(true);
  }

  async function handlePause() {
    if (!isPlaying || !ctxRef.current) return;
    pauseOffsetRef.current = Math.min(
      duration,
      ctxRef.current.currentTime - startTimeRef.current,
    );
    stopAudioNodes();
    await ctxRef.current.close();
    ctxRef.current = null;
    setIsPlaying(false);
  }

  async function handleStop() {
    stopAudioNodes();
    if (ctxRef.current) {
      await ctxRef.current.close();
      ctxRef.current = null;
    }
    pauseOffsetRef.current = 0;
    setIsPlaying(false);
  }

  useEffect(() => {
    return () => {
      stopAudioNodes();
      ctxRef.current?.close();
    };
  }, []);

  async function handleDownloadMix() {
    if (duration <= 0) return;
    setExporting(true);
    try {
      const sampleRate = 44100;
      const totalSamples = Math.ceil(duration * sampleRate);
      const offlineCtx = new OfflineAudioContext(2, totalSamples, sampleRate);
      const hasSolo = stems.some((s) => tracks[s]?.solo);

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
        panner.connect(offlineCtx.destination);
        src.start(0);
      }

      if (metroEnabled && metroVolume > 0) {
        const secondsPerBeat = 60 / bpm;
        let beatIdx = 0;
        for (let t = 0; t < duration; t += secondsPerBeat) {
          const osc = offlineCtx.createOscillator();
          const g = offlineCtx.createGain();
          const p = offlineCtx.createStereoPanner();

          osc.type = "triangle";
          osc.frequency.setValueAtTime(beatIdx % 4 === 0 ? 1050 : 750, t);

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
          beatIdx += 1;
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

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
        <div className="flex items-center gap-2">
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
        </div>

        <button
          type="button"
          onClick={handleDownloadMix}
          disabled={exporting}
          className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-900 hover:bg-white disabled:opacity-50"
        >
          {exporting ? "Merender Mix..." : "Download Hasil Mix (.wav)"}
        </button>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-zinc-100">Metronome</span>
          <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={metroEnabled}
              onChange={(e) => setMetroEnabled(e.target.checked)}
              className="rounded accent-emerald-500"
            />
            <span>Aktifkan Metronome</span>
          </label>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
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
