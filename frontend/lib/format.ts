export function formatSol(amount: number): string {
  return `${amount.toFixed(amount < 1 ? 2 : 2)} SOL`;
}

export function formatXp(amount: number): string {
  if (!Number.isFinite(amount)) return "0 XP";
  if (amount >= 10_000)
    return `${(amount / 1000).toFixed(1).replace(/\.0$/, "")}k XP`;
  return `${Math.round(amount).toLocaleString()} XP`;
}

/**
 * WLD has 18 decimals so we always show 2 fractional digits even when the
 * integer part is large -- a 0.05 WLD bounty rendered as "0 WLD" would be
 * wrong. We trim trailing zeros for whole values for cleanliness.
 */
export function formatWld(amount: number): string {
  if (!Number.isFinite(amount)) return "0 WLD";
  if (amount >= 1000)
    return `${Math.round(amount).toLocaleString()} WLD`;
  // toFixed(2) keeps "0.05 WLD" readable; trim "1.00" -> "1" for display.
  const fixed = amount.toFixed(2);
  return `${fixed.replace(/\.00$/, "")} WLD`;
}

export function formatReward(b: {
  reward_type: "sol" | "xp" | "wld";
  reward_sol: number;
  reward_xp: number | null;
  reward_wld?: number;
  xp_award: number;
}): string {
  if (b.reward_type === "xp") return formatXp(b.reward_xp ?? b.xp_award);
  if (b.reward_type === "wld") return formatWld(b.reward_wld ?? 0);
  return formatSol(b.reward_sol);
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
