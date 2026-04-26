"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  IDKitRequestWidget,
  orbLegacy,
  type IDKitResult,
  type RpContext,
} from "@worldcoin/idkit";
import { Card } from "../_components/Card";
import { Badge } from "../_components/Badge";
import { Skeleton } from "../_components/Skeleton";
import { ButtonLink, Button } from "../_components/Button";
import {
  ArrowRightIcon,
  CheckIcon,
  ClockIcon,
  CoinIcon,
  FireIcon,
  LeafIcon,
  LocationIcon,
  ShieldCheckIcon,
  SparkleIcon,
} from "../_components/icons";
import {
  cancelClaim,
  createWorldIdRpContext,
  getMe,
  getMyClaimedBounties,
  resetState,
  verifyWorldIdWithProof,
  type ClaimedBounty,
} from "../../lib/api";
import { ApiError } from "../../lib/http";
import type { User } from "../../lib/types";
import { formatRelative, formatReward, formatTimeLeft, formatUsd, formatXp } from "../../lib/format";
import { useToast } from "../_components/Toast";

export default function ProfilePage() {
  const [user, setUser] = useState<User | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [worldAppId, setWorldAppId] = useState<`app_${string}` | null>(null);
  const [worldAction, setWorldAction] = useState<string | null>(null);
  const [worldEnvironment, setWorldEnvironment] = useState<"production" | "staging">(
    "staging"
  );
  const [rpContext, setRpContext] = useState<RpContext | null>(null);
  const [claimed, setClaimed] = useState<ClaimedBounty[] | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    getMe().then(setUser);
  }, [reloadTick]);

  useEffect(() => {
    let cancelled = false;
    setClaimed(null);
    getMyClaimedBounties()
      .then((items) => {
        if (!cancelled) setClaimed(items);
      })
      .catch(() => {
        if (!cancelled) setClaimed([]);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  const onCancelClaim = async (id: string) => {
    if (cancellingId) return;
    setCancellingId(id);
    try {
      await cancelClaim(id);
      setClaimed((prev) => (prev ? prev.filter((b) => b.id !== id) : prev));
      toast("Claim cancelled", { variant: "info" });
    } catch (e: unknown) {
      toast("Couldn't cancel claim", {
        variant: "error",
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setCancellingId(null);
    }
  };

  const startWorldVerification = async () => {
    if (verifyLoading) return;
    setVerifyLoading(true);
    try {
      const world = await createWorldIdRpContext("verify-profile-world-id-v1");
      setWorldAppId(world.app_id);
      setWorldAction(world.action);
      setWorldEnvironment(world.environment);
      setRpContext(world.rp_context);
      setVerifyOpen(true);
    } catch {
      toast("Unable to start World ID verification", { variant: "error" });
    } finally {
      setVerifyLoading(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col">
      {/* Hero */}
      <div
        className="px-4 pt-6 pb-4 bg-gradient-to-b from-[color:var(--color-brand-50)] to-transparent"
        style={{ paddingTop: "calc(env(safe-area-inset-top) + 24px)" }}
      >
        <div className="flex items-center gap-3">
          {!user ? (
            <Skeleton className="w-14 h-14 rounded-full" rounded="rounded-full" />
          ) : (
            <span
              className="grid place-items-center w-14 h-14 rounded-full text-white text-xl font-bold"
              style={{ background: user.avatar_color }}
            >
              {user.handle[0]?.toUpperCase()}
            </span>
          )}
          <div className="flex-1 min-w-0">
            {!user ? (
              <>
                <Skeleton className="h-5 w-28" />
                <Skeleton className="h-3 w-40 mt-1.5" />
              </>
            ) : (
              <>
                <div className="flex items-center gap-1.5">
                  <h1 className="text-[20px] font-semibold tracking-tight truncate">
                    @{user.handle}
                  </h1>
                  {user.world_id_verified && (
                    <Badge tone="brand" size="sm" iconLeft={<ShieldCheckIcon width={11} height={11} />}>
                      World ID
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-[color:var(--color-muted)] tabular truncate">
                  Wallet · {user.wallet.address}
                </p>
              </>
            )}
          </div>
        </div>

        {/* Earnings card */}
        <Card className="mt-4 p-5 relative overflow-hidden">
          <div className="absolute -right-10 -top-10 w-36 h-36 rounded-full bg-[color:var(--color-brand-100)] blur-2xl opacity-60" />
          <p className="text-[11px] uppercase tracking-wider text-[color:var(--color-muted)] font-semibold">
            Wallet balance
          </p>
          <p className="text-[34px] font-bold tabular tracking-tight text-[color:var(--color-ink)] mt-1 leading-none flex items-center gap-2">
            <CoinIcon width={26} height={26} className="text-[color:var(--color-brand-600)]" />
            {user ? user.wallet.balance_sol.toFixed(2) : "—"}
            <span className="text-base font-semibold text-[color:var(--color-muted)] ml-1">SOL</span>
          </p>
          <p className="text-xs text-[color:var(--color-muted)] tabular mt-1">
            ~{user ? formatUsd(user.wallet.balance_sol * 153) : "—"} on Solana
          </p>
        </Card>

        {/* Stat row */}
        <div className="grid grid-cols-3 gap-2 mt-3">
          <Stat
            icon={<LeafIcon width={14} height={14} />}
            label="Completed"
            value={user ? `${user.total_completed}` : "—"}
          />
          <Stat
            icon={<FireIcon width={14} height={14} />}
            label="XP earned"
            value={user ? formatXp(user.total_earned_xp) : "—"}
          />
          <Stat
            icon={<FireIcon width={14} height={14} />}
            label="Streak"
            value={user ? `${user.current_streak}` : "—"}
            unit="days"
          />
        </div>
      </div>

      {/* World ID nudge */}
      {user && !user.world_id_verified && (
        <div className="px-4 mt-2">
          <Card className="p-4 flex items-center gap-3">
            <span className="grid place-items-center w-10 h-10 rounded-full bg-[color:var(--color-brand-50)] text-[color:var(--color-brand-700)]">
              <ShieldCheckIcon width={20} height={20} />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold">Verify with World ID</p>
              <p className="text-[12px] text-[color:var(--color-muted)] leading-snug">
                Required to claim bounties. Takes 10 seconds.
              </p>
            </div>
            <Button size="sm" loading={verifyLoading} onClick={startWorldVerification}>
              Verify
            </Button>
          </Card>
        </div>
      )}

      {rpContext && worldAppId && worldAction && (
        <IDKitRequestWidget
          open={verifyOpen}
          onOpenChange={setVerifyOpen}
          app_id={worldAppId}
          action={worldAction}
          rp_context={rpContext}
          allow_legacy_proofs
          environment={worldEnvironment}
          preset={orbLegacy({ signal: user?.id ?? "anonymous" })}
          handleVerify={async (result: IDKitResult) => {
            try {
              await verifyWorldIdWithProof({
                rp_id: rpContext.rp_id,
                idkit_response: result as unknown as Record<string, unknown>,
              });
            } catch (error) {
              const description =
                error instanceof ApiError
                  ? typeof error.body === "object" &&
                    error.body &&
                    "details" in error.body &&
                    (error.body as { details?: unknown }).details
                    ? JSON.stringify((error.body as { details: unknown }).details)
                    : error.message
                  : error instanceof Error
                    ? error.message
                    : "Verification request failed";
              toast("World ID verification failed", {
                variant: "error",
                description,
              });
              throw error;
            }
          }}
          onSuccess={() => {
            setVerifyOpen(false);
            setReloadTick((tick) => tick + 1);
            toast("Verified as a unique human", { variant: "success" });
          }}
          onError={() => {
            toast("World ID verification failed. Please try again.", {
              variant: "error",
            });
          }}
        />
      )}

      {/* Active claims */}
      <div className="px-4 mt-5">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold tracking-tight">Active claims</h2>
          {claimed && (
            <span className="text-[11px] text-[color:var(--color-muted)] tabular">
              {claimed.length}{" "}
              {claimed.length === 1 ? "bounty" : "bounties"}
            </span>
          )}
        </div>
        {claimed === null && (
          <div className="grid gap-2">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}
        {claimed && claimed.length === 0 && (
          <Card className="p-5 grid place-items-center text-center">
            <span className="grid place-items-center w-11 h-11 rounded-full bg-[color:var(--color-surface)] text-[color:var(--color-muted)]">
              <LeafIcon width={18} height={18} />
            </span>
            <p className="text-sm font-semibold mt-2.5">No active claims</p>
            <p className="text-xs text-[color:var(--color-muted)] mt-1 max-w-[260px]">
              Claim a bounty from the map and it&rsquo;ll show up here so you can
              continue or cancel it.
            </p>
            <ButtonLink href="/" size="sm" className="mt-3">
              Browse map
            </ButtonLink>
          </Card>
        )}
        {claimed && claimed.length > 0 && (
          <div className="grid gap-2">
            {claimed.map((bounty) => (
              <ClaimedBountyCard
                key={bounty.id}
                bounty={bounty}
                cancelling={cancellingId === bounty.id}
                disabled={cancellingId !== null && cancellingId !== bounty.id}
                onCancel={() => onCancelClaim(bounty.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Recent activity */}
      <div className="px-4 mt-5">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold tracking-tight">Recent payouts</h2>
          {user && (
            <span className="text-[11px] text-[color:var(--color-muted)] tabular">
              {user.recent_completed.length} total
            </span>
          )}
        </div>
        {!user && (
          <div className="grid gap-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}
        {user && user.recent_completed.length === 0 && (
          <Card className="p-6 grid place-items-center text-center">
            <span className="grid place-items-center w-12 h-12 rounded-full bg-[color:var(--color-surface)] text-[color:var(--color-muted)]">
              <SparkleIcon width={20} height={20} />
            </span>
            <p className="text-sm font-semibold mt-3">No payouts yet</p>
            <p className="text-xs text-[color:var(--color-muted)] mt-1 max-w-[260px]">
              Claim a bounty on the map to see your first payout here.
            </p>
            <ButtonLink href="/" size="sm" className="mt-3">
              Browse map
            </ButtonLink>
          </Card>
        )}
        {user && user.recent_completed.length > 0 && (
          <div className="grid gap-2">
            {user.recent_completed.map((c) => (
              <Card key={c.bounty_id} className="px-4 py-3 flex items-center gap-3">
                <span className="grid place-items-center w-9 h-9 rounded-full bg-[color:var(--color-brand-50)] text-[color:var(--color-brand-600)]">
                  <CheckIcon width={16} height={16} />
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate">{c.title}</p>
                  <p className="text-[11px] text-[color:var(--color-muted)]">
                    {formatRelative(c.completed_at)}
                  </p>
                </div>
                <span className="text-sm font-bold tabular text-[color:var(--color-brand-600)]">
                  +{formatReward(c)}
                </span>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Settings */}
      <div className="px-4 mt-5 mb-4 grid gap-2">
        <h2 className="text-sm font-semibold tracking-tight mb-1">Settings</h2>
        <Card className="divide-y divide-[color:var(--color-border)]">
          <SettingsRow label="App preferences" hint="Notifications, units, language" />
          <SettingsRow label="Wallet" hint="Connected · Phantom" />
          <Link
            href="/login?next=/profile"
            prefetch
            className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-[color:var(--color-surface)] transition-colors"
          >
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">World sign-in</p>
              <p className="text-[11px] text-[color:var(--color-muted)] truncate">
                Wallet link, World ID, switch session
              </p>
            </div>
            <span className="text-[color:var(--color-muted-2)]">›</span>
          </Link>
          <SettingsRow label="Help & feedback" hint="Send a note to our team" />
        </Card>
        <Button
          variant="ghost"
          size="md"
          onClick={() => {
            resetState();
            setReloadTick((t) => t + 1);
            toast("Reset demo data", { variant: "info" });
          }}
        >
          Reset demo data
        </Button>
      </div>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  unit,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  unit?: string;
}) {
  return (
    <div className="bg-white border border-[color:var(--color-border)] rounded-[14px] px-3 py-2.5">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-[color:var(--color-muted)]">
        {icon} <span>{label}</span>
      </div>
      <p className="text-base font-bold tabular mt-0.5 leading-none">
        {value}
        {unit && (
          <span className="ml-1 text-[10px] font-semibold text-[color:var(--color-muted)]">{unit}</span>
        )}
      </p>
    </div>
  );
}

function ClaimedBountyCard({
  bounty,
  cancelling,
  disabled,
  onCancel,
}: {
  bounty: ClaimedBounty;
  cancelling: boolean;
  disabled: boolean;
  onCancel: () => void;
}) {
  const expiresIn = formatTimeLeft(bounty.claim_expires_at);
  const continueHref = bounty.has_active_session
    ? `/bounty/${bounty.id}/start`
    : `/bounty/${bounty.id}`;
  const continueLabel = bounty.has_active_session
    ? "Resume task"
    : "Continue";

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <span
          className="grid place-items-center w-10 h-10 rounded-full text-white text-sm font-semibold shrink-0"
          style={{ background: bounty.poster.avatar_color }}
        >
          {bounty.title[0]?.toUpperCase() ?? "B"}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Badge tone="amber" size="sm">
              Claimed
            </Badge>
            {bounty.has_active_session && (
              <Badge tone="blue" size="sm">
                In progress
              </Badge>
            )}
          </div>
          <p className="text-sm font-semibold mt-1.5 leading-snug truncate">
            {bounty.title}
          </p>
          <p className="text-[11px] text-[color:var(--color-muted)] flex items-center gap-1 mt-0.5">
            <LocationIcon width={11} height={11} />
            <span className="truncate">{bounty.address}</span>
          </p>
          <div className="flex items-center gap-3 mt-2 text-[11px] tabular text-[color:var(--color-muted)]">
            <span className="inline-flex items-center gap-1">
              <CoinIcon width={11} height={11} />
              <span className="font-semibold text-[color:var(--color-brand-600)]">
                {formatReward(bounty)}
              </span>
            </span>
            <span className="inline-flex items-center gap-1">
              <ClockIcon width={11} height={11} />
              {expiresIn}
            </span>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 mt-3">
        <Button
          variant="outline"
          size="sm"
          loading={cancelling}
          disabled={disabled}
          onClick={onCancel}
        >
          Cancel claim
        </Button>
        <ButtonLink
          href={continueHref}
          size="sm"
          iconRight={<ArrowRightIcon width={14} height={14} />}
        >
          {continueLabel}
        </ButtonLink>
      </div>
    </Card>
  );
}

function SettingsRow({ label, hint }: { label: string; hint: string }) {
  return (
    <button className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-[color:var(--color-surface)] transition-colors">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-[11px] text-[color:var(--color-muted)] truncate">{hint}</p>
      </div>
      <span className="text-[color:var(--color-muted-2)]">›</span>
    </button>
  );
}
