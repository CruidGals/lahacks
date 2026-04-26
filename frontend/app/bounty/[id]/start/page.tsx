"use client";

import { use, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ScreenHeader } from "../../../_components/ScreenHeader";
import { Button } from "../../../_components/Button";
import { Card } from "../../../_components/Card";
import { Badge } from "../../../_components/Badge";
import {
  ArrowRightIcon,
  CompassIcon,
  LocationIcon,
  SignalIcon,
  ClockIcon,
  ShieldCheckIcon,
} from "../../../_components/icons";
import { useToast } from "../../../_components/Toast";
import { getBounty, startSession, getSession } from "../../../../lib/api";
import type { Bounty, Session } from "../../../../lib/types";
import { useGeolocation } from "../../../../lib/useGeolocation";
import { useTaskSession } from "../../../../lib/useTaskSession";
import { formatDistance, haversineMeters } from "../../../../lib/format";

export default function StartTaskPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const geo = useGeolocation();
  const { toast } = useToast();
  const [bounty, setBounty] = useState<Bounty | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [starting, setStarting] = useState(false);
  const { pings } = useTaskSession(session);

  useEffect(() => {
    getBounty(id).then(setBounty);
    // restore session if any
    if (typeof window !== "undefined") {
      const sid = window.localStorage.getItem(`cleanr.session.${id}`);
      if (sid) {
        getSession(sid).then((s) => {
          // Only resume genuinely active sessions; stale submitted/rejected/
          // cancelled sessions should not block starting a fresh run.
          if (s?.status === "active") {
            setSession(s);
            return;
          }
          window.localStorage.removeItem(`cleanr.session.${id}`);
        });
      }
    }
  }, [id]);

  const distance =
    geo.location && bounty
      ? haversineMeters(geo.location, bounty)
      : null;
  const onSite = distance !== null && distance < 75;

  const minutesElapsed = useMemo(() => {
    if (!session) return 0;
    return Math.floor(
      (Date.now() - new Date(session.started_at).getTime()) / 60_000
    );
  }, [session, pings.length]); // re-render when pings advance

  const onStart = async () => {
    if (!bounty) return;
    setStarting(true);
    try {
      const s = await startSession(bounty.id);
      setSession(s);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(`cleanr.session.${bounty.id}`, s.id);
      }
      toast("Session started — keep your phone on you", { variant: "success" });
    } catch {
      toast("Couldn't start session", { variant: "error" });
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col">
      <ScreenHeader
        title={session ? "Task in progress" : "Start task"}
        subtitle={bounty?.title}
      />

      <div className="px-4 pt-2 flex-1">
        {/* Hero state card */}
        <Card className="p-5 relative overflow-hidden">
          {!session ? (
            <PreStartHero onSite={onSite} distance={distance} />
          ) : (
            <ActiveHero nonce={session.nonce} pingCount={pings.length} />
          )}
        </Card>

        {/* Status row */}
        <div className="grid grid-cols-3 gap-2 mt-3">
          <StatusTile
            icon={<LocationIcon width={14} height={14} />}
            label="Distance"
            value={distance !== null ? formatDistance(distance) : "—"}
            tone={onSite ? "ok" : "warn"}
          />
          <StatusTile
            icon={<SignalIcon width={14} height={14} />}
            label="GPS pings"
            value={`${pings.length}`}
            tone={session ? "ok" : "neutral"}
          />
          <StatusTile
            icon={<ClockIcon width={14} height={14} />}
            label="Elapsed"
            value={
              session
                ? `${Math.floor(minutesElapsed)}m`
                : "—"
            }
            tone="neutral"
          />
        </div>

        {/* Tips */}
        <div className="mt-5">
          <h3 className="text-sm font-semibold tracking-tight mb-2">Tips</h3>
          <Card className="p-4 grid gap-2.5">
            <Tip>Keep your phone in your pocket — we sample motion to confirm a human is on site.</Tip>
            <Tip>Stay within 25 m of the pin until you tap Finish &amp; Verify.</Tip>
            <Tip>Pause if you need to leave; coming back inside the window resumes naturally.</Tip>
          </Card>
        </div>

        <div className="h-32" />
      </div>

      <div
        className="fixed bottom-0 left-0 right-0 mx-auto max-w-[480px] bg-white/95 backdrop-blur border-t border-[color:var(--color-border)] px-4 pt-3 z-30"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 12px)" }}
      >
        {!session ? (
          <Button
            fullWidth
            size="xl"
            disabled={!onSite}
            loading={starting}
            iconRight={<ArrowRightIcon width={18} height={18} />}
            onClick={onStart}
          >
            {onSite ? "Start task" : "Move closer to start"}
          </Button>
        ) : (
          <div className="grid grid-cols-1 gap-2">
            <Button
              fullWidth
              size="xl"
              iconRight={<ArrowRightIcon width={18} height={18} />}
              onClick={() => router.push(`/bounty/${id}/verify`)}
            >
              Finish &amp; verify
            </Button>
            <p className="text-center text-[11px] text-[color:var(--color-muted)]">
              Verification compares your video to the poster&rsquo;s reference.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function PreStartHero({
  onSite,
  distance,
}: {
  onSite: boolean;
  distance: number | null;
}) {
  return (
    <>
      <div className="flex items-start justify-between">
        <div>
          <Badge tone={onSite ? "brand" : "amber"} size="sm">
            {onSite ? "On site" : "Not on site yet"}
          </Badge>
          <h2 className="text-[20px] font-semibold tracking-tight mt-2 leading-tight">
            {onSite
              ? "You're at the bounty location"
              : "Walk to the pin to begin"}
          </h2>
          <p className="text-sm text-[color:var(--color-muted)] mt-1.5">
            {onSite
              ? "Tap Start Task when you're ready. We'll begin a verified session and start GPS logging."
              : distance !== null
              ? `You're ${formatDistance(distance)} away. Get within 75 m to start.`
              : "Waiting for GPS…"}
          </p>
        </div>
        <span className="grid place-items-center w-12 h-12 rounded-full bg-[color:var(--color-brand-50)] text-[color:var(--color-brand-600)]">
          <CompassIcon width={22} height={22} />
        </span>
      </div>
    </>
  );
}

function ActiveHero({
  nonce,
  pingCount,
}: {
  nonce: string;
  pingCount: number;
}) {
  return (
    <>
      <div className="flex items-start justify-between">
        <div>
          <Badge tone="blue" size="sm" iconLeft={<span className="w-1.5 h-1.5 rounded-full bg-blue-600" />}>
            Tracking active
          </Badge>
          <h2 className="text-[20px] font-semibold tracking-tight mt-2 leading-tight">
            Session secured
          </h2>
          <p className="text-sm text-[color:var(--color-muted)] mt-1.5">
            We&rsquo;re recording GPS every 10 seconds. Your nonce will appear as a watermark on the verification video.
          </p>
        </div>
        <span className="grid place-items-center w-12 h-12 rounded-full bg-blue-50 text-blue-700">
          <ShieldCheckIcon width={22} height={22} />
        </span>
      </div>
      <div className="mt-4 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-[color:var(--color-muted)]">
          Nonce
        </span>
        <code className="font-mono text-sm tabular px-2.5 py-1 rounded-[8px] bg-[color:var(--color-surface)] border border-[color:var(--color-border)]">
          {nonce}
        </code>
        <span className="ml-auto text-[11px] text-[color:var(--color-muted)] tabular">
          {pingCount} ping{pingCount === 1 ? "" : "s"}
        </span>
      </div>
    </>
  );
}

function StatusTile({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: "ok" | "warn" | "neutral";
}) {
  const toneClass =
    tone === "ok"
      ? "bg-[color:var(--color-brand-50)] text-[color:var(--color-brand-700)] ring-[color:var(--color-brand-100)]"
      : tone === "warn"
      ? "bg-amber-50 text-amber-700 ring-amber-100"
      : "bg-[color:var(--color-surface)] text-[color:var(--color-ink)] ring-[color:var(--color-border)]";
  return (
    <div className={`rounded-[14px] px-3 py-2.5 ring-1 ring-inset ${toneClass}`}>
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider opacity-90">
        {icon} <span>{label}</span>
      </div>
      <p className="text-sm font-semibold tabular mt-0.5">{value}</p>
    </div>
  );
}

function Tip({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className="mt-1.5 inline-block w-1.5 h-1.5 rounded-full bg-[color:var(--color-brand-500)]" />
      <span className="text-[color:var(--color-ink-2)] leading-snug">{children}</span>
    </div>
  );
}
