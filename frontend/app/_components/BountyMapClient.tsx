"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import type BountyMap from "./BountyMap";

const Map = dynamic(() => import("./BountyMap"), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 bg-[#eef2ee] grid place-items-center text-[color:var(--color-muted)] text-sm">
      Loading map…
    </div>
  ),
});

export default function BountyMapClient(props: ComponentProps<typeof BountyMap>) {
  return <Map {...props} />;
}
