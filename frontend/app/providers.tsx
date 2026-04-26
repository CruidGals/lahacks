"use client";

import { useEffect, type ReactNode } from "react";
import { MiniKitProvider } from "@worldcoin/minikit-js/minikit-provider";
import { AppShell } from "./_components/AppShell";
import { ToastProvider } from "./_components/Toast";

type ProvidersProps = {
  children: ReactNode;
};

/**
 * App-wide providers.
 *
 * `MiniKitProvider` calls `MiniKit.install()` in its own `useEffect`. We then
 * run a separate effect to push the user's World wallet address up to the
 * backend (via `lib/world.ts`). Doing it once at root means every WLD-eligible
 * page (post, profile, claim) finds a fresh `users.world_wallet_address`
 * without each page individually wiring up the sync.
 *
 * Per the World docs FAQ ("Why does my command fail when triggered
 * immediately on page load?"), commands triggered in a separate `useEffect`
 * can race the install. We deliberately do NOT call any MiniKit *commands*
 * here -- only read `MiniKit.user.walletAddress`, which is populated
 * synchronously after install -- so the race doesn't apply.
 */
function WorldWalletSync() {
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { syncWorldWalletAddress } = await import("../lib/world");
        if (!cancelled) await syncWorldWalletAddress();
      } catch {
        // Silent: outside-World-App browsers are expected to no-op.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}

export function Providers({ children }: ProvidersProps) {
  return (
    <MiniKitProvider>
      <ToastProvider>
        <WorldWalletSync />
        <AppShell>{children}</AppShell>
      </ToastProvider>
    </MiniKitProvider>
  );
}
