"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CameraIcon, CloseIcon, CompassIcon } from "./icons";

type Phase = "idle" | "recording" | "captured" | "error";

const MAX_RECORD_SECONDS = 15;

const MIME_PREFERENCES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4;codecs=h264,aac",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

function pickMimeType(): string | undefined {
  if (typeof window === "undefined" || typeof MediaRecorder === "undefined") {
    return undefined;
  }
  for (const candidate of MIME_PREFERENCES) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    } catch {
    }
  }
  return undefined;
}

/**
 * Mobile capture surface.
 *
 * - Acquires the rear camera via getUserMedia.
 * - Records up to {@link MAX_RECORD_SECONDS} seconds with MediaRecorder, then
 *   surfaces the captured Blob through `onSubmit(blob)`.
 * - Submit is disabled until a recording exists; the parent can additionally
 *   set `submitting` to lock the button while the upload + cleanup POST run.
 * - Falls back to a stylized "camera unavailable" state on desktop or denied
 *   permissions; in that mode we cannot produce a Blob, so submit stays
 *   disabled.
 */
export function CameraCapture({
  nonce,
  category,
  onSubmit,
  onCancel,
  submitting,
  submitLabel = "Submit for verification",
  submittingLabel = "Submitting…",
  hint = "Match the framing of the faded reference, then tap to record",
}: {
  nonce: string;
  category?: string;
  onSubmit: (blob: Blob) => void | Promise<void>;
  onCancel: () => void;
  submitting?: boolean;
  submitLabel?: string;
  submittingLabel?: string;
  hint?: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playbackRef = useRef<HTMLVideoElement | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [angle, setAngle] = useState(0);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recorderError, setRecorderError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const recorderMimeRef = useRef<string | undefined>(undefined);
  const recordTimerRef = useRef<number | null>(null);
  const angleTimerRef = useRef<number | null>(null);

  const playbackUrl = useMemo(
    () => (recordedBlob ? URL.createObjectURL(recordedBlob) : null),
    [recordedBlob]
  );

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
          audio: true,
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
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        try {
          recorderRef.current.stop();
        } catch {
        }
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (recordTimerRef.current !== null) {
        window.clearInterval(recordTimerRef.current);
      }
      if (angleTimerRef.current !== null) {
        window.clearInterval(angleTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (playbackUrl) URL.revokeObjectURL(playbackUrl);
    };
  }, [playbackUrl]);

  const stopTimers = () => {
    if (recordTimerRef.current !== null) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    if (angleTimerRef.current !== null) {
      window.clearInterval(angleTimerRef.current);
      angleTimerRef.current = null;
    }
  };

  const startRecording = () => {
    setRecorderError(null);
    setRecordedBlob(null);
    chunksRef.current = [];

    const stream = streamRef.current;
    if (!stream) {
      setRecorderError("Camera stream is not ready yet.");
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      setRecorderError("This browser does not support video recording.");
      return;
    }

    const mimeType = pickMimeType();
    recorderMimeRef.current = mimeType;

    let recorder: MediaRecorder;
    try {
      recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
    } catch (err: unknown) {
      setRecorderError(
        err instanceof Error
          ? err.message
          : "Could not start the video recorder."
      );
      return;
    }

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        chunksRef.current.push(event.data);
      }
    };
    recorder.onerror = (event) => {
      const detail =
        (event as unknown as { error?: { message?: string } }).error?.message ??
        "Recorder error";
      setRecorderError(detail);
    };
    recorder.onstop = () => {
      const type = recorderMimeRef.current ?? recorder.mimeType ?? "video/mp4";
      const blob = new Blob(chunksRef.current, { type });
      chunksRef.current = [];
      if (blob.size === 0) {
        setRecorderError("Recording produced no data. Try again.");
        setPhase("idle");
        return;
      }
      setRecordedBlob(blob);
      setPhase("captured");
    };

    recorderRef.current = recorder;
    setPhase("recording");
    setRecordSeconds(0);
    setAngle(0);

    try {
      recorder.start(500);
    } catch (err: unknown) {
      setRecorderError(
        err instanceof Error
          ? err.message
          : "Could not start the video recorder."
      );
      setPhase("idle");
      return;
    }

    recordTimerRef.current = window.setInterval(() => {
      setRecordSeconds((s) => {
        const next = s + 1;
        if (next >= MAX_RECORD_SECONDS) {
          stopRecording();
          return MAX_RECORD_SECONDS;
        }
        return next;
      });
    }, 1000);
    angleTimerRef.current = window.setInterval(() => {
      setAngle((a) => (a + 6) % 360);
    }, 250);
  };

  const stopRecording = () => {
    stopTimers();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch (err: unknown) {
        setRecorderError(
          err instanceof Error ? err.message : "Failed to stop recorder."
        );
      }
    }
  };

  const reset = () => {
    setPhase("idle");
    setRecordSeconds(0);
    setAngle(0);
    setRecordedBlob(null);
    setRecorderError(null);
    chunksRef.current = [];
  };

  const handleSubmit = () => {
    if (!recordedBlob) return;
    void onSubmit(recordedBlob);
  };

  const submitDisabled = !recordedBlob || !!submitting;

  return (
    <div className="fixed inset-0 z-50 bg-black mx-auto max-w-[480px]">
      {/* Live preview / playback */}
      <div className="absolute inset-0 overflow-hidden">
        {permissionError ? (
          <FakeCameraBackdrop category={category} />
        ) : phase === "captured" && playbackUrl ? (
          <video
            ref={playbackRef}
            src={playbackUrl}
            playsInline
            muted
            loop
            autoPlay
            className="absolute inset-0 w-full h-full object-cover"
          />
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
              <span className="tabular">
                REC {String(recordSeconds).padStart(2, "0")}s / {MAX_RECORD_SECONDS}s
              </span>
            </>
          ) : phase === "captured" ? (
            <>
              <span className="w-2 h-2 rounded-full bg-[color:var(--color-brand-400)]" />
              Captured · {recordedBlob ? `${(recordedBlob.size / (1024 * 1024)).toFixed(1)} MB` : "—"}
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

      {/* Recorder / permission errors */}
      {(recorderError || permissionError) && (
        <div className="absolute left-1/2 -translate-x-1/2 top-[120px] max-w-[88%] px-3 py-2 rounded-[12px] bg-black/70 text-white text-xs text-center backdrop-blur">
          {recorderError ?? permissionError}
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
            disabled={!!permissionError}
            className="grid place-items-center w-[72px] h-[72px] rounded-full bg-white disabled:opacity-50"
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
              onClick={handleSubmit}
              disabled={submitDisabled}
              className="w-full h-14 rounded-[16px] bg-[color:var(--color-brand-500)] text-white font-semibold shadow-[var(--shadow-cta)] disabled:opacity-60"
            >
              {submitting
                ? submittingLabel
                : recordedBlob
                ? submitLabel
                : "Recording unavailable"}
            </button>
            <button
              onClick={reset}
              disabled={!!submitting}
              className="text-white/85 text-sm font-medium underline-offset-4 hover:underline disabled:opacity-50"
            >
              Retake
            </button>
          </div>
        )}
        {phase !== "captured" && <span className="w-12 text-white/70 text-xs text-right">{ /* placeholder */ }</span>}
      </div>

      {/* Bottom hint banner */}
      {phase === "idle" && !permissionError && (
        <div className="absolute left-1/2 -translate-x-1/2" style={{ bottom: "calc(env(safe-area-inset-bottom) + 110px)" }}>
          <div className="px-3 py-1.5 rounded-full bg-black/55 text-white text-[11px] backdrop-blur flex items-center gap-1.5">
            <CameraIcon width={12} height={12} />
            {hint}
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
            category === "beach" ? "#bae6fd, #fcd34d" : "#bbf7d0, #86efac"
          })`,
          mixBlendMode: "screen",
        }}
      />
    </div>
  );
}
