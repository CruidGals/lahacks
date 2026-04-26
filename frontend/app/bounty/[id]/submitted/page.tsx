"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ScreenHeader } from "../../../_components/ScreenHeader";
import { Card } from "../../../_components/Card";
import { Button, ButtonLink } from "../../../_components/Button";
import { Badge } from "../../../_components/Badge";
import {
  CheckIcon,
  CoinIcon,
  ShieldCheckIcon,
  SparkleIcon,
} from "../../../_components/icons";
import {
  buildVerificationResult,
  getBounty,
  getCleanup,
} from "../../../../lib/api";
import type { Bounty, VerificationResult } from "../../../../lib/types";
import { useToast } from "../../../_components/Toast";

const CHECK_LABELS = [
  "Receiving submission…",
  "Verifying GPS trajectory…",
  "Cross-checking cell location…",
  "Reading nonce watermark…",
  "Comparing against reference video…",
  "Detecting before/after change…",
  "Cross-referencing Street View…",
  "Releasing escrow on Solana…",
];

export default function SubmittedPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { toast } = useToast();
  const [bounty, setBounty] = useState<Bounty | null>(null);
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [stepIdx, setStepIdx] = useState(0);

  useEffect(() => {
    getBounty(id).then(setBounty);
  }, [id]);

  // Step animation while we wait on the verifier
  useEffect(() => {
    if (result) return;
    const t = window.setInterval(() => {
      setStepIdx((i) => Math.min(i + 1, CHECK_LABELS.length - 1));
    }, 450);
    return () => window.clearInterval(t);
  }, [result]);

  // Poll the backend for the cleanup status
  useEffect(() => {
    if (typeof window === "undefined") return;
    const cleanupId = window.localStorage.getItem(`cleanr.cleanup.${id}`);
    if (!cleanupId) return;

    let cancelled = false;
    const poll = async () => {
      try {
        const { raw } = await getCleanup(cleanupId);
        if (cancelled) return;
        const built = buildVerificationResult(raw);
        if (built) {
          setResult(built);
          return;
        }
      } catch {
        // keep polling — transient errors shouldn't kill the flow
      }
      if (!cancelled) window.setTimeout(poll, 1500);
    };

    poll();
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (result?.passed && bounty) {
      toast(`+${bounty.reward_sol.toFixed(2)} SOL paid out`, {
        variant: "success",
        description: result.reward_tx_signature
          ? `Tx ${result.reward_tx_signature.slice(0, 12)}…`
          : undefined,
      });
    }
  }, [result, bounty, toast]);

  return (
    <div className="flex-1 flex flex-col">
      <ScreenHeader
        title={result ? (result.passed ? "Verified" : "Needs review") : "Verifying"}
        onBack={() => router.replace("/")}
      />
      <div className="px-4 pt-2 flex-1 flex flex-col">
        <Card className="p-6 relative overflow-hidden">
          <div className="absolute -right-10 -top-10 w-40 h-40 rounded-full bg-[color:var(--color-brand-50)] blur-2xl opacity-70" />
          {!result && <VerifyingState stepIdx={stepIdx} />}
          {result?.passed && bounty && (
            <SuccessState bounty={bounty} result={result} />
          )}
          {result && !result.passed && <FailedState />}
        </Card>

        <div className="mt-4">
          <h3 className="text-sm font-semibold tracking-tight mb-2">
            Verification breakdown
          </h3>
          <Card className="p-4 grid gap-2.5">
            {(result?.checks ??
              CHECK_LABELS.slice(1, 7).map((label, i) => ({
                label,
                status: i <= stepIdx - 1 ? "pass" : "skipped",
              }))).map((c, i) => (
              <CheckRow
                key={i}
                label={c.label}
                detail={"detail" in c ? c.detail : undefined}
                status={c.status as "pass" | "fail" | "skipped"}
                pending={!result && i > stepIdx - 1}
              />
            ))}
          </Card>
        </div>

        <div className="h-32" />
      </div>

      <div
        className="fixed bottom-0 left-0 right-0 mx-auto max-w-[480px] bg-white/95 backdrop-blur border-t border-[color:var(--color-border)] px-4 pt-3 z-30"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 12px)" }}
      >
        {!result && (
          <Button fullWidth size="xl" disabled loading>
            Awaiting verifier
          </Button>
        )}
        {result?.passed && (
          <ButtonLink fullWidth size="xl" href="/profile">
            See payout in wallet
          </ButtonLink>
        )}
        {result && !result.passed && (
          <ButtonLink fullWidth size="xl" variant="secondary" href="/">
            Back to map
          </ButtonLink>
        )}
      </div>
    </div>
  );
}

