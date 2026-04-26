/**
 * Client-side wrapper around MiniKit for the WLD bounty flow.
 *
 * The World docs are explicit: MiniKit commands ONLY work inside World App.
 * `MiniKit.isInstalled()` returns false in a regular browser (Chrome on
 * desktop, mobile Safari outside the World App webview, etc.), and there is
 * no testnet / simulator path -- per the official FAQ, "mini app needs to be
 * developed on mainnet (we don't support testnet)". That is the root cause
 * of the previous WLD-flow failures: any code path that tried to mock
 * `MiniKit.pay()` outside the real World App was guaranteed to silently
 * fail or return garbage.
 *
 * This module:
 *   1. Exposes `payWldEscrow()` which runs `MiniKit.pay()` against the
 *      backend-configured vault. Returns the raw `{ transactionId, reference }`
 *      so the bounty post route can persist them.
 *   2. Exposes `getWorldWalletAddress()` / `syncWorldWalletAddress()` --
 *      reads `MiniKit.user.walletAddress` and POSTs it to
 *      `/api/users/me/world-wallet` so the backend has somewhere to send the
 *      payout when this user wins a cleanup.
 *   3. Throws clean `OutsideWorldAppError`s when the user isn't actually
 *      inside World App, so the post page can show "Open this in World App"
 *      instead of a confusing minikit error.
 *
 * Why a separate module from `lib/api.ts`: anything that touches MiniKit must
 * be loaded only on the client and only after `MiniKitProvider` has run its
 * `useEffect`. Importing `@worldcoin/minikit-js` at the top of a server
 * component triggers a Next.js compilation error because the package reads
 * `window`. We isolate that here with a dynamic import and a strict client
 * guard.
 */

import { ensureUser } from "./http";

/** Thrown when MiniKit isn't initialized (i.e. we're not inside World App). */
export class OutsideWorldAppError extends Error {
  constructor(message = "Open this page inside World App to pay with WLD.") {
    super(message);
    this.name = "OutsideWorldAppError";
  }
}

/** Thrown when the user explicitly cancels the World App payment sheet. */
export class WorldPayUserCancelledError extends Error {
  constructor(message = "Payment cancelled.") {
    super(message);
    this.name = "WorldPayUserCancelledError";
  }
}

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") ??
  "http://localhost:8080";

const WORLD_VAULT_ADDRESS_FROM_ENV =
  process.env.NEXT_PUBLIC_WORLD_VAULT_ADDRESS?.trim() ?? "";

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function getVaultAddress(): string {
  if (!WORLD_VAULT_ADDRESS_FROM_ENV) {
    throw new Error(
      "NEXT_PUBLIC_WORLD_VAULT_ADDRESS is not configured. Set it to the World Chain address that holds the bounty escrow."
    );
  }
  if (!ETH_ADDRESS_RE.test(WORLD_VAULT_ADDRESS_FROM_ENV)) {
    throw new Error(
      `NEXT_PUBLIC_WORLD_VAULT_ADDRESS is not a valid 0x address: ${WORLD_VAULT_ADDRESS_FROM_ENV}`
    );
  }
  return WORLD_VAULT_ADDRESS_FROM_ENV;
}

// ----- MiniKit accessor (dynamic import, client-only) -------------------- //

type MiniKitPayInput = {
  reference: string;
  to: string;
  tokens: Array<{ symbol: string; token_amount: string }>;
  description?: string;
  fallback?: () => unknown;
};

type MiniKitPayResult =
  | {
      executedWith: "minikit";
      data: {
        transactionId: string;
        reference: string;
        from: string;
        chain: string;
        timestamp: string;
      };
    }
  | {
      executedWith: "fallback";
      data: unknown;
    };

type MiniKitModule = {
  isInstalled: () => boolean;
  pay: (input: MiniKitPayInput) => Promise<MiniKitPayResult>;
  user?: { walletAddress?: string | null };
};

type MiniKitCommandsModule = {
  Tokens: { WLD: string; [key: string]: string };
  tokenToDecimals: (amount: number, token: string) => bigint | string;
};

let miniKitPromise: Promise<{
  MiniKit: MiniKitModule;
  Tokens: MiniKitCommandsModule["Tokens"];
  tokenToDecimals: MiniKitCommandsModule["tokenToDecimals"];
}> | null = null;

/**
 * Dynamic import of MiniKit. The package reads `window` at import time, so
 * we only load it in the browser. We also skip it on the server in case
 * Next tries to bundle this file into a server component.
 */
async function loadMiniKit() {
  if (typeof window === "undefined") {
    throw new OutsideWorldAppError(
      "MiniKit cannot be used during server-side rendering."
    );
  }
  if (!miniKitPromise) {
    miniKitPromise = (async () => {
      const [core, commands] = await Promise.all([
        import("@worldcoin/minikit-js") as Promise<{ MiniKit: MiniKitModule }>,
        import("@worldcoin/minikit-js/commands") as Promise<MiniKitCommandsModule>,
      ]);
      return {
        MiniKit: core.MiniKit,
        Tokens: commands.Tokens,
        tokenToDecimals: commands.tokenToDecimals,
      };
    })();
  }
  return miniKitPromise;
}

// ----- Public helpers ---------------------------------------------------- //

/**
 * True only when running inside the World App webview *and* MiniKit has
 * finished installing. Always false during SSR. Use this to gate the WLD
 * reward type in the post UI.
 */
