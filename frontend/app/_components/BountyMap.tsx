"use client";

import { MapContainer, TileLayer, Marker, useMap } from "react-leaflet";
import L from "leaflet";
import { useEffect, useMemo } from "react";
import type { Bounty } from "../../lib/types";

type Props = {
  bounties: Bounty[];
  center: { lat: number; lng: number };
  userLocation?: { lat: number; lng: number } | null;
  onPinTap: (id: string) => void;
  draggable?: boolean;
  pinPosition?: { lat: number; lng: number };
  onPinMove?: (pos: { lat: number; lng: number }) => void;
  onMapMove?: (pos: { lat: number; lng: number }) => void;
};

const STATUS_COLOR: Record<Bounty["status"], string> = {
  open: "#16a34a",
  claimed: "#f59e0b",
  in_progress: "#2563eb",
  verifying: "#7c3aed",
  completed: "#9aa0a6",
  expired: "#9aa0a6",
};

function pinSizeForReward(reward: number): number {
  if (reward >= 0.4) return 56;
  if (reward >= 0.2) return 48;
  if (reward >= 0.1) return 40;
  return 36;
}

// Pixels the .bounty-pin::after triangle protrudes below the icon wrapper's
// bottom edge. MUST match the offsets baked into .bounty-pin::after in
// globals.css — if they diverge the pin will drift on zoom.
const TAIL_PROTRUSION_PX = 6;

function makeBountyIcon(b: Bounty): L.DivIcon {
  const color = STATUS_COLOR[b.status];
  const size = pinSizeForReward(b.reward_sol);
  const fontSize = size >= 48 ? 12 : 11;
  const label = b.reward_sol >= 1 ? b.reward_sol.toFixed(1) : b.reward_sol.toFixed(2).replace(/^0/, "");
  return L.divIcon({
    className: "",
    iconSize: [size, size],
    // Anchor at the visible tail TIP so the geographic point lines up with
    // the triangle below the circle (not the center of the circle).
    iconAnchor: [size / 2, size + TAIL_PROTRUSION_PX],
    html: `
      <div class="bounty-pin" style="width:${size}px;height:${size}px;background:${color};font-size:${fontSize}px;">
        <span style="line-height:1">${label}</span>
      </div>
    `,
  });
}

const userIcon = L.divIcon({
  className: "",
  iconSize: [22, 22],
  iconAnchor: [11, 11],
  html: `
    <div style="position:relative;width:22px;height:22px">
      <span style="position:absolute;inset:-8px;border-radius:9999px;background:rgba(22,163,74,0.25)" class="pulse-ring"></span>
      <span style="position:absolute;inset:0;border-radius:9999px;background:#16a34a;border:3px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,0.05);"></span>
    </div>
  `,
});

function MapEvents({
  onMapMove,
}: {
  onMapMove?: (pos: { lat: number; lng: number }) => void;
}) {
  const map = useMap();
  useEffect(() => {
    if (!onMapMove) return;
    const handler = () => {
      const c = map.getCenter();
      onMapMove({ lat: c.lat, lng: c.lng });
    };
    map.on("moveend", handler);
    return () => {
      map.off("moveend", handler);
    };
  }, [map, onMapMove]);
  return null;
}

function CenterFlyTo({ center }: { center: { lat: number; lng: number } }) {
  const map = useMap();
  useEffect(() => {
    // Skip when the map is already at this center (e.g. when the change came
    // from the user panning the map and `onMapMove` echoed it back into
    // state). Without this guard we'd fly back to the same spot on every
    // pan, fighting the user's drag.
    const cur = map.getCenter();
    if (
      Math.abs(cur.lat - center.lat) < 1e-5 &&
      Math.abs(cur.lng - center.lng) < 1e-5
    ) {
      return;
    }
    map.flyTo([center.lat, center.lng], map.getZoom(), { duration: 0.6 });
  }, [center.lat, center.lng, map]);
  return null;
}

// Leaflet measures its container at mount. When the map is rendered inside
// a flex column whose height resolves on a later layout pass, the initial
// measurement comes back at 0 and tiles never paint. Force a re-measure
// after mount and whenever the window resizes.
function MapInvalidator() {
  const map = useMap();
  useEffect(() => {
    const ids: number[] = [];
    ids.push(window.setTimeout(() => map.invalidateSize(), 0));
    ids.push(window.setTimeout(() => map.invalidateSize(), 200));
    const onResize = () => map.invalidateSize();
    window.addEventListener("resize", onResize);
    return () => {
      ids.forEach((id) => window.clearTimeout(id));
      window.removeEventListener("resize", onResize);
    };
  }, [map]);
  return null;
}

export default function BountyMap({
  bounties,
  center,
  userLocation,
  onPinTap,
  draggable,
  pinPosition,
  onPinMove,
  onMapMove,
}: Props) {
  const initialCenter: [number, number] = [center.lat, center.lng];

  const pins = useMemo(
    () =>
      bounties.map((b) => ({
        b,
        icon: makeBountyIcon(b),
      })),
    [bounties]
  );

  return (
    <MapContainer
      center={initialCenter}
      zoom={15}
      zoomControl={false}
      attributionControl={true}
      className="z-0"
      style={{ width: "100%", height: "100%" }}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
        url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
      />
      {userLocation && (
        <Marker
          position={[userLocation.lat, userLocation.lng]}
          icon={userIcon}
          interactive={false}
        />
      )}
      {!draggable &&
        pins.map(({ b, icon }) => (
          <Marker
            key={b.id}
            position={[b.lat, b.lng]}
            icon={icon}
            eventHandlers={{ click: () => onPinTap(b.id) }}
          />
        ))}
      {draggable && pinPosition && (
        <Marker
          position={[pinPosition.lat, pinPosition.lng]}
          draggable
          icon={L.divIcon({
            className: "",
            iconSize: [44, 44],
            iconAnchor: [22, 44 + TAIL_PROTRUSION_PX],
            html: `
              <div class="bounty-pin" style="width:44px;height:44px;background:#16a34a;color:#fff;font-size:11px;">
                <span style="line-height:1">PIN</span>
              </div>
            `,
          })}
          eventHandlers={{
            dragend: (e) => {
              const m = e.target as L.Marker;
              const ll = m.getLatLng();
              onPinMove?.({ lat: ll.lat, lng: ll.lng });
            },
          }}
        />
      )}
      <MapEvents onMapMove={onMapMove} />
      <CenterFlyTo center={center} />
      <MapInvalidator />
    </MapContainer>
  );
}
