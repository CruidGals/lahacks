import { ReactNode } from "react";

type Tone =
  | "brand"
  | "amber"
  | "blue"
  | "violet"
  | "rose"
  | "neutral"
  | "muted";

const toneClass: Record<Tone, string> = {
  brand:
    "bg-[color:var(--color-brand-50)] text-[color:var(--color-brand-700)] ring-[color:var(--color-brand-100)]",
  amber: "bg-amber-50 text-amber-700 ring-amber-100",
  blue: "bg-blue-50 text-blue-700 ring-blue-100",
  violet: "bg-violet-50 text-violet-700 ring-violet-100",
  rose: "bg-rose-50 text-rose-700 ring-rose-100",
  neutral: "bg-zinc-100 text-zinc-700 ring-zinc-200",
  muted: "bg-[color:var(--color-surface)] text-[color:var(--color-muted)] ring-[color:var(--color-border)]",
};

export function Badge({
  children,
  tone = "brand",
  size = "md",
  iconLeft,
  className = "",
}: {
  children: ReactNode;
  tone?: Tone;
  size?: "sm" | "md";
  iconLeft?: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full ring-1 ring-inset font-medium ${
        size === "sm"
          ? "px-2 py-0.5 text-[11px]"
          : "px-2.5 py-1 text-xs"
      } ${toneClass[tone]} ${className}`}
    >
      {iconLeft}
      {children}
    </span>
  );
}
