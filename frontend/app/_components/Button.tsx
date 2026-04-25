"use client";

import { ButtonHTMLAttributes, forwardRef, ReactNode } from "react";
import Link from "next/link";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md" | "lg" | "xl";

const variantClass: Record<Variant, string> = {
  primary:
    "bg-[color:var(--color-brand-500)] text-white shadow-[var(--shadow-cta)] hover:bg-[color:var(--color-brand-600)] active:bg-[color:var(--color-brand-700)] disabled:bg-[color:var(--color-brand-200)] disabled:shadow-none",
  secondary:
    "bg-[color:var(--color-surface)] text-[color:var(--color-ink)] hover:bg-[color:var(--color-surface-2)] disabled:opacity-50",
  ghost:
    "bg-transparent text-[color:var(--color-ink)] hover:bg-[color:var(--color-surface)] disabled:opacity-50",
  outline:
    "bg-white text-[color:var(--color-ink)] border border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-surface)] disabled:opacity-50",
  danger:
    "bg-[color:var(--color-rose)] text-white hover:opacity-90 disabled:opacity-50",
};

const sizeClass: Record<Size, string> = {
  sm: "h-9 px-3 text-sm rounded-[10px]",
  md: "h-11 px-4 text-[15px] rounded-[12px]",
  lg: "h-12 px-5 text-base rounded-[14px]",
  xl: "h-14 px-6 text-base rounded-[16px]",
};

type CommonProps = {
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
  loading?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  children?: ReactNode;
};

type ButtonProps = CommonProps &
  ButtonHTMLAttributes<HTMLButtonElement> & { href?: undefined };

type LinkProps = CommonProps & {
  href: string;
  prefetch?: boolean;
  className?: string;
  onClick?: () => void;
};

function classes({
  variant = "primary",
  size = "lg",
  fullWidth,
  className,
}: {
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
  className?: string;
}) {
  return [
    "inline-flex items-center justify-center gap-2 font-semibold tracking-tight",
    "transition-all duration-150 ease-out active:scale-[0.98]",
    "disabled:cursor-not-allowed",
    sizeClass[size],
    variantClass[variant],
    fullWidth ? "w-full" : "",
    className ?? "",
  ].join(" ");
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "lg",
    fullWidth,
    loading,
    iconLeft,
    iconRight,
    className,
    children,
    disabled,
    ...rest
  },
  ref
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={classes({ variant, size, fullWidth, className })}
      {...rest}
    >
      {loading ? <Spinner /> : iconLeft}
      <span>{children}</span>
      {!loading && iconRight}
    </button>
  );
});

export function ButtonLink({
  variant = "primary",
  size = "lg",
  fullWidth,
  iconLeft,
  iconRight,
  className,
  href,
  prefetch,
  onClick,
  children,
}: LinkProps) {
  return (
    <Link
      href={href}
      prefetch={prefetch}
      onClick={onClick}
      className={classes({ variant, size, fullWidth, className })}
    >
      {iconLeft}
      <span>{children}</span>
      {iconRight}
    </Link>
  );
}

function Spinner() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      className="spin-slow"
      fill="none"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
