"use client";

import type { AircraftState } from "shared";

interface Props {
  favorites: Set<string>;
  snapshot: Map<string, AircraftState>;
  selectedIcao24: string | null;
  onSelect: (icao24: string) => void;
  onUnstar: (icao24: string) => void;
}

/**
 * Left-side panel listing the user's tracked aircraft with live altitude and
 * ground speed. Currently-selected aircraft is highlighted. Click a row to
 * focus it on the globe.
 *
 * Collapses to a compact header when nothing is favorited so it doesn't
 * clutter the layout for new users.
 */
export default function FavoritesPanel({
  favorites,
  snapshot,
  selectedIcao24,
  onSelect,
  onUnstar,
}: Props) {
  const ids = Array.from(favorites);
  if (ids.length === 0) {
    return (
      <div className="absolute top-[92px] left-3 z-10 bg-black/60 backdrop-blur rounded px-3 py-1.5 text-[11px] text-zinc-500 max-w-[260px]">
        Star any aircraft to track it here
      </div>
    );
  }

  return (
    <div className="absolute top-[92px] left-3 z-10 bg-black/70 backdrop-blur rounded text-xs text-zinc-200 w-[280px] max-h-[60vh] overflow-y-auto shadow-xl border border-white/10">
      <div className="sticky top-0 z-10 bg-black/90 backdrop-blur px-3 py-2 border-b border-white/10 flex items-center justify-between">
        <span className="font-semibold tracking-wide">
          Tracking ({ids.length})
        </span>
        <span className="text-[10px] text-zinc-500">click to focus</span>
      </div>
      <ul className="divide-y divide-white/5">
        {ids.map((id) => {
          const s = snapshot.get(id);
          const isSelected = id === selectedIcao24;
          const alt = s?.baro_altitude ?? s?.geo_altitude ?? null;
          const gs = s?.velocity ?? null;
          return (
            <li
              key={id}
              className={`px-3 py-2 cursor-pointer transition-colors ${
                isSelected
                  ? "bg-cyan-900/60 border-l-2 border-cyan-400"
                  : "hover:bg-white/5 border-l-2 border-transparent"
              }`}
              onClick={() => onSelect(id)}
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={`font-semibold ${isSelected ? "text-cyan-200" : "text-zinc-100"}`}
                >
                  {s?.callsign?.trim() || id}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onUnstar(id);
                  }}
                  aria-label="Remove from tracking"
                  className="text-yellow-400 hover:text-yellow-200 leading-none text-sm"
                  title="Untrack"
                >
                  ★
                </button>
              </div>

              {/* Live stats */}
              <div className="mt-1 text-zinc-400 text-[11px] flex gap-3">
                {s ? (
                  <>
                    <span>
                      {alt != null ? `${Math.round(alt).toLocaleString()} m` : "— m"}
                    </span>
                    <span>{gs != null ? `${Math.round(gs)} m/s` : "— m/s"}</span>
                    {s.aircraft_type && (
                      <span className="text-zinc-500">{s.aircraft_type}</span>
                    )}
                  </>
                ) : (
                  <span className="text-zinc-600">offline — last seen too long ago</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
