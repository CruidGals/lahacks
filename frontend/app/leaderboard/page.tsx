"use client";

import { useEffect, useState } from "react";
import { Card } from "../_components/Card";
import { Skeleton } from "../_components/Skeleton";
import { CoinIcon, FireIcon, TrophyIcon } from "../_components/icons";
import { getLeaderboard } from "../../lib/api";
import type { LeaderboardEntry, Timeframe } from "../../lib/types";

const TIMEFRAMES: { id: Timeframe; label: string }[] = [
  { id: "week", label: "This week" },
  { id: "month", label: "Month" },
  { id: "all", label: "All time" },
];

export default function LeaderboardPage() {
  const [entries, setEntries] = useState<LeaderboardEntry[] | null>(null);
  const [tf, setTf] = useState<Timeframe>("week");

  useEffect(() => {
    setEntries(null);
    getLeaderboard(tf).then(setEntries);
  }, [tf]);

  const top3 = entries?.slice(0, 3) ?? [];
  const rest = entries?.slice(3) ?? [];

  return (
    <div className="flex-1 flex flex-col">
      {/* Header */}
      <div
        className="px-4 pt-6 pb-3"
        style={{ paddingTop: "calc(env(safe-area-inset-top) + 24px)" }}
      >
        <div className="flex items-center gap-2">
          <span className="grid place-items-center w-9 h-9 rounded-full bg-[color:var(--color-brand-500)] text-white">
            <TrophyIcon width={18} height={18} />
          </span>
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight leading-tight">
              Leaderboard
            </h1>
            <p className="text-xs text-[color:var(--color-muted)]">
              Top earners cleaning up their cities
            </p>
          </div>
        </div>

        <div className="flex gap-1.5 mt-4 bg-[color:var(--color-surface)] rounded-full p-1">
          {TIMEFRAMES.map((o) => (
            <button
              key={o.id}
              onClick={() => setTf(o.id)}
              className={`flex-1 h-9 text-sm font-medium rounded-full transition-colors ${
                tf === o.id
                  ? "bg-white text-[color:var(--color-ink)] shadow-[var(--shadow-card)]"
                  : "text-[color:var(--color-muted)]"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {/* Podium */}
      <div className="px-4 pt-2">
        {!entries ? (
          <div className="grid grid-cols-3 gap-2">
            <Skeleton className="h-32" />
            <Skeleton className="h-40" />
            <Skeleton className="h-28" />
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2 items-end">
            <Podium entry={top3[1]} place={2} height="h-28" />
            <Podium entry={top3[0]} place={1} height="h-36" />
            <Podium entry={top3[2]} place={3} height="h-24" />
          </div>
        )}
      </div>

      {/* List */}
      <div className="px-4 pt-4 pb-4 grid gap-2">
        {!entries &&
          Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        {entries &&
          rest.map((e) => (
            <Card
              key={e.user_id}
              className={`px-4 py-3 flex items-center gap-3 ${
                e.user_id === "user_me"
                  ? "ring-2 ring-[color:var(--color-brand-200)] bg-[color:var(--color-brand-50)]"
                  : ""
              }`}
            >
              <span className="w-7 text-sm font-bold tabular text-[color:var(--color-muted)]">
                {e.rank}
              </span>
              <span
                className="grid place-items-center w-9 h-9 rounded-full text-white text-sm font-bold"
                style={{ background: e.avatar_color }}
              >
                {e.handle[0]?.toUpperCase()}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold truncate">
                  @{e.handle}
                  {e.user_id === "user_me" && (
                    <span className="ml-1.5 text-[10px] uppercase tracking-wider text-[color:var(--color-brand-700)]">
                      you
                    </span>
                  )}
                </p>
                <p className="text-[11px] text-[color:var(--color-muted)] tabular">
                  {e.total_completed} cleanups
                </p>
              </div>
              <span className="text-sm font-bold tabular text-[color:var(--color-brand-600)] flex items-center gap-1">
                <CoinIcon width={14} height={14} />
                {e.total_earned_sol.toFixed(2)}
              </span>
            </Card>
          ))}
      </div>
    </div>
  );
}

function Podium({
  entry,
  place,
  height,
}: {
  entry: LeaderboardEntry | undefined;
  place: 1 | 2 | 3;
  height: string;
}) {
  if (!entry) {
    return <div />;
  }
  const accent =
    place === 1 ? "#16a34a" : place === 2 ? "#2563eb" : "#f59e0b";
  return (
    <div className="flex flex-col items-center">
      <span
        className={`grid place-items-center rounded-full text-white font-bold ${
          place === 1 ? "w-14 h-14 text-base" : "w-12 h-12 text-sm"
        }`}
        style={{ background: entry.avatar_color, boxShadow: `0 4px 14px ${accent}55` }}
      >
        {entry.handle[0]?.toUpperCase()}
      </span>
      <p className="text-[12px] font-semibold mt-1.5 truncate max-w-[100px] tabular">
        @{entry.handle}
      </p>
      <p className="text-[11px] tabular text-[color:var(--color-brand-600)] font-bold">
        {entry.total_earned_sol.toFixed(2)} SOL
      </p>
      <div
        className={`mt-2 w-full rounded-t-[14px] flex items-end justify-center pb-2 ${height}`}
        style={{
          background: `linear-gradient(180deg, ${accent}33 0%, ${accent}11 100%)`,
          borderTop: `2px solid ${accent}`,
        }}
      >
        <span className="text-[18px] font-bold tabular" style={{ color: accent }}>
          #{place}
        </span>
      </div>
    </div>
  );
}

// Suppress unused-import warning in case FireIcon is removed later
void FireIcon;
