"use client";

import { ReactNode, useState } from "react";
import { Sheet } from "./Sheet";
import { Button, ButtonLink } from "./Button";
import { ShieldCheckIcon, SparkleIcon } from "./icons";
import { useToast } from "./Toast";
import { verifyWorldId } from "../../lib/api";

/**
 * Mocked World ID verification gate.
 * Wraps a CTA — clicking it triggers the World ID flow if not verified yet.
 */
export function WorldIdGate({
  verified,
  onVerified,
  children,
}: {
  verified: boolean;
  onVerified: () => void;
  children: (props: { onAttempt: () => void; verified: boolean }) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const { toast } = useToast();

  const onAttempt = () => {
    if (verified) return;
    setOpen(true);
  };

  const runVerify = async () => {
    setVerifying(true);
    try {
      await verifyWorldId();
      onVerified();
      setOpen(false);
      toast("Verified as a unique human", { variant: "success" });
    } catch {
      toast("Verification failed — try again", { variant: "error" });
    } finally {
      setVerifying(false);
    }
  };

  return (
    <>
      {children({ onAttempt, verified })}
      <Sheet open={open} onClose={() => setOpen(false)} title="Verify with World ID">
        <div className="px-5 pb-6">
          <div className="grid place-items-center w-16 h-16 rounded-full bg-[color:var(--color-brand-50)] text-[color:var(--color-brand-600)] mx-auto mt-2">
            <ShieldCheckIcon width={28} height={28} />
          </div>
          <h3 className="text-center text-[18px] font-semibold tracking-tight mt-4">
            One human, one account
          </h3>
          <p className="text-center text-sm text-[color:var(--color-muted)] mt-1.5 max-w-[320px] mx-auto">
            EcoBounty requires World ID verification before your first claim. This
            blocks bot farms and gives funders confidence their bounties go to a
            real person.
          </p>

          <div className="mt-5 grid gap-2.5">
            <Reason>Doesn&rsquo;t share your identity — only that you&rsquo;re a unique human.</Reason>
            <Reason>Takes ~10 seconds with Worldcoin Orb or App.</Reason>
            <Reason>Required only once per account.</Reason>
          </div>

          <div className="mt-5 grid gap-2">
            <Button
              fullWidth
              size="lg"
              loading={verifying}
              iconLeft={<SparkleIcon width={18} height={18} />}
              onClick={runVerify}
            >
              Verify now
            </Button>
            <ButtonLink
              href="/onboarding"
              fullWidth
              size="lg"
              variant="ghost"
              onClick={() => setOpen(false)}
            >
              Learn more
            </ButtonLink>
          </div>
        </div>
      </Sheet>
    </>
  );
}

function Reason({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className="mt-1 inline-block w-1.5 h-1.5 rounded-full bg-[color:var(--color-brand-500)]" />
      <span className="text-[color:var(--color-ink-2)]">{children}</span>
    </div>
  );
}
