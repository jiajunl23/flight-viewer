"use client";

export type Theme = "day" | "night" | "blue-marble";

export const THEME_TEXTURES: Record<Theme, string> = {
  day: "//unpkg.com/three-globe/example/img/earth-day.jpg",
  night: "//unpkg.com/three-globe/example/img/earth-night.jpg",
  "blue-marble": "//unpkg.com/three-globe/example/img/earth-blue-marble.jpg",
};

const LABELS: Record<Theme, string> = {
  day: "Day",
  night: "Night",
  "blue-marble": "Blue marble",
};

export interface ThemeSwitcherProps {
  value: Theme;
  onChange: (next: Theme) => void;
}

export default function ThemeSwitcher({ value, onChange }: ThemeSwitcherProps) {
  return (
    <div className="flex gap-1">
      {(Object.keys(THEME_TEXTURES) as Theme[]).map((t) => (
        <button
          key={t}
          onClick={() => onChange(t)}
          className={`px-2 py-1 rounded text-xs transition-colors ${
            value === t
              ? "bg-white text-black"
              : "bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
          }`}
        >
          {LABELS[t]}
        </button>
      ))}
    </div>
  );
}