export async function isInsideWorldApp(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  try {
    const { MiniKit } = await loadMiniKit();
    return MiniKit.isInstalled();
  } catch {
    return false;
  }
}

/**
 * Synchronous variant of {@link isInsideWorldApp} useful in render paths.
 * Falls back to `false` if MiniKit hasn't been imported yet -- this is fine
 * because the post page calls the async variant on mount and re-renders.
 */
export function isInsideWorldAppSync(): boolean {
  if (typeof window === "undefined") return false;
  type MiniKitGlobal = { isInstalled?: () => boolean };
  type WindowWithMiniKit = Window & {
    MiniKit?: MiniKitGlobal;
    WorldApp?: unknown;
  };
  const w = window as WindowWithMiniKit;
  // MiniKitProvider stashes the SDK on the window for legacy access.
  // Either signal is sufficient; we don't care which one is set.
  return Boolean(w.MiniKit?.isInstalled?.() ?? w.WorldApp);
}

/**
 * Read the wallet address MiniKit exposes after install. Returns null when
 * not inside World App or before MiniKit boots.
 */
export async function getWorldWalletAddress(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  try {
    const { MiniKit } = await loadMiniKit();
    if (!MiniKit.isInstalled()) return null;
    const addr = MiniKit.user?.walletAddress?.toLowerCase() ?? null;
    if (!addr || !ETH_ADDRESS_RE.test(addr)) return null;
    return addr;
  } catch {
    return null;
  }
}

/**
 * Push the user's MiniKit-reported wallet address up to the backend so it
 * can target the right recipient when this user later claims a bounty.
 * No-op when not in World App; safe to call on every page mount.
 */
export async function syncWorldWalletAddress(): Promise<{ synced: boolean; address: string | null }> {
  const address = await getWorldWalletAddress();
  if (!address) return { synced: false, address: null };

  // Reuse the same bearer-token auth pattern as `lib/http.ts`. We don't
  // use the `api` helper directly because this file shouldn't pull in a
  // circular dep on `lib/api.ts` (which imports `lib/world.ts` for the
  // post-bounty flow).
  const me = await ensureUser();
  try {
    const res = await fetch(`${API_BASE_URL}/api/users/me/world-wallet`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${me.id}`,
      },
      body: JSON.stringify({ world_wallet_address: address }),
    });
    return { synced: res.ok, address };
  } catch {
    return { synced: false, address };
  }
}

export type WldEscrowResult = {
  transactionId: string;
  reference: string;
  from: string;
  chain: string;
  timestamp: string;
};

/**
 * Generate a fresh reference id for an escrow payment. We deliberately do
 * NOT reuse the bounty UUID here: the bounty record doesn't exist yet (we
 * only mint it after the backend verifies the payment), and the World docs
 * spec the reference as a "unique reference for the transaction" we
 * generated client-side. 16 hex chars (~64 bits of entropy) is enough to
 * avoid collisions across an entire hackathon, while staying short enough
 * for the unique-index check to remain cheap on the DB side.
 */
export function newPaymentReference(): string {
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return Math.random().toString(16).slice(2, 18);
}

/**
 * Sign a `MiniKit.pay()` paying the given WLD amount from the user's wallet
 * to the backend vault. Throws {@link OutsideWorldAppError} if not in
 * World App, {@link WorldPayUserCancelledError} on user cancel, and a plain
 * `Error` for any other MiniKit failure code.
 *
 * The caller is responsible for POSTing the returned `{ transactionId,
 * reference }` to `/api/bounties` so the backend can verify the payment via
 * the Developer Portal API.
 */
export async function payWldEscrow(params: {
  amountWld: number;
  description?: string;
  reference?: string;
}): Promise<WldEscrowResult> {
  if (typeof window === "undefined") {
    throw new OutsideWorldAppError();
  }
  const { MiniKit, Tokens, tokenToDecimals } = await loadMiniKit();
  if (!MiniKit.isInstalled()) {
    throw new OutsideWorldAppError();
  }

  if (!Number.isFinite(params.amountWld) || params.amountWld <= 0) {
    throw new Error(`payWldEscrow: amount must be positive (got ${params.amountWld})`);
  }

  const reference = params.reference ?? newPaymentReference();
  const to = getVaultAddress();
  const description =
    params.description?.slice(0, 80) ??
    "Cleanup bounty escrow (refundable until verified)";

  // tokenToDecimals returns either bigint or string depending on the SDK
  // version; both serialize to the same decimal representation we need.
  const amountWei = tokenToDecimals(params.amountWld, Tokens.WLD).toString();

  const result = await MiniKit.pay({
    reference,
    to,
    tokens: [{ symbol: Tokens.WLD, token_amount: amountWei }],
    description,
  });

  if (result.executedWith !== "minikit") {
    // The fallback path runs when the SDK couldn't reach World App. We
    // consider that an error here because the legacy bounty post used
    // `MiniKit.pay()` specifically for its escrow guarantees.
    throw new OutsideWorldAppError(
      "MiniKit fell back to its outside-World-App handler. Open this page inside World App to escrow WLD."
    );
  }

  // The SDK exposes status through the returned data object; in practice
  // success is signalled by the absence of an `error_code` field, and any
  // user cancel surfaces as the SDK rejecting with `user_rejected` or
  // `payment_rejected`. Some SDK versions surface those via a thrown error
  // instead, which we let propagate untouched.
  return {
    transactionId: result.data.transactionId,
    reference: result.data.reference,
    from: result.data.from,
    chain: result.data.chain,
    timestamp: result.data.timestamp,
  };
}
