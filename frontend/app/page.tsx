"use client";

import { useEffect, useMemo, useState } from "react";
import BountyMapClient from "./_components/BountyMapClient";
import { Badge } from "./_components/Badge";
import { CrosshairIcon, FilterIcon, LeafIcon } from "./_components/icons";
import { useGeolocation } from "../lib/useGeolocation";
import { getBounties } from "../lib/api";
import type { Bounty, BountyStatus } from "../lib/types";
import { DEFAULT_LOCATION } from "../lib/mock-data";
import { BountyPreviewSheet } from "./_components/BountyPreviewSheet";
import {
  categoryLabel,
  formatDistance,
  haversineMeters,
} from "../lib/format";
import { Sheet } from "./_components/Sheet";

const STATUS_OPTIONS: Array<{ id: BountyStatus | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "claimed", label: "Claimed" },
  { id: "completed", label: "Completed" },
];

const CATEGORY_OPTIONS = [
  "all",
  "litter",
  "graffiti",
  "illegal_dumping",
  "park",
  "beach",
  "other",
] as const;

const REWARD_BUCKETS = [
  { id: "any", label: "Any reward", min: 0 },
  { id: "0.1", label: "0.10 SOL+", min: 0.1 },
  { id: "0.25", label: "0.25 SOL+", min: 0.25 },
  { id: "0.5", label: "0.50 SOL+", min: 0.5 },
] as const;

export default function MapHome() {
  const geo = useGeolocation();
  const [bounties, setBounties] = useState<Bounty[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<BountyStatus | "all">("open");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [rewardFilter, setRewardFilter] = useState<typeof REWARD_BUCKETS[number]["id"]>("any");
  const [center, setCenter] = useState(DEFAULT_LOCATION);

  useEffect(() => {
    getBounties().then(setBounties);
  }, []);

  useEffect(() => {
    if (geo.location) setCenter(geo.location);
  }, [geo.location]);

  const filtered = useMemo(() => {
    if (!bounties) return [];
    const minReward =
      REWARD_BUCKETS.find((r) => r.id === rewardFilter)?.min ?? 0;
    return bounties.filter((b) => {
      if (statusFilter !== "all" && b.status !== statusFilter) return false;
      if (categoryFilter !== "all" && b.category !== categoryFilter) return false;
      if (b.reward_sol < minReward) return false;
      return true;
    });
  }, [bounties, statusFilter, categoryFilter, rewardFilter]);

  const selected = useMemo(
    () => bounties?.find((b) => b.id === selectedId) ?? null,
    [bounties, selectedId]
  );

  const totalOpen = bounties?.filter((b) => b.status === "open").length ?? 0;

  const onRecenter = () => {
    if (geo.location) setCenter({ ...geo.location });
  };

  const activeFilterCount =
    (statusFilter !== "open" ? 1 : 0) +
    (categoryFilter !== "all" ? 1 : 0) +
    (rewardFilter !== "any" ? 1 : 0);

  return (
    <div className="relative flex-1 flex flex-col">
      {/* Map fills the screen */}
      <div className="absolute inset-0">
        <BountyMapClient
          bounties={filtered}
          center={center}
          userLocation={geo.location}
          onPinTap={setSelectedId}
        />
      </div>

      {/* Top overlay: brand + filters */}
      <div
        className="relative z-10 px-4 pt-3 pointer-events-none"
        style={{ paddingTop: "calc(env(safe-area-inset-top) + 12px)" }}
      >
        <div className="flex items-center justify-between gap-2 pointer-events-auto">
          <div className="flex items-center gap-2 bg-white/95 backdrop-blur rounded-full px-3 py-2 shadow-[var(--shadow-card)] border border-[color:var(--color-border)]">
            <span className="grid place-items-center w-6 h-6 rounded-full bg-[color:var(--color-brand-500)] text-white">
              <LeafIcon width={14} height={14} />
            </span>
            <span className="text-sm font-semibold tracking-tight">Cleanr</span>
          </div>
          <button
            onClick={() => setFiltersOpen(true)}
            className="relative bg-white/95 backdrop-blur rounded-full px-3.5 py-2 shadow-[var(--shadow-card)] border border-[color:var(--color-border)] flex items-center gap-1.5 text-sm font-medium"
          >
            <FilterIcon width={16} height={16} />
            Filters
            {activeFilterCount > 0 && (
              <span className="ml-1 inline-grid place-items-center min-w-[18px] h-[18px] rounded-full bg-[color:var(--color-brand-500)] text-white text-[10px] font-semibold px-1">
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Recenter FAB */}
      <button
        onClick={onRecenter}
        aria-label="Recenter on me"
        className="absolute right-4 z-10 grid place-items-center w-11 h-11 rounded-full bg-white shadow-[var(--shadow-pop)] border border-[color:var(--color-border)] active:scale-95 transition-transform"
        style={{ bottom: "calc(140px + env(safe-area-inset-bottom))" }}
      >
        <CrosshairIcon width={20} height={20} />
      </button>

      {/* Bottom rail: bounty count + horizontal scroller */}
      <div className="relative z-10 mt-auto pointer-events-none">
        <div className="px-4 pb-2 pointer-events-auto">
          <Badge tone="muted" size="sm" className="shadow-[var(--shadow-card)]">
            <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--color-brand-500)] mr-1" />
            {bounties === null
              ? "Loading…"
              : `${filtered.length} of ${totalOpen} open nearby`}
          </Badge>
        </div>
        <NearbyRail
          bounties={filtered}
          userLocation={geo.location}
          onTap={setSelectedId}
        />
      </div>

      <BountyPreviewSheet
        bounty={selected}
        open={!!selected}
        onClose={() => setSelectedId(null)}
        userLocation={geo.location}
      />

      <Sheet open={filtersOpen} onClose={() => setFiltersOpen(false)} title="Filters">
        <div className="px-5 pb-6 space-y-5">
          <FilterGroup label="Status">
            {STATUS_OPTIONS.map((o) => (
              <Chip
                key={o.id}
                active={statusFilter === o.id}
                onClick={() => setStatusFilter(o.id)}
              >
                {o.label}
              </Chip>
            ))}
          </FilterGroup>

          <FilterGroup label="Category">
            {CATEGORY_OPTIONS.map((c) => (
              <Chip
                key={c}
                active={categoryFilter === c}
                onClick={() => setCategoryFilter(c)}
              >
                {c === "all" ? "All" : categoryLabel(c)}
              </Chip>
            ))}
          </FilterGroup>

          <FilterGroup label="Reward">
            {REWARD_BUCKETS.map((r) => (
              <Chip
                key={r.id}
                active={rewardFilter === r.id}
                onClick={() => setRewardFilter(r.id)}
              >
                {r.label}
              </Chip>
            ))}
          </FilterGroup>
        </div>
      </Sheet>
    </div>
  );
}

