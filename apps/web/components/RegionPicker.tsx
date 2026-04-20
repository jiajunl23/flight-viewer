"use client";

import { useState } from "react";

export interface Region {
  name: string;
  lat: number;
  lon: number;
  /** Radius in nautical miles — airplanes.live caps at 250. */
  radius: number;
}

const PRESETS: Region[] = [
  { name: "New York", lat: 40.64, lon: -73.78, radius: 80 },
  { name: "Los Angeles", lat: 33.94, lon: -118.41, radius: 80 },
  { name: "Chicago", lat: 41.98, lon: -87.91, radius: 80 },
  { name: "Dallas–Fort Worth", lat: 32.9, lon: -97.04, radius: 80 },
  { name: "San Francisco", lat: 37.62, lon: -122.38, radius: 80 },
  { name: "Atlanta", lat: 33.64, lon: -84.43, radius: 80 },
  { name: "Seattle", lat: 47.45, lon: -122.31, radius: 80 },
  { name: "Miami", lat: 25.8, lon: -80.29, radius: 80 },
  { name: "Toronto", lat: 43.68, lon: -79.63, radius: 80 },
];

export interface RegionPickerProps {
  onChange: (region: Region | null) => void;
}

export default function RegionPicker({ onChange }: RegionPickerProps) {
  const [activeName, setActiveName] = useState<string | null>(null);

  const pick = (name: string | null): void => {
    setActiveName(name);
    if (name === null) {
      onChange(null);
      return;
    }
    const r = PRESETS.find((p) => p.name === name);
    onChange(r ?? null);
  };

  return (
    <div className="bg-black/60 backdrop-blur px-3 py-2 rounded text-xs max-w-[260px]">
      <div className="text-zinc-400 mb-1.5">
        Zoom to hub (live 1 Hz)
      </div>
      <div className="flex flex-wrap gap-1">
        {PRESETS.map((p) => (
          <button
            key={p.name}
            onClick={() => pick(activeName === p.name ? null : p.name)}
            className={`px-2 py-1 rounded transition-colors ${
              activeName === p.name
                ? "bg-white text-black"
                : "bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
            }`}
          >
            {p.name}
          </button>
        ))}
      </div>
    </div>
  );
}
