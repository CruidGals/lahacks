"use client";

import type { ReactNode } from "react";
import { MiniKitProvider } from "@worldcoin/minikit-js/minikit-provider";
import { AppShell } from "./_components/AppShell";
import { ToastProvider } from "./_components/Toast";

type ProvidersProps = {
  children: ReactNode;
};

export function Providers({ children }: ProvidersProps) {
  return (
    <MiniKitProvider>
      <ToastProvider>
        <AppShell>{children}</AppShell>
      </ToastProvider>
    </MiniKitProvider>
  );
}
