import { PlayIcon, VideoIcon } from "./icons";

/**
 * Stylized "before" video preview surface — placeholder for the poster's
 * actual reference video. Renders gradient backdrop with a play affordance.
 */
export function VideoPlaceholder({
  label = "Reference video",
  aspect = "aspect-[16/10]",
  category,
  className = "",
}: {
  label?: string;
  aspect?: string;
  category?: string;
  className?: string;
}) {
  const palette = paletteForCategory(category);
  return (
    <div
      className={`relative ${aspect} ${className} rounded-[16px] overflow-hidden`}
      style={{
        background: `linear-gradient(135deg, ${palette.from} 0%, ${palette.to} 100%)`,
      }}
    >
      {/* fake terrain grid overlay */}
      <svg
        className="absolute inset-0 w-full h-full opacity-30"
        viewBox="0 0 100 60"
        preserveAspectRatio="none"
      >
        <defs>
          <pattern id="grid" width="6" height="6" patternUnits="userSpaceOnUse">
            <path d="M 6 0 L 0 0 0 6" fill="none" stroke="white" strokeWidth="0.4" />
          </pattern>
        </defs>
        <rect width="100" height="60" fill="url(#grid)" />
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <div className="grid place-items-center w-14 h-14 rounded-full bg-white/90 text-[color:var(--color-ink)] shadow-[var(--shadow-pop)]">
          <PlayIcon width={20} height={20} />
        </div>
      </div>
      <div className="absolute left-3 bottom-3 right-3 flex items-center justify-between">
        <span className="inline-flex items-center gap-1 text-white text-[11px] font-medium px-2 py-1 rounded-full bg-black/40 backdrop-blur">
          <VideoIcon width={12} height={12} />
          {label}
        </span>
        <span className="text-white text-[11px] font-medium px-2 py-1 rounded-full bg-black/40 backdrop-blur tabular">
          0:14
        </span>
      </div>
    </div>
  );
}

function paletteForCategory(c?: string) {
  switch (c) {
    case "beach":
      return { from: "#3b82f6", to: "#22d3ee" };
    case "park":
      return { from: "#16a34a", to: "#84cc16" };
    case "illegal_dumping":
      return { from: "#0a0a0a", to: "#374151" };
    case "litter":
      return { from: "#f59e0b", to: "#f97316" };
    default:
      return { from: "#0f766e", to: "#16a34a" };
  }
}
