"use client";

import { Sheet } from "./Sheet";
import { Badge } from "./Badge";
import { ButtonLink } from "./Button";
import { CoinIcon, LocationIcon, ClockIcon, ArrowRightIcon } from "./icons";
import type { Bounty } from "../../lib/types";
import {
  categoryLabel,
  formatDistance,
  formatRelative,
  formatTimeLeft,
  formatUsd,
  haversineMeters,
  statusLabel,
  statusTone,
} from "../../lib/format";

export function BountyPreviewSheet({
  bounty,
  open,
  onClose,
  userLocation,
}: {
  bounty: Bounty | null;
  open: boolean;
  onClose: () => void;
  userLocation?: { lat: number; lng: number } | null;
}) {
  return (
    <Sheet open={open && !!bounty} onClose={onClose}>
      {bounty && (
        <div className="px-5 pt-2 pb-6">
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <Badge tone={statusTone(bounty.status)} size="sm">
                  {statusLabel(bounty.status)}
                </Badge>
                <Badge tone="muted" size="sm">
                  {categoryLabel(bounty.category)}
                </Badge>
                {bounty.urgency_score >= 75 && (
                  <Badge tone="rose" size="sm">
                    High urgency
                  </Badge>
                )}
              </div>
              <h2 className="text-[18px] font-semibold tracking-tight mt-2 leading-snug">
                {bounty.title}
              </h2>
              <p className="text-sm text-[color:var(--color-muted)] mt-0.5">
                {bounty.address}
              </p>
            </div>
            <div className="text-right">
              <p className="text-[22px] font-bold tabular tracking-tight text-[color:var(--color-brand-600)] flex items-center gap-1 justify-end">
                <CoinIcon width={18} height={18} />
                {bounty.reward_sol.toFixed(2)}
              </p>
              <p className="text-[11px] text-[color:var(--color-muted)] tabular">
                ~{formatUsd(bounty.reward_usd_estimate)}
              </p>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-2">
            <Stat
              icon={<LocationIcon width={14} height={14} />}
              label="Distance"
              value={
                userLocation
                  ? formatDistance(haversineMeters(userLocation, bounty))
                  : "—"
              }
            />
            <Stat
              icon={<ClockIcon width={14} height={14} />}
              label="Posted"
              value={formatRelative(bounty.created_at)}
            />
            <Stat
              icon={<ClockIcon width={14} height={14} />}
              label="Expires"
              value={formatTimeLeft(bounty.expires_at)}
            />
          </div>

          <div className="mt-4 flex items-center gap-2 text-xs text-[color:var(--color-muted)]">
            <span
              className="inline-grid place-items-center w-6 h-6 rounded-full text-white text-[10px] font-semibold"
              style={{ background: bounty.poster.avatar_color }}
            >
              {bounty.poster.name[0]?.toUpperCase()}
            </span>
            <span className="truncate">
              by {bounty.poster.name}{" "}
              {bounty.poster.is_org && (
                <span className="text-[color:var(--color-brand-600)]">· verified org</span>
              )}
            </span>
          </div>

          <div className="mt-5">
            <ButtonLink
              href={`/bounty/${bounty.id}`}
              fullWidth
              size="lg"
              iconRight={<ArrowRightIcon width={18} height={18} />}
              onClick={onClose}
            >
              View bounty
            </ButtonLink>
          </div>
        </div>
      )}
    </Sheet>
  );
}

function Stat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="bg-[color:var(--color-surface)] rounded-[12px] px-3 py-2.5">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-[color:var(--color-muted)]">
        {icon} <span>{label}</span>
      </div>
      <p className="text-sm font-semibold tabular mt-0.5 truncate">{value}</p>
    </div>
  );
}
