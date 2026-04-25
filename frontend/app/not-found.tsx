import Link from "next/link";
import { LeafIcon } from "./_components/icons";

export default function NotFound() {
  return (
    <div className="flex-1 grid place-items-center px-6 py-16 text-center">
      <div>
        <span className="grid place-items-center w-16 h-16 rounded-full bg-[color:var(--color-brand-50)] text-[color:var(--color-brand-600)] mx-auto">
          <LeafIcon width={28} height={28} />
        </span>
        <h1 className="text-[22px] font-semibold tracking-tight mt-5">
          We couldn&rsquo;t find that
        </h1>
        <p className="text-sm text-[color:var(--color-muted)] mt-1.5 max-w-[300px] mx-auto">
          The page you tried to open doesn&rsquo;t exist.
        </p>
        <Link
          href="/"
          className="inline-flex mt-5 h-11 px-5 items-center rounded-[12px] bg-[color:var(--color-brand-500)] text-white font-semibold shadow-[var(--shadow-cta)]"
        >
          Back to map
        </Link>
      </div>
    </div>
  );
}
