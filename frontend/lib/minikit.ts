/**
 * Thin client-side helpers around the World App `MiniKit` SDK (v2.x).
 *
 * MiniKit 2.0 made all commands top-level async methods on `MiniKit` and
 * deprecated the `commands` / `commandsAsync` namespaces. The async methods
 * resolve to a `CommandResultByVia<TNative, TFallback>` discriminated union:
 *
 *     { executedWith: 'minikit',  data: TNative }
 *   | { executedWith: 'fallback', data: TFallback }
 *
 * We only ever opt into the `minikit` (in-World-App) path. The helpers below
 * normalize the result and translate failures into typed errors so the caller
 * can render friendly toast messages without reaching for the SDK internals.
 */

import { MiniKit } from "@worldcoin/minikit-js";
import { Tokens, tokenToDecimals } from "@worldcoin/minikit-js/commands";
import { api } from "./http";

export class MiniKitNotInstalledError extends Error {}
export class MiniKitPayError extends Error {}
export class MiniKitWalletAuthError extends Error {}

export type WldPayInput = {
  reference: string;
  recipient: string;
  amountWld: number;
  description: string;
};

export type WldPayResult = {
  transactionId: string;
  reference: string;
  from: string;
};

/** True only when the page is rendered inside World App / the simulator. */
export function isWorldApp(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return MiniKit.isInstalled();
  } catch {
    return false;
  }
}

/**
 * Trigger the World App pay sheet for `amountWld` WLD. The caller is
 * responsible for minting the `reference` (via `/api/payments/intent`) and
 * for posting the resulting `transactionId` back to `/api/payments/confirm`.
 */
export async function payWldBounty(input: WldPayInput): Promise<WldPayResult> {
  if (!isWorldApp()) {
    throw new MiniKitNotInstalledError(
      "World App is required to pay in WLD. Open this mini app inside World App."
    );
  }

  const tokenAmount = tokenToDecimals(input.amountWld, Tokens.WLD).toString();

  let result;
  try {
    result = await MiniKit.pay({
      reference: input.reference,
      to: input.recipient,
      tokens: [{ symbol: Tokens.WLD, token_amount: tokenAmount }],
      description: input.description,
    });
  } catch (err) {
    throw new MiniKitPayError(
      err instanceof Error ? err.message : "World App payment failed."
    );
  }

  if (result.executedWith !== "minikit") {
    throw new MiniKitPayError(
      "Payment was not completed inside World App."
    );
  }

  const data = result.data;
  if (!data?.transactionId || !data?.reference) {
    throw new MiniKitPayError(
      "World App returned an incomplete payment payload."
    );
  }

  if (data.reference !== input.reference) {
    throw new MiniKitPayError(
      "Payment reference mismatch from World App. Please retry."
    );
  }

  return {
    transactionId: data.transactionId,
    reference: data.reference,
    from: data.from,
  };
}

// ---------- Wallet linking via `walletAuth` (SIWE) ----------
//
// Bootstraps the user's World App wallet so the backend can pay them out in
// WLD. Three-phase flow:
//   1. POST /api/users/wallet/nonce      → { nonce }
//   2. await MiniKit.walletAuth({ nonce, ... })
//   3. POST /api/users/wallet/complete   → { ok, world_address }

export async function linkWorldWallet(): Promise<{ world_address: string }> {
  if (!isWorldApp()) {
    throw new MiniKitNotInstalledError(
      "World App is required to link a wallet."
    );
  }

  const { nonce } = await api<{ nonce: string }>("/api/users/wallet/nonce", {
    method: "POST",
    body: {},
  });

  let result;
  try {
    result = await MiniKit.walletAuth({
      nonce,
      statement: "Link your World App wallet to receive WLD bounties.",
      requestId: nonce.slice(0, 16),
      expirationTime: new Date(Date.now() + 5 * 60 * 1000),
    });
  } catch (err) {
    throw new MiniKitWalletAuthError(
      err instanceof Error ? err.message : "Wallet auth failed."
    );
  }

  if (result.executedWith !== "minikit") {
    throw new MiniKitWalletAuthError("Wallet auth was cancelled.");
  }

  const { address, message, signature, version } = result.data;
  if (!address || !message || !signature) {
    throw new MiniKitWalletAuthError(
      "World App returned an incomplete walletAuth payload."
    );
  }

  const json = await api<{ ok: boolean; world_address: string }>(
    "/api/users/wallet/complete",
    {
      method: "POST",
      body: {
        nonce,
        payload: {
          status: "success",
          message,
          signature,
          address,
          ...(typeof version === "number" ? { version } : {}),
        },
      },
    }
  );

  return { world_address: json.world_address };
}
