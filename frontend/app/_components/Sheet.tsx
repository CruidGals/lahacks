"use client";

import { ReactNode, useEffect } from "react";
import { CloseIcon } from "./icons";

export function Sheet({
  open,
  onClose,
  title,
  children,
  maxHeight = "90dvh",
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  maxHeight?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col">
      <button
        aria-label="Close"
        onClick={onClose}
        className="flex-1 bg-black/40 fade-in"
      />
      <div
        className="bg-white rounded-t-[24px] sheet-up shadow-[0_-12px_32px_rgba(16,24,40,0.12)] overflow-hidden mx-auto w-full max-w-[480px]"
        style={{
          maxHeight,
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        <div className="flex items-center justify-center pt-2.5">
          <div className="w-10 h-1.5 rounded-full bg-[color:var(--color-border-strong)]" />
        </div>
        {title && (
          <div className="flex items-center justify-between px-5 pt-3 pb-1">
            <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
            <button
              onClick={onClose}
              className="grid place-items-center w-9 h-9 rounded-full hover:bg-[color:var(--color-surface)]"
              aria-label="Close"
            >
              <CloseIcon width={18} height={18} />
            </button>
          </div>
        )}
        <div className="overflow-y-auto scroll-clean" style={{ maxHeight: `calc(${maxHeight} - 64px)` }}>
          {children}
        </div>
      </div>
    </div>
  );
}