function NearbyRail({
  bounties,
  userLocation,
  onTap,
}: {
  bounties: Bounty[];
  userLocation: { lat: number; lng: number } | null;
  onTap: (id: string) => void;
}) {
  if (bounties.length === 0) {
    return null;
  }
  return (
    <div className="overflow-x-auto scroll-clean pointer-events-auto pb-3 px-4 -mx-0">
      <div className="flex gap-2 min-w-max">
        {bounties.slice(0, 12).map((b) => {
          const dist = userLocation
            ? formatDistance(haversineMeters(userLocation, b))
            : null;
          return (
            <button
              key={b.id}
              onClick={() => onTap(b.id)}
              className="text-left bg-white rounded-[16px] shadow-[var(--shadow-card)] border border-[color:var(--color-border)] px-3 py-2.5 w-[220px] flex flex-col gap-1 active:scale-[0.99] transition-transform"
            >
              <div className="flex items-center justify-between">
                <span className="text-[15px] font-bold tabular text-[color:var(--color-brand-600)]">
                  {b.reward_sol.toFixed(2)} SOL
                </span>
                {dist && (
                  <span className="text-[11px] text-[color:var(--color-muted)] tabular">
                    {dist}
                  </span>
                )}
              </div>
              <p className="text-[13px] font-medium leading-tight line-clamp-2">
                {b.title}
              </p>
              <p className="text-[11px] text-[color:var(--color-muted)] truncate">
                {b.address}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function FilterGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-[color:var(--color-muted)] mb-2">
        {label}
      </p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3.5 h-9 rounded-full text-sm font-medium border transition-colors ${
        active
          ? "bg-[color:var(--color-brand-500)] text-white border-[color:var(--color-brand-500)]"
          : "bg-white text-[color:var(--color-ink)] border-[color:var(--color-border)] hover:bg-[color:var(--color-surface)]"
      }`}
    >
      {children}
    </button>
  );
}
