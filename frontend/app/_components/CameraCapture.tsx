"use client";

import { useEffect, useRef, useState } from "react";
import { CameraIcon, CloseIcon, CompassIcon } from "./icons";

type Phase = "idle" | "recording" | "captured" | "error";

/**
 * Mobile capture surface.
 * - Tries to get a live MediaStream (rear camera) for realism.
 * - Falls back to a stylized "camera unavailable" state on desktop or denied permissions.
 * - Renders the ghost overlay (poster's reference) and a nonce watermark.
 * - Records up to 15 s, then surfaces a Submit affordance.
 */
export function CameraCapture({
  nonce,
  category,
  onSubmit,
  onCancel,
  submitting,
}: {
  nonce: string;
  category?: string;
  onSubmit: () => void;
  onCancel: () => void;
  submitting?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [angle, setAngle] = useState(0);
  const streamRef = useRef<MediaStream | null>(null);
  const recordTimerRef = useRef<number | null>(null);
  const angleTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function init() {
      if (typeof navigator === "undefined") return;
      if (!navigator.mediaDevices?.getUserMedia) {
        setPermissionError("Camera unavailable on this browser");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Camera permission denied";
        setPermissionError(message);
      }
    }
    init();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (recordTimerRef.current !== null) {
        window.clearInterval(recordTimerRef.current);
      }
      if (angleTimerRef.current !== null) {
        window.clearInterval(angleTimerRef.current);
      }
    };
  }, []);

  const startRecording = () => {
    setPhase("recording");
    setRecordSeconds(0);
    setAngle(0);
    recordTimerRef.current = window.setInterval(() => {
      setRecordSeconds((s) => {
        if (s >= 15) {
          stopRecording();
          return 15;
        }
        return s + 1;
      });
    }, 1000);
    angleTimerRef.current = window.setInterval(() => {
      setAngle((a) => (a + 6) % 360);
    }, 250);
  };

  const stopRecording = () => {
    if (recordTimerRef.current !== null) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    if (angleTimerRef.current !== null) {
      window.clearInterval(angleTimerRef.current);
      angleTimerRef.current = null;
    }
    setPhase("captured");
  };

  const reset = () => {
    setPhase("idle");
    setRecordSeconds(0);
    setAngle(0);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black mx-auto max-w-[480px]">
      {/* Live preview */}
      <div className="absolute inset-0 overflow-hidden">
        {permissionError ? (
          <FakeCameraBackdrop category={category} />
        ) : (
          <video
            ref={videoRef}
            playsInline
            muted
            className="absolute inset-0 w-full h-full object-cover"
          />
        )}
      </div>

      {/* Ghost overlay — faded poster reference */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ opacity: phase === "captured" ? 0.18 : 0.32 }}
      >
        <GhostOverlay category={category} />
      </div>

      {/* Targeting reticle / framing guides */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute left-[6%] right-[6%] top-[18%] bottom-[18%] border border-white/40 rounded-[24px]" />
        <div className="absolute left-[22%] right-[22%] top-[28%] bottom-[28%] border border-white/20 rounded-[16px]" />
      </div>

      {/* Nonce watermark */}
      <div
        className="absolute right-3 select-none pointer-events-none"
        style={{ bottom: "120px" }}
      >
        <div className="px-2.5 py-1.5 rounded-[8px] bg-black/55 text-white font-mono text-[11px] tracking-wider tabular backdrop-blur">
          NONCE · {nonce}
          <span className="block opacity-70 text-[10px]">
            {new Date().toLocaleTimeString([], { hour12: false })}
          </span>
        </div>
      </div>

      {/* Top chrome */}
      <div
        className="absolute left-0 right-0 top-0 px-3 flex items-center justify-between"
        style={{ paddingTop: "calc(env(safe-area-inset-top) + 10px)" }}
      >
        <button
          onClick={onCancel}
          aria-label="Cancel"
          className="grid place-items-center w-10 h-10 rounded-full bg-black/45 text-white backdrop-blur"
        >
          <CloseIcon width={18} height={18} />
        </button>
        <div className="px-3 py-1.5 rounded-full bg-black/45 text-white text-xs font-medium backdrop-blur flex items-center gap-1.5">
          {phase === "recording" ? (
            <>
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <span className="tabular">REC {String(recordSeconds).padStart(2, "0")}s / 15s</span>
            </>
          ) : phase === "captured" ? (
            <>
              <span className="w-2 h-2 rounded-full bg-[color:var(--color-brand-400)]" />
              Captured
            </>
          ) : (
            <>
              <span className="w-2 h-2 rounded-full bg-white/70" />
              Align with ghost
            </>
          )}
        </div>
        <span className="w-10" />
      </div>

      {/* Compass / pan progress during recording */}
      {phase === "recording" && (
        <div className="absolute left-1/2 -translate-x-1/2 top-[80px] flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/50 backdrop-blur text-white text-xs">
          <CompassIcon width={14} height={14} style={{ transform: `rotate(${angle}deg)` }} />
          <span className="tabular">Pan slowly: {angle}°</span>
        </div>
      )}

      {/* Bottom controls */}
      <div
        className="absolute left-0 right-0 bottom-0 px-6 flex items-center justify-between"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 16px)" }}
      >
        <span className="w-12" />
        {phase === "idle" && (
          <button
            aria-label="Start recording"
            onClick={startRecording}
            className="grid place-items-center w-[72px] h-[72px] rounded-full bg-white"
          >
            <span className="block w-[58px] h-[58px] rounded-full bg-[color:var(--color-brand-500)]" />
          </button>
        )}
        {phase === "recording" && (
          <button
            aria-label="Stop recording"
            onClick={stopRecording}
            className="grid place-items-center w-[72px] h-[72px] rounded-full bg-white"
          >
            <span className="block w-[28px] h-[28px] rounded-[6px] bg-[color:var(--color-rose)]" />
          </button>
        )}
        {phase === "captured" && (
          <div className="flex flex-col items-center gap-2 w-full">
            <button
              onClick={onSubmit}
              disabled={submitting}
              className="w-full h-14 rounded-[16px] bg-[color:var(--color-brand-500)] text-white font-semibold shadow-[var(--shadow-cta)] disabled:opacity-60"
            >
              {submitting ? "Submitting…" : "Submit for verification"}
            </button>
            <button
              onClick={reset}
              className="text-white/85 text-sm font-medium underline-offset-4 hover:underline"
            >
              Retake
            </button>
          </div>
        )}
        {phase !== "captured" && <span className="w-12 text-white/70 text-xs text-right">{ /* placeholder */ }</span>}
      </div>

      {/* Bottom hint banner */}
      {phase === "idle" && (
        <div className="absolute left-1/2 -translate-x-1/2" style={{ bottom: "calc(env(safe-area-inset-bottom) + 110px)" }}>
          <div className="px-3 py-1.5 rounded-full bg-black/55 text-white text-[11px] backdrop-blur flex items-center gap-1.5">
            <CameraIcon width={12} height={12} />
            Match the framing of the faded reference, then tap to record
          </div>
        </div>
      )}
    </div>
  );
}

function FakeCameraBackdrop({ category }: { category?: string }) {
  // when real camera is unavailable, render a believable scene
  return (
    <div
      className="absolute inset-0"
      style={{
        background:
          category === "beach"
            ? "linear-gradient(180deg, #2dd4bf 0%, #fde68a 70%, #f59e0b 100%)"
            : category === "graffiti"
            ? "linear-gradient(180deg, #1f2937 0%, #4b5563 100%)"
            : "linear-gradient(180deg, #166534 0%, #65a30d 100%)",
      }}
    />
  );
}

function GhostOverlay({ category }: { category?: string }) {
  return (
    <div className="absolute inset-0 grid place-items-center">
      <div
        className="w-[80%] aspect-[16/10] rounded-[24px]"
        style={{
          backgroundImage: `linear-gradient(135deg, ${
            category === "beach"
              ? "#bae6fd, #fcd34d"
              : category === "graffiti"
              ? "#a78bfa, #f472b6"
              : "#bbf7d0, #86efac"
          })`,
          mixBlendMode: "screen",
        }}
      />
    </div>
  );
}
