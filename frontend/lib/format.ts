import type { Currency } from "./types";

export function formatSol(amount: number): string {
  return `${amount.toFixed(2)} SOL`;
}

export function formatWld(amount: number): string {
  return `${amount.toFixed(2)} WLD`;
}

/**
 * Render a reward amount with its currency suffix (e.g. "1.25 WLD").
 * Centralizing this keeps every card / sheet / page in lockstep when we add
 * more currencies later.
 */
export function formatReward(amount: number, currency: Currency): string {
  return currency === "SOL" ? formatSol(amount) : formatWld(amount);
}

export function rewardUnit(currency: Currency): string {
  return currency;
}

/**
 * Rough USD spot rates used for ranking / tooltips. These intentionally live
 * in one place so we can swap them for a live oracle later. The backend uses
 * the same constants in `routes/leaderboard.ts`.
 */
export const SPOT_USD: Record<Currency, number> = {
  SOL: 150,
  WLD: 2,
};

export function rewardUsd(amount: number, currency: Currency): number {
  return amount * SPOT_USD[currency];
}

export function formatUsd(amount: number): string {
  return `$${amount.toLocaleString(undefined, {
    maximumFractionDigits: 0,
  })}`;
}

export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  return `${km.toFixed(km < 10 ? 1 : 0)} km`;
}

export function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export function formatTimeLeft(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "expired";
  const m = Math.round(diff / 60_000);
  if (m < 60) return `${m}m left`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h left`;
  const d = Math.round(h / 24);
  return `${d}d left`;
}

export function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export function categoryLabel(c: string): string {
  switch (c) {
    case "litter":
      return "Litter";
    case "graffiti":
      return "Graffiti";
    case "illegal_dumping":
      return "Illegal dumping";
    case "park":
      return "Park";
    case "beach":
      return "Beach";
    default:
      return "Other";
  }
}

export function statusLabel(s: string): string {
  switch (s) {
    case "open":
      return "Open";
    case "claimed":
      return "Claimed";
    case "in_progress":
      return "In progress";
    case "verifying":
      return "Verifying";
    case "completed":
      return "Completed";
    case "expired":
      return "Expired";
    default:
      return s;
  }
}

export function statusTone(
  s: string
): "brand" | "amber" | "blue" | "violet" | "rose" | "neutral" | "muted" {
  switch (s) {
    case "open":
      return "brand";
    case "claimed":
      return "amber";
    case "in_progress":
      return "blue";
    case "verifying":
      return "violet";
    case "completed":
      return "neutral";
    default:
      return "muted";
  }
}
