"use client";

/** Simple star icon button to favorite/unfavorite an aircraft. */
export default function FavoritesStar({
  favored,
  onToggle,
}: {
  favored: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      aria-label={favored ? "Unfavorite" : "Favorite"}
      className={`text-lg ${favored ? "text-yellow-400" : "text-zinc-500 hover:text-zinc-300"}`}
    >
      {favored ? "★" : "☆"}
    </button>
  );
}
