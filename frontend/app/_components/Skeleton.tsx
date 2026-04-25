export function Skeleton({
  className = "",
  rounded = "rounded-[12px]",
}: {
  className?: string;
  rounded?: string;
}) {
  return (
    <div
      className={`relative overflow-hidden bg-[color:var(--color-surface-2)] shimmer ${rounded} ${className}`}
    />
  );
}
