"use client";

import { useEffect, useState } from "react";

export interface Filters {
  countries: string[];
  airlines: string[];
  altitudeMin: number | null;
  altitudeMax: number | null;
  showOnGround: boolean;
}

export const EMPTY_FILTERS: Filters = {
  countries: [],
  airlines: [],
  altitudeMin: null,
  altitudeMax: null,
  showOnGround: true,
};

export interface FiltersPanelProps {
  value: Filters;
  onChange: (next: Filters) => void;
}

/**
 * Compact collapsible panel. Countries + airlines are comma-lists so the user
 * can paste common sets without complex UI (e.g. "DLH,BAW,AFR").
 */
export default function FiltersPanel({ value, onChange }: FiltersPanelProps) {
  const [open, setOpen] = useState(false);
  const [countriesText, setCountriesText] = useState(value.countries.join(", "));
  const [airlinesText, setAirlinesText] = useState(value.airlines.join(", "));

  useEffect(() => {
    setCountriesText(value.countries.join(", "));
  }, [value.countries]);
  useEffect(() => {
    setAirlinesText(value.airlines.join(", "));
  }, [value.airlines]);

  const commit = (next: Partial<Filters>): void => {
    onChange({ ...value, ...next });
  };

  return (
    <div className="absolute bottom-3 left-3 z-10 bg-black/60 backdrop-blur rounded text-xs max-w-[320px]">
      <button
        className="w-full flex items-center justify-between px-3 py-2 text-zinc-200 hover:bg-white/5 rounded"
        onClick={() => setOpen((o) => !o)}
      >
        <span>Filters</span>
        <span className="text-zinc-500">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2 text-zinc-300">
          <label className="block">
            <span className="text-zinc-400">Countries (comma)</span>
            <input
              className="mt-1 w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1"
              placeholder="United States, Germany"
              value={countriesText}
              onChange={(e) => setCountriesText(e.target.value)}
              onBlur={() =>
                commit({
                  countries: countriesText
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
          <label className="block">
            <span className="text-zinc-400">Airline callsign prefix</span>
            <input
              className="mt-1 w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1"
              placeholder="DLH, BAW, AFR"
              value={airlinesText}
              onChange={(e) => setAirlinesText(e.target.value)}
              onBlur={() =>
                commit({
                  airlines: airlinesText
                    .split(",")
                    .map((s) => s.trim().toUpperCase())
                    .filter(Boolean),
                })
              }
            />
          </label>
          <div className="flex gap-2">
            <label className="flex-1">
              <span className="text-zinc-400">Alt min (m)</span>
              <input
                type="number"
                className="mt-1 w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1"
                value={value.altitudeMin ?? ""}
                onChange={(e) =>
                  commit({
                    altitudeMin:
                      e.target.value === "" ? null : Number(e.target.value),
                  })
                }
              />
            </label>
            <label className="flex-1">
              <span className="text-zinc-400">Alt max (m)</span>
              <input
                type="number"
                className="mt-1 w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1"
                value={value.altitudeMax ?? ""}
                onChange={(e) =>
                  commit({
                    altitudeMax:
                      e.target.value === "" ? null : Number(e.target.value),
                  })
                }
              />
            </label>
          </div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={value.showOnGround}
              onChange={(e) => commit({ showOnGround: e.target.checked })}
            />
            <span>Show on-ground</span>
          </label>
        </div>
      )}
    </div>
  );
}
