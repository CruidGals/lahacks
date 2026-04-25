"use client";

import { useRouter } from "next/navigation";
import { ReactNode } from "react";
import { ChevronLeftIcon } from "./icons";

export function ScreenHeader({
  title,
  subtitle,
  onBack,
  right,
  transparent,
}: {
  title?: string;
  subtitle?: string;
  onBack?: () => void;
  right?: ReactNode;
  transparent?: boolean;
}) {
  const router = useRouter();
  const handleBack = onBack ?? (() => router.back());

  return (
    <header
      className={`sticky top-0 z-30 ${
        transparent ? "bg-transparent" : "bg-white/95 backdrop-blur"
      } ${transparent ? "" : "border-b border-[color:var(--color-border)]"}`}
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <div className="h-14 flex items-center px-2 gap-1">
        <button
          onClick={handleBack}
          aria-label="Back"
          className="grid place-items-center w-10 h-10 rounded-full text-[color:var(--color-ink)] hover:bg-[color:var(--color-surface)] transition-colors"
        >
          <ChevronLeftIcon />
        </button>
        <div className="flex-1 min-w-0">
          {title && (
            <h1 className="text-[17px] font-semibold tracking-tight truncate">
              {title}
            </h1>
          )}
          {subtitle && (
            <p className="text-xs text-[color:var(--color-muted)] truncate -mt-0.5">
              {subtitle}
            </p>
          )}
        </div>
        {right && <div className="pr-2">{right}</div>}
      </div>
    </header>
  );
}