function VerifyingState({ stepIdx }: { stepIdx: number }) {
  return (
    <div className="relative">
      <div className="flex items-center gap-3">
        <span className="grid place-items-center w-12 h-12 rounded-full bg-[color:var(--color-brand-50)] text-[color:var(--color-brand-600)] spin-slow">
          <SparkleIcon width={22} height={22} />
        </span>
        <div>
          <Badge tone="violet" size="sm">Running checks</Badge>
          <h2 className="text-[20px] font-semibold tracking-tight mt-1.5 leading-tight">
            Verifying your submission
          </h2>
        </div>
      </div>
      <p className="text-sm text-[color:var(--color-muted)] mt-3">
        {CHECK_LABELS[stepIdx]}
      </p>
      <div className="mt-3 h-1.5 rounded-full bg-[color:var(--color-surface)] overflow-hidden">
        <div
          className="h-full bg-[color:var(--color-brand-500)] transition-[width] duration-300"
          style={{ width: `${((stepIdx + 1) / CHECK_LABELS.length) * 100}%` }}
        />
      </div>
    </div>
  );
}

function SuccessState({
  bounty,
  result,
}: {
  bounty: Bounty;
  result: VerificationResult;
}) {
  return (
    <div className="relative">
      <div className="flex items-center gap-3">
        <span className="grid place-items-center w-12 h-12 rounded-full bg-[color:var(--color-brand-500)] text-white">
          <CheckIcon width={24} height={24} />
        </span>
        <div>
          <Badge tone="brand" size="sm">Paid out</Badge>
          <h2 className="text-[22px] font-semibold tracking-tight mt-1.5 leading-tight">
            +{bounty.reward_sol.toFixed(2)} SOL
          </h2>
        </div>
      </div>
      <p className="text-sm text-[color:var(--color-muted)] mt-3">
        Verified at <span className="tabular">{Math.round(result.confidence * 100)}%</span>{" "}
        confidence. Smart contract released the bounty to your wallet.
      </p>
      <div className="mt-3 flex items-center gap-2 text-xs">
        <CoinIcon width={14} height={14} className="text-[color:var(--color-brand-600)]" />
        <span className="text-[color:var(--color-muted)]">Tx</span>
        <code className="font-mono tabular text-[12px] px-2 py-0.5 rounded-[6px] bg-[color:var(--color-surface)] border border-[color:var(--color-border)]">
          {result.reward_tx_signature
            ? `${result.reward_tx_signature.slice(0, 12)}…`
            : "—"}
        </code>
      </div>
    </div>
  );
}

function FailedState() {
  return (
    <div>
      <div className="flex items-center gap-3">
        <span className="grid place-items-center w-12 h-12 rounded-full bg-rose-50 text-[color:var(--color-rose)]">
          <ShieldCheckIcon width={22} height={22} />
        </span>
        <div>
          <Badge tone="rose" size="sm">Needs review</Badge>
          <h2 className="text-[20px] font-semibold tracking-tight mt-1.5">
            We couldn&rsquo;t verify some checks
          </h2>
        </div>
      </div>
      <p className="text-sm text-[color:var(--color-muted)] mt-3">
        A human moderator will take a look within 24h. The bounty stays escrowed in the meantime.
      </p>
    </div>
  );
}

function CheckRow({
  label,
  detail,
  status,
  pending,
}: {
  label: string;
  detail?: string;
  status: "pass" | "fail" | "skipped";
  pending?: boolean;
}) {
  return (
    <div className="flex items-start gap-3">
      <span
        className={`mt-0.5 grid place-items-center w-5 h-5 rounded-full ${
          pending
            ? "bg-[color:var(--color-surface)] text-[color:var(--color-muted)]"
            : status === "pass"
            ? "bg-[color:var(--color-brand-500)] text-white"
            : status === "fail"
            ? "bg-[color:var(--color-rose)] text-white"
            : "bg-[color:var(--color-surface)] text-[color:var(--color-muted)]"
        }`}
      >
        {pending ? (
          <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
        ) : status === "pass" ? (
          <CheckIcon width={12} height={12} />
        ) : (
          <span className="text-[10px] font-bold">!</span>
        )}
      </span>
      <div className="flex-1">
        <p className="text-sm font-medium">{label}</p>
        {detail && (
          <p className="text-[12px] text-[color:var(--color-muted)] tabular">{detail}</p>
        )}
      </div>
    </div>
  );
}
