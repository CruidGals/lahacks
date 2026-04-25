"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { MapIcon, PlusIcon, TrophyIcon, UserIcon } from "./icons";

type NavItem = {
  href: string;
  label: string;
  icon: (active: boolean) => React.ReactElement;
};

const items: NavItem[] = [
  {
    href: "/",
    label: "Map",
    icon: (a) => <MapIcon active={a} />,
  },
  {
    href: "/leaderboard",
    label: "Leaders",
    icon: (a) => <TrophyIcon active={a} />,
  },
  {
    href: "/profile",
    label: "Profile",
    icon: (a) => <UserIcon active={a} />,
  },
];

export function BottomNav() {
  const pathname = usePathname() ?? "/";

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 mx-auto max-w-[480px] bg-white/95 backdrop-blur border-t border-[color:var(--color-border)]"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="relative grid grid-cols-3 h-[64px]">
        {items.map((item) => {
          const active =
            item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className="flex flex-col items-center justify-center gap-1 group"
              prefetch
            >
              <span
                className={`transition-colors ${
                  active
                    ? "text-[color:var(--color-brand-500)]"
                    : "text-[color:var(--color-muted)]"
                }`}
              >
                {item.icon(active)}
              </span>
              <span
                className={`text-[10px] font-medium tracking-wide transition-colors ${
                  active
                    ? "text-[color:var(--color-ink)]"
                    : "text-[color:var(--color-muted)]"
                }`}
              >
                {item.label}
              </span>
            </Link>
          );
        })}

        {/* Floating Post CTA */}
        <Link
          href="/post"
          aria-label="Post a bounty"
          className="absolute left-1/2 -translate-x-1/2 -top-7 grid place-items-center w-14 h-14 rounded-full bg-[color:var(--color-brand-500)] text-white shadow-[var(--shadow-cta)] active:scale-95 transition-transform"
        >
          <PlusIcon />
        </Link>
      </div>
    </nav>
  );
}
