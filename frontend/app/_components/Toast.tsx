"use client";

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { CheckIcon, CloseIcon } from "./icons";

type ToastVariant = "success" | "error" | "info";

type Toast = {
  id: number;
  message: string;
  variant: ToastVariant;
  description?: string;
};

type Ctx = {
  toast: (
    message: string,
    opts?: { variant?: ToastVariant; description?: string; durationMs?: number }
  ) => void;
};

const ToastCtx = createContext<Ctx | null>(null);

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const remove = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const toast = useCallback<Ctx["toast"]>(
    (message, opts) => {
      const id = ++idRef.current;
      const t: Toast = {
        id,
        message,
        variant: opts?.variant ?? "info",
        description: opts?.description,
      };
      setToasts((prev) => [...prev, t]);
      const dur = opts?.durationMs ?? 3500;
      window.setTimeout(() => remove(id), dur);
    },
    [remove]
  );

  return (
    <ToastCtx.Provider value={{ toast }}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2 px-4"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onClose={() => remove(t.id)} />
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

function ToastItem({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  useEffect(() => {
    // small mount transition
  }, []);

  const colorClass =
    toast.variant === "success"
      ? "bg-[color:var(--color-brand-500)] text-white"
      : toast.variant === "error"
      ? "bg-[color:var(--color-rose)] text-white"
      : "bg-[color:var(--color-ink)] text-white";

  return (
    <div
      className={`pointer-events-auto fade-in flex items-start gap-3 max-w-[420px] w-full rounded-[14px] px-4 py-3 shadow-[var(--shadow-pop)] ${colorClass}`}
    >
      {toast.variant === "success" && (
        <span className="mt-0.5 inline-grid place-items-center w-5 h-5 rounded-full bg-white/20">
          <CheckIcon width={14} height={14} />
        </span>
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold leading-tight">{toast.message}</p>
        {toast.description && (
          <p className="text-xs opacity-90 mt-0.5">{toast.description}</p>
        )}
      </div>
      <button
        onClick={onClose}
        className="opacity-80 hover:opacity-100 transition-opacity"
        aria-label="Dismiss"
      >
        <CloseIcon width={16} height={16} />
      </button>
    </div>
  );
}
