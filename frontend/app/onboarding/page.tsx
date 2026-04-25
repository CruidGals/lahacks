"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ButtonLink } from "../_components/Button";
import { Card } from "../_components/Card";
import {
  ArrowRightIcon,
  CheckIcon,
  LeafIcon,
  ShieldCheckIcon,
  SparkleIcon,
} from "../_components/icons";
import { verifyWorldId } from "../../lib/api";
import { useToast } from "../_components/Toast";

export default function OnboardingPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [step, setStep] = useState<"intro" | "verify" | "done">("intro");
  const [loading, setLoading] = useState(false);

  const onVerify = async () => {
    setLoading(true);
    try {
      await verifyWorldId();
      setStep("done");
      toast("Verified as a unique human", { variant: "success" });
    } catch {
      toast("Couldn't verify — try again", { variant: "error" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="flex-1 flex flex-col px-6 pb-6"
      style={{ paddingTop: "calc(env(safe-area-inset-top) + 16px)" }}
    >
      <div className="flex items-center gap-2">
        <span className="grid place-items-center w-8 h-8 rounded-full bg-[color:var(--color-brand-500)] text-white">
          <LeafIcon width={16} height={16} />
        </span>
        <span className="text-sm font-semibold tracking-tight">Cleanr</span>
      </div>

      <div className="flex-1 flex flex-col justify-center">
        {step === "intro" && <Intro onContinue={() => setStep("verify")} />}
        {step === "verify" && (
          <VerifyStep loading={loading} onVerify={onVerify} />
        )}
        {step === "done" && (
          <DoneStep onContinue={() => router.replace("/")} />
        )}
      </div>

      <div className="grid gap-2">
        {step === "intro" && (
          <Button
            fullWidth
            size="xl"
            iconRight={<ArrowRightIcon width={18} height={18} />}
            onClick={() => setStep("verify")}
          >
            Get started
          </Button>
        )}
        {step === "verify" && (
          <>
            <Button
              fullWidth
              size="xl"
              loading={loading}
              iconLeft={<SparkleIcon width={18} height={18} />}
              onClick={onVerify}
            >
              Verify with World ID
            </Button>
            <ButtonLink href="/" fullWidth size="xl" variant="ghost">
              Skip for now
            </ButtonLink>
          </>
        )}
        {step === "done" && (
          <Button
            fullWidth
            size="xl"
            iconRight={<ArrowRightIcon width={18} height={18} />}
            onClick={() => router.replace("/")}
          >
            Open the map
          </Button>
        )}
      </div>
    </div>
  );
}

function Intro({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="space-y-6 max-w-[360px] mx-auto text-center">
      <span className="grid place-items-center w-20 h-20 rounded-[28px] bg-[color:var(--color-brand-50)] text-[color:var(--color-brand-600)] mx-auto">
        <LeafIcon width={36} height={36} />
      </span>
      <div>
        <h1 className="text-[28px] font-semibold tracking-tight leading-tight">
          Get paid in Solana for cleaning your city
        </h1>
        <p className="text-sm text-[color:var(--color-muted)] mt-2 leading-relaxed">
          Communities post the work. You do it. AI verifies. The smart contract pays you in seconds.
        </p>
      </div>

      <div className="grid gap-2 text-left">
        <Bullet
          icon={<ShieldCheckIcon width={18} height={18} />}
          title="Verified by AI"
          desc="GPS, video and motion checks before any payout."
        />
        <Bullet
          icon={<SparkleIcon width={18} height={18} />}
          title="World ID gated"
          desc="One human, one account. No bots, no farms."
        />
        <Bullet
          icon={<CheckIcon width={18} height={18} />}
          title="Instant payouts"
          desc="Sub-cent fees on Solana — even tiny bounties make sense."
        />
      </div>
      <button
        onClick={onContinue}
        className="hidden"
        aria-hidden
      />
    </div>
  );
}

function VerifyStep({
  loading,
  onVerify,
}: {
  loading: boolean;
  onVerify: () => void;
}) {
  return (
    <div className="space-y-5 max-w-[380px] mx-auto text-center">
      <div className="relative grid place-items-center mx-auto">
        <span
          className="absolute inset-0 m-auto w-32 h-32 rounded-full bg-[color:var(--color-brand-100)] opacity-60 pulse-ring"
          aria-hidden
        />
        <span className="relative grid place-items-center w-20 h-20 rounded-full bg-[color:var(--color-brand-500)] text-white">
          <ShieldCheckIcon width={36} height={36} />
        </span>
      </div>
      <h2 className="text-[24px] font-semibold tracking-tight leading-tight">
        Prove you&rsquo;re human
      </h2>
      <p className="text-sm text-[color:var(--color-muted)] leading-relaxed">
        World ID confirms you&rsquo;re a unique person without revealing who you are.
        Cleanr never sees your identity — just the proof.
      </p>
      <Card className="p-4 text-left">
        <ul className="grid gap-2.5">
          <Why icon={<CheckIcon width={14} height={14} />}>
            We never store biometric data.
          </Why>
          <Why icon={<CheckIcon width={14} height={14} />}>
            Verification is one-time per account.
          </Why>
          <Why icon={<CheckIcon width={14} height={14} />}>
            You stay anonymous to other users.
          </Why>
        </ul>
      </Card>
      <button
        onClick={onVerify}
        disabled={loading}
        className="hidden"
        aria-hidden
      />
    </div>
  );
}

function DoneStep({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="space-y-5 max-w-[360px] mx-auto text-center">
      <span className="grid place-items-center w-20 h-20 rounded-full bg-[color:var(--color-brand-500)] text-white mx-auto">
        <CheckIcon width={36} height={36} />
      </span>
      <h2 className="text-[24px] font-semibold tracking-tight leading-tight">
        You&rsquo;re verified
      </h2>
      <p className="text-sm text-[color:var(--color-muted)] leading-relaxed">
        Welcome aboard. Let&rsquo;s find you a bounty nearby.
      </p>
      <button onClick={onContinue} className="hidden" aria-hidden />
    </div>
  );
}

function Bullet({
  icon,
  title,
  desc,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <div className="flex items-start gap-3 px-4 py-3 rounded-[14px] bg-white border border-[color:var(--color-border)]">
      <span className="grid place-items-center w-9 h-9 rounded-full bg-[color:var(--color-brand-50)] text-[color:var(--color-brand-700)] shrink-0">
        {icon}
      </span>
      <div className="flex-1 min-w-0 text-left">
        <p className="text-sm font-semibold leading-tight">{title}</p>
        <p className="text-xs text-[color:var(--color-muted)] leading-snug mt-0.5">
          {desc}
        </p>
      </div>
    </div>
  );
}

function Why({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-2 text-sm text-[color:var(--color-ink-2)]">
      <span className="mt-0.5 grid place-items-center w-5 h-5 rounded-full bg-[color:var(--color-brand-500)] text-white">
        {icon}
      </span>
      <span className="leading-snug">{children}</span>
    </li>
  );
}
