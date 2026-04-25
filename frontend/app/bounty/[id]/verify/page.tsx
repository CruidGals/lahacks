"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CameraCapture } from "../../../_components/CameraCapture";
import { getBounty, getSession, submitCleanup } from "../../../../lib/api";
import type { Bounty, Session, VerificationResult } from "../../../../lib/types";
import { useToast } from "../../../_components/Toast";

export default function VerifyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { toast } = useToast();
  const [bounty, setBounty] = useState<Bounty | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    getBounty(id).then(setBounty);
    if (typeof window === "undefined") return;
    const sid = window.localStorage.getItem(`cleanr.session.${id}`);
    if (sid) getSession(sid).then((s) => s && setSession(s));
  }, [id]);

  const onSubmit = async () => {
    if (!session || !bounty) return;
    setSubmitting(true);

    // Persist what we'd submit so the verifying screen can pick it up.
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        `cleanr.pending.${id}`,
        JSON.stringify({ session_id: session.id, started_at: Date.now() })
      );
    }
    router.push(`/bounty/${id}/submitted`);

    // Fire the actual verification call in the background; the submitted
    // page polls localStorage for the result.
    submitCleanup({
      session_id: session.id,
      bounty_id: bounty.id,
      video_blob_url: "blob:fake",
      end_lat: bounty.lat,
      end_lng: bounty.lng,
      ended_at: new Date().toISOString(),
    })
      .then((result: { verification: VerificationResult }) => {
        if (typeof window !== "undefined") {
          window.localStorage.setItem(
            `cleanr.result.${id}`,
            JSON.stringify(result.verification)
          );
        }
      })
      .catch(() => {
        toast("Verification failed", { variant: "error" });
      })
      .finally(() => setSubmitting(false));
  };

  if (!session) {
    return (
      <div className="flex-1 grid place-items-center px-6 text-center">
        <div>
          <h2 className="text-lg font-semibold">No active session</h2>
          <p className="text-sm text-[color:var(--color-muted)] mt-1">
            Start the task before verifying.
          </p>
        </div>
      </div>
    );
  }

  return (
    <CameraCapture
      nonce={session.nonce}
      category={bounty?.category}
      submitting={submitting}
      onCancel={() => router.back()}
      onSubmit={onSubmit}
    />
  );
}
