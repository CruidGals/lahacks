"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ScreenHeader } from "../../_components/ScreenHeader";
import { Badge } from "../../_components/Badge";
import { Button } from "../../_components/Button";
import { Card } from "../../_components/Card";
import { Skeleton } from "../../_components/Skeleton";
import { VideoPlaceholder } from "../../_components/VideoPlaceholder";
import { WorldIdGate } from "../../_components/WorldIdGate";
import {
  CoinIcon,
  LocationIcon,
  ClockIcon,
  ShieldCheckIcon,
  CompassIcon,
  ArrowRightIcon,
  CheckIcon,
} from "../../_components/icons";
import {
  categoryLabel,
  formatDistance,
  formatRelative,
  formatTimeLeft,
  formatUsd,
  haversineMeters,
  statusLabel,
  statusTone,
} from "../../../lib/format";
import { claimBounty, getBounty, getCurrentUserId } from "../../../lib/api";
import type { Bounty } from "../../../lib/types";
import { useGeolocation } from "../../../lib/useGeolocation";
import { useToast } from "../../_components/Toast";

export default function BountyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const geo = useGeolocation();
  const { toast } = useToast();
  const [bounty, setBounty] = useState<Bounty | null | undefined>(undefined);
  const [worldVerified, setWorldVerified] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [hasActiveSession, setHasActiveSession] = useState(false);
  const [claiming, setClaiming] = useState(false);

  useEffect(() => {
    getBounty(id).then(setBounty);
  }, [id]);

  useEffect(() => {
    getCurrentUserId().then(setCurrentUserId).catch(() => {});
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem("cleanr.user_cache.v1");
      if (raw) setWorldVerified(Boolean(JSON.parse(raw)?.verified));
    } catch {}
    setHasActiveSession(
      Boolean(window.localStorage.getItem(`cleanr.session.${id}`))
    );
  }, [id]);

  const onClaim = async () => {
    if (!bounty) return;
    setClaiming(true);
    try {
      const updated = await claimBounty(bounty.id);
      setBounty(updated);
      toast("Bounty claimed — locked for 4 hours", { variant: "success" });
      router.push(`/bounty/${bounty.id}/start`);
    } catch (e: unknown) {
      toast("Couldn't claim bounty", {
        variant: "error",
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setClaiming(false);
    }
  };

  const distance =
    geo.location && bounty
      ? formatDistance(haversineMeters(geo.location, bounty))
      : null;

  return (
    <div className="flex-1 flex flex-col">
      <ScreenHeader title="Bounty" />

      {bounty === undefined && <DetailSkeleton />}

      {bounty === null && (
        <div className="flex-1 grid place-items-center px-6 text-center">
          <div>
            <h2 className="text-lg font-semibold">Bounty not found</h2>
            <p className="text-sm text-[color:var(--color-muted)] mt-1">
              It may have expired or been removed.
            </p>
          </div>
        </div>
      )}

      {bounty && (
        <div className="flex-1 flex flex-col">
          <div className="px-4 pt-2">
            <VideoPlaceholder
              label="Poster's reference"
              category={bounty.category}
            />
          </div>

          <div className="px-4 pt-4 pb-2">
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
            <h1 className="text-[22px] font-semibold tracking-tight mt-2 leading-tight">
              {bounty.title}
            </h1>
            <p className="text-sm text-[color:var(--color-muted)] mt-1 flex items-center gap-1">
              <LocationIcon width={14} height={14} /> {bounty.address}
            </p>
          </div>

          <div className="px-4">
            <Card className="p-4 flex items-center justify-between">
              <div>
                <p className="text-[11px] uppercase tracking-wider text-[color:var(--color-muted)]">
                  Reward escrowed
                </p>
                <p className="text-[28px] font-bold tabular tracking-tight text-[color:var(--color-brand-600)] flex items-center gap-1.5 leading-none mt-1">
                  <CoinIcon width={22} height={22} />
                  {bounty.reward_sol.toFixed(2)} SOL
                </p>
                <p className="text-xs text-[color:var(--color-muted)] mt-1 tabular">
                  ~{formatUsd(bounty.reward_usd_estimate)} · paid instantly on Solana
                </p>
              </div>
              <span className="grid place-items-center w-12 h-12 rounded-full bg-[color:var(--color-brand-50)] text-[color:var(--color-brand-600)]">
                <ShieldCheckIcon width={22} height={22} />
              </span>
            </Card>
          </div>

          <div className="px-4 mt-3 grid grid-cols-3 gap-2">
            <MetaTile
              icon={<CompassIcon width={14} height={14} />}
              label="Distance"
              value={distance ?? "—"}
            />
            <MetaTile
              icon={<ClockIcon width={14} height={14} />}
              label="Posted"
              value={formatRelative(bounty.created_at)}
            />
            <MetaTile
              icon={<ClockIcon width={14} height={14} />}
              label="Expires"
              value={formatTimeLeft(bounty.expires_at)}
            />
          </div>

          <div className="px-4 mt-4">
            <h3 className="text-sm font-semibold tracking-tight mb-2">
              Description
            </h3>
            <p className="text-[15px] leading-relaxed text-[color:var(--color-ink-2)]">
              {bounty.description}
            </p>
          </div>

          <div className="px-4 mt-5">
            <h3 className="text-sm font-semibold tracking-tight mb-2">
              How verification works
            </h3>
            <Card className="p-4 grid gap-3">
              <Step
                n={1}
                title="Tap Start Task on arrival"
                desc="We log GPS continuously to confirm you walked here."
              />
              <Step
                n={2}
                title="Do the cleanup"
                desc="Phone in pocket is fine — we sample motion in the background."
              />
              <Step
                n={3}
                title="Record one short video"
                desc="Aligns with the poster's framing. A nonce watermark proves it&rsquo;s live."
              />
              <Step
                n={4}
                title="Get paid in seconds"
                desc="AI compares before/after, then escrow releases SOL to your wallet."
                last
              />
            </Card>
          </div>

          <div className="px-4 mt-5 flex items-center gap-2 text-xs text-[color:var(--color-muted)]">
            <span
              className="inline-grid place-items-center w-7 h-7 rounded-full text-white text-xs font-semibold"
              style={{ background: bounty.poster.avatar_color }}
            >
              {bounty.poster.name[0]?.toUpperCase()}
            </span>
            <span className="truncate">
              Posted by <span className="font-medium text-[color:var(--color-ink)]">{bounty.poster.name}</span>{" "}
              {bounty.poster.is_org && (
                <span className="text-[color:var(--color-brand-600)]">· verified org</span>
              )}
            </span>
          </div>

          <div className="h-32" />

          {/* Sticky bottom CTA */}
          <div
            className="fixed bottom-0 left-0 right-0 mx-auto max-w-[480px] bg-white/95 backdrop-blur border-t border-[color:var(--color-border)] px-4 pt-3 z-30"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 12px)" }}
          >
            {bounty.status === "open" && (
              <WorldIdGate
                verified={worldVerified}
                onVerified={() => setWorldVerified(true)}
              >
                {({ onAttempt, verified }) => (
                  <Button
                    fullWidth
                    size="xl"
                    loading={claiming}
                    iconRight={<ArrowRightIcon width={18} height={18} />}
                    onClick={() => (verified ? onClaim() : onAttempt())}
                  >
                    {verified ? "Claim bounty" : "Verify & claim"}
                  </Button>
                )}
              </WorldIdGate>
            )}
            {bounty.status === "claimed" &&
              bounty.claimed_by === currentUserId && (
                <Button
                  fullWidth
                  size="xl"
                  iconRight={<ArrowRightIcon width={18} height={18} />}
                  onClick={() => router.push(`/bounty/${bounty.id}/start`)}
                >
                  {hasActiveSession ? "Resume task" : "Start task"}
                </Button>
              )}
            {bounty.status === "claimed" &&
              currentUserId !== null &&
              bounty.claimed_by !== currentUserId && (
                <Button fullWidth size="xl" disabled>
                  Claimed by someone else
                </Button>
              )}
            {bounty.status === "in_progress" && (
              <Button
                fullWidth
                size="xl"
                onClick={() => router.push(`/bounty/${bounty.id}/start`)}
              >
                Resume task
              </Button>
            )}
            {bounty.status === "completed" && (
              <Button
                fullWidth
                size="xl"
                variant="secondary"
                iconLeft={<CheckIcon width={18} height={18} />}
                disabled
              >
                Completed
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MetaTile({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="bg-[color:var(--color-surface)] rounded-[14px] px-3 py-2.5 border border-[color:var(--color-border)]">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-[color:var(--color-muted)]">
        {icon} <span>{label}</span>
      </div>
      <p className="text-sm font-semibold tabular mt-0.5 truncate">{value}</p>
    </div>
  );
}

function Step({
  n,
  title,
  desc,
  last,
}: {
  n: number;
  title: string;
  desc: string;
  last?: boolean;
}) {
  return (
    <div className="flex gap-3">
      <div className="relative flex flex-col items-center">
        <span className="grid place-items-center w-7 h-7 rounded-full bg-[color:var(--color-brand-50)] text-[color:var(--color-brand-700)] text-xs font-semibold">
          {n}
        </span>
        {!last && (
          <span className="flex-1 w-px bg-[color:var(--color-border)] mt-1" />
        )}
      </div>
      <div className="flex-1 pb-1">
        <p className="text-sm font-semibold leading-tight">{title}</p>
        <p className="text-[13px] text-[color:var(--color-muted)] leading-snug mt-0.5">
          {desc}
        </p>
      </div>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="px-4 mt-2 flex flex-col gap-3">
      <Skeleton className="aspect-[16/10] w-full" />
      <Skeleton className="h-6 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
