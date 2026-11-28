"use client";

import { useState } from "react";
import VocalSubtitleTab from "./components/VocalSubtitleTab";
import StemMixerTab from "./components/StemMixerTab";

const API_URL =
  typeof window !== "undefined"
    ? `http://${window.location.hostname}:8000`
    : "http://localhost:8000";

export default function HomePage() {
  const [activeTab, setActiveTab] = useState<"vocal-subtitle" | "stem-mixer">(
    "vocal-subtitle",
  );

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 p-6">
      <div className="max-w-4xl mx-auto rounded-2xl border border-zinc-800 bg-zinc-900 p-6 space-y-6">
        <div className="flex gap-2 border-b border-zinc-800 pb-4">
          <button
            type="button"
            onClick={() => setActiveTab("vocal-subtitle")}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
              activeTab === "vocal-subtitle"
                ? "bg-emerald-600 text-white"
                : "bg-zinc-800/70 text-zinc-300 hover:bg-zinc-800"
            }`}
          >
            1. Hapus Vokal &amp; Subtitle
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("stem-mixer")}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
              activeTab === "stem-mixer"
                ? "bg-emerald-600 text-white"
                : "bg-zinc-800/70 text-zinc-300 hover:bg-zinc-800"
            }`}
          >
            2. Pisah Instrumen &amp; Mixer
          </button>
        </div>

        {activeTab === "vocal-subtitle" ? (
          <VocalSubtitleTab apiUrl={API_URL} />
        ) : (
          <StemMixerTab apiUrl={API_URL} />
        )}
      </div>
    </main>
  );
}
