"use client";

import { useState } from "react";
import { VideoPlaceholder } from "./VideoPlaceholder";
import { VideoIcon } from "./icons";

/**
 * Plays the poster's reference clip when ``videoUrl`` is set (HTTPS/HTTP URL from
 * the API, e.g. AI service ``/request-fixture``). Falls back to the stylized
 * placeholder if missing or if the stream fails to load.
 */
export function ReferenceVideoPreview({
  videoUrl,
  label = "Poster's reference",
  category,
}: {
  videoUrl: string | null;
  label?: string;
  category?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (!videoUrl || failed) {
    return (
      <VideoPlaceholder label={label} category={category} aspect="aspect-[16/10]" />
    );
  }

  return (
    <div className="relative aspect-[16/10] rounded-[16px] overflow-hidden bg-black">
      <video
        src={videoUrl}
        controls
        playsInline
        preload="metadata"
        className="absolute inset-0 w-full h-full object-cover"
        onError={() => setFailed(true)}
      />
      <div className="absolute left-3 bottom-3 right-3 pointer-events-none flex items-center justify-between">
        <span className="inline-flex items-center gap-1 text-white text-[11px] font-medium px-2 py-1 rounded-full bg-black/40 backdrop-blur">
          <VideoIcon width={12} height={12} />
          {label}
        </span>
      </div>
    </div>
  );
}
