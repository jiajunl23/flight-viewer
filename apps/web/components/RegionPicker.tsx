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
  { name: "London", lat: 51.47, lon: -0.46, radius: 80 },
  { name: "New York", lat: 40.64, lon: -73.78, radius: 80 },
  { name: "Paris", lat: 49.01, lon: 2.55, radius: 80 },
  { name: "Tokyo", lat: 35.55, lon: 139.78, radius: 80 },
  { name: "Los Angeles", lat: 33.94, lon: -118.41, radius: 80 },
  { name: "Frankfurt", lat: 50.04, lon: 8.56, radius: 80 },
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
    <div className="absolute top-3 right-3 z-10 bg-black/60 backdrop-blur px-3 py-2 rounded text-xs max-w-[260px]">
      <div className="text-zinc-400 mb-1.5">
        Focus region (live 1 Hz via airplanes.live)
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
