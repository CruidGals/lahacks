import { HTMLAttributes, ReactNode } from "react";

export function Card({
  children,
  className = "",
  ...rest
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div
      className={`bg-white border border-[color:var(--color-border)] rounded-[var(--radius-xl)] shadow-[var(--shadow-card)] ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}
