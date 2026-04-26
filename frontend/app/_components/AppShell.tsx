"use client";

import { ReactNode } from "react";
import { BottomNav } from "./BottomNav";
import { usePathname } from "next/navigation";

const HIDDEN_NAV_PREFIXES = [
  "/onboarding",
  "/login",
  "/bounty/", // detail and inner flow screens get their own chrome
  "/post",
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const showNav = !HIDDEN_NAV_PREFIXES.some((p) => pathname.startsWith(p));

  return (
    <div className="app-frame">
      <main
        className="flex-1 flex flex-col"
        style={{
          paddingBottom: showNav ? "calc(72px + env(safe-area-inset-bottom))" : 0,
        }}
      >
        {children}
      </main>
      {showNav && <BottomNav />}
    </div>
  );
}
