export type TrajectoryPing = {
  lat: number;
  lng: number;
  accuracy: number | null;
  timestamp: string | null;
};

export type TrajectorySummary = {
  within_radius_pct: number;
  avg_distance_m: number;
  total_duration_s: number;
  suspicious: boolean;
};

const DEFAULT_RADIUS_METERS = Number(
  process.env.BOUNTY_RADIUS_METERS ?? 75
);

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6_371_000;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function analyzeTrajectory(
  pings: TrajectoryPing[],
  bountyLat: number,
  bountyLng: number,
  radiusMeters = DEFAULT_RADIUS_METERS
): TrajectorySummary {
  if (pings.length === 0) {
    return {
      within_radius_pct: 0,
      avg_distance_m: 0,
      total_duration_s: 0,
      suspicious: true
    };
  }

  const distances = pings.map((ping) =>
    haversineMeters(ping.lat, ping.lng, bountyLat, bountyLng)
  );
  const withinCount = distances.filter((d) => d <= radiusMeters).length;
  const avgDistance =
    distances.reduce((sum, value) => sum + value, 0) / distances.length;

  const sortedTimestamps = pings
    .map((ping) => ping.timestamp)
    .filter((v): v is string => Boolean(v))
    .map((iso) => new Date(iso).getTime())
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b);

  const totalDurationSec =
    sortedTimestamps.length >= 2
      ? Math.max(
          0,
          Math.round(
            (sortedTimestamps[sortedTimestamps.length - 1] -
              sortedTimestamps[0]) /
              1_000
          )
        )
      : 0;

  const withinRadiusPct = Number(
    ((withinCount / pings.length) * 100).toFixed(2)
  );
  const suspicious =
    pings.length < 3 || withinRadiusPct < 50 || avgDistance > radiusMeters * 2;

  return {
    within_radius_pct: withinRadiusPct,
    avg_distance_m: Number(avgDistance.toFixed(2)),
    total_duration_s: totalDurationSec,
    suspicious
  };
}
