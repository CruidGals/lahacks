/**
 * Worldcoin (WLD) integration for the Cleanr backend.
 *
 * Architecture
 * ------------
 * - The poster pays WLD into a backend-controlled "vault" wallet via the World
 *   App `MiniKit.pay()` flow. The frontend sends `{reference, transactionId}` to
 *   the backend, which validates the payment with the Worldcoin Developer Portal
 *   API before recording a bounty.
 * - Payouts (vault -> claimer) and refunds (vault -> poster) are signed
 *   server-side with the vault private key using `viem` against World Chain.
 *
 * Units
 * -----
 * WLD has 18 decimals. Storing wei-amounts in JS `number` is unsafe. We store
 * "micro-WLD" (1e-6 WLD) in the existing `bounties.reward_lamports` integer
 * column and convert to wei at the on-chain boundary using `viem.parseUnits`.
 *
 * Security
 * --------
 * - The vault private key is loaded from `WORLDCHAIN_VAULT_PRIVATE_KEY` and
 *   never leaves the backend.
 * - `verifyMiniKitPayment()` re-validates the on-chain payment by hitting the
 *   official Developer Portal endpoint, requiring an `app_id` match and the
 *   `reference` to equal the nonce we minted server-side.
 * - The caller is responsible for atomic replay protection (consume the
 *   reference exactly once) — see `payment-intents.ts`.
 */

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  http,
  isAddress,
  parseUnits,
  type Address,
  type Hash,
  type Hex
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { worldchain } from 'viem/chains';

const WLD_DECIMALS = 18;
const MICRO_WLD_PER_WLD = 1_000_000;
const DEFAULT_WLD_TOKEN = '0x2cfc85d8e48f8eab294be644d9e25c3030863003' as const;
const DEFAULT_RPC_URL = 'https://worldchain-mainnet.g.alchemy.com/public';
const DEFAULT_DEV_PORTAL = 'https://developer.worldcoin.org';
const TX_CONFIRM_TIMEOUT_MS = 60_000;

export type DeveloperPortalPayment = {
  reference: string;
  transactionId: string;
  transactionHash?: string | null;
  status: 'pending' | 'mined' | 'failed' | string;
  recipientAddress?: string | null;
  fromWalletAddress?: string | null;
  tokenAmount?: string | null;
  inputToken?: string | null;
  inputTokenAmount?: string | null;
  miniappId?: string | null;
  network?: string | null;
};

export class WldConfigError extends Error {}
export class WldVerificationError extends Error {}
export class WldOnchainError extends Error {}

// ---------- Unit helpers ----------

export function wldToMicro(amountWld: number): number {
  if (!Number.isFinite(amountWld) || amountWld < 0) {
    throw new Error('WLD amount must be a non-negative finite number.');
  }
  return Math.round(amountWld * MICRO_WLD_PER_WLD);
}

export function microToWld(microWld: number): number {
  return Number((microWld / MICRO_WLD_PER_WLD).toFixed(6));
}

export function microToWei(microWld: number): bigint {
  if (!Number.isInteger(microWld) || microWld < 0) {
    throw new Error('micro-WLD must be a non-negative integer.');
  }
  return parseUnits((microWld / MICRO_WLD_PER_WLD).toString(), WLD_DECIMALS);
}

export function weiToMicro(wei: bigint): number {
  // formatUnits returns a decimal string with up to 18 fractional digits.
  return Math.round(Number(formatUnits(wei, WLD_DECIMALS)) * MICRO_WLD_PER_WLD);
}

// ---------- Config accessors ----------

function readAppId(): string {
  const appId = (process.env.WORLD_APP_ID ?? process.env.WORLD_ID_APP_ID)?.trim();
  if (!appId) {
    throw new WldConfigError(
      'WORLD_APP_ID (or WORLD_ID_APP_ID) is required to use WLD payments.'
    );
  }
  return appId;
}

function readDevPortalApiKey(): string {
  const key = process.env.WORLD_DEV_PORTAL_API_KEY?.trim();
  if (!key) {
    throw new WldConfigError(
      'WORLD_DEV_PORTAL_API_KEY is required to verify MiniKit payments.'
    );
  }
  return key;
}

function readWldTokenAddress(): Address {
  const raw =
    process.env.WLD_TOKEN_ADDRESS?.trim().toLowerCase() ?? DEFAULT_WLD_TOKEN;
  if (!isAddress(raw)) {
    throw new WldConfigError(`WLD_TOKEN_ADDRESS is not a valid address: ${raw}`);
  }
  return raw as Address;
}

function readRpcUrl(): string {
  return process.env.WORLDCHAIN_RPC_URL?.trim() || DEFAULT_RPC_URL;
}

function readDevPortalBaseUrl(): string {
  return (
    process.env.WORLD_DEV_PORTAL_BASE_URL?.trim().replace(/\/$/, '') ||
    DEFAULT_DEV_PORTAL
  );
}

function readVaultPrivateKey(): Hex {
  const raw = process.env.WORLDCHAIN_VAULT_PRIVATE_KEY?.trim();
  if (!raw) {
    throw new WldConfigError(
      'WORLDCHAIN_VAULT_PRIVATE_KEY is required for on-chain payouts and refunds.'
    );
  }
  const hex = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new WldConfigError(
      'WORLDCHAIN_VAULT_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string.'
    );
  }
  return hex as Hex;
}

/**
 * Address that posters should send WLD to during bounty creation. We expose
 * this so the API can hand it back to the client when it mints a payment
 * intent.
 */
export function getVaultAddress(): Address {
  const explicit = process.env.WORLDCHAIN_VAULT_ADDRESS?.trim();
  if (explicit) {
    if (!isAddress(explicit)) {
      throw new WldConfigError(
        `WORLDCHAIN_VAULT_ADDRESS is not a valid address: ${explicit}`
      );
    }
    return explicit as Address;
  }
  return privateKeyToAccount(readVaultPrivateKey()).address;
}

// ---------- Developer Portal verification ----------

/**
 * Look up a MiniKit payment by `transactionId` and return the normalized
 * payload. Throws `WldVerificationError` if the request fails or the response
 * is malformed.
 */
export async function fetchDeveloperPortalPayment(
  transactionId: string
): Promise<DeveloperPortalPayment> {
  const appId = readAppId();
  const apiKey = readDevPortalApiKey();
  const baseUrl = readDevPortalBaseUrl();

  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(transactionId)) {
    throw new WldVerificationError('Invalid MiniKit transactionId format.');
  }

  const url = `${baseUrl}/api/v2/minikit/transaction/${encodeURIComponent(
    transactionId
  )}?app_id=${encodeURIComponent(appId)}&type=payment`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json'
      }
    });
  } catch (err) {
    throw new WldVerificationError(
      `Failed to reach Worldcoin Developer Portal: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new WldVerificationError(
      `Developer Portal returned ${response.status}: ${text.slice(0, 256)}`
    );
  }

  const json = (await response.json().catch(() => null)) as
    | Record<string, unknown>
    | null;

  if (!json || typeof json !== 'object') {
    throw new WldVerificationError(
      'Developer Portal returned an unexpected payload.'
    );
  }

  const reference = stringField(json, 'reference');
  const txId = stringField(json, 'transactionId') ?? transactionId;
  const status = stringField(json, 'status');

  if (!reference || !status) {
    throw new WldVerificationError(
      'Developer Portal payload is missing reference/status.'
    );
  }

  return {
    reference,
    transactionId: txId,
    transactionHash: stringField(json, 'transactionHash'),
    status,
    recipientAddress: stringField(json, 'recipientAddress'),
    fromWalletAddress: stringField(json, 'fromWalletAddress'),
    tokenAmount: stringField(json, 'tokenAmount'),
    inputToken: stringField(json, 'inputToken'),
    inputTokenAmount: stringField(json, 'inputTokenAmount'),
    miniappId: stringField(json, 'miniappId'),
    network: stringField(json, 'network')
  };
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

type VerifyArgs = {
  transactionId: string;
  expectedReference: string;
  expectedRecipient: Address;
  expectedAmountWei: bigint;
  /**
   * If true, allow `pending` status (the user op is in flight). For bounty
   * escrow we accept this because the World App side has already debited the
   * user; the funds will land in the vault shortly.
   */
  allowPending?: boolean;
};

/**
 * Verify a MiniKit payment matches the expected intent and is at least pending.
 * This is the primary defense against attackers reusing or fabricating
 * transactionIds.
 */
export async function verifyMiniKitPayment(
  args: VerifyArgs
): Promise<DeveloperPortalPayment> {
  const payment = await fetchDeveloperPortalPayment(args.transactionId);

  if (payment.reference !== args.expectedReference) {
    throw new WldVerificationError(
      `Payment reference mismatch (got=${payment.reference} expected=${args.expectedReference}).`
    );
  }

  if (payment.status === 'failed') {
    throw new WldVerificationError('Payment failed on-chain.');
  }

  const okStatus =
    payment.status === 'mined' ||
    (args.allowPending && payment.status === 'pending');
  if (!okStatus) {
    throw new WldVerificationError(
      `Payment is not in a usable state (status=${payment.status}).`
    );
  }

  if (payment.recipientAddress) {
    const recipient = payment.recipientAddress.toLowerCase();
    if (recipient !== args.expectedRecipient.toLowerCase()) {
      throw new WldVerificationError(
        'Payment was sent to a different recipient than the configured vault.'
      );
    }
  }

  if (payment.tokenAmount) {
    let actual: bigint;
    try {
      actual = BigInt(payment.tokenAmount);
    } catch {
      throw new WldVerificationError(
        `Developer Portal tokenAmount is not an integer string: ${payment.tokenAmount}`
      );
    }
    if (actual < args.expectedAmountWei) {
      throw new WldVerificationError(
        `Payment amount too small (got=${actual.toString()} wei expected>=${args.expectedAmountWei.toString()}).`
      );
    }
  }

  return payment;
}

// ---------- On-chain transfers (vault -> recipient) ----------

function getPublicClient() {
  return createPublicClient({
    chain: worldchain,
    transport: http(readRpcUrl())
  });
}

function getVaultClient() {
  const account = privateKeyToAccount(readVaultPrivateKey());
  return createWalletClient({
    account,
    chain: worldchain,
    transport: http(readRpcUrl())
  });
}

export type WldTransferParams = {
  recipient: string;
  microWld: number;
  /** Optional context for logging. */
  bountyId?: string;
  cleanupId?: string;
  kind: 'payout' | 'refund';
};

export type WldTransferResult = {
  txHash: Hash;
  recipient: Address;
  amountWei: bigint;
};

/**
 * Send an ERC-20 WLD transfer from the vault to `recipient`. Used for both
 * payouts (vault -> claimer) and refunds (vault -> poster).
 */
export async function transferWldFromVault(
  params: WldTransferParams
): Promise<WldTransferResult> {
  if (!isAddress(params.recipient)) {
    throw new WldOnchainError(`Recipient is not a valid address: ${params.recipient}`);
  }
  const recipient = params.recipient as Address;
  const amountWei = microToWei(params.microWld);
  if (amountWei === 0n) {
    throw new WldOnchainError('Transfer amount must be greater than zero.');
  }

  const token = readWldTokenAddress();
  const wallet = getVaultClient();
  const publicClient = getPublicClient();

  const balance = (await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [wallet.account.address]
  })) as bigint;

  if (balance < amountWei) {
    throw new WldOnchainError(
      `Vault WLD balance (${balance.toString()} wei) is below the requested transfer (${amountWei.toString()} wei).`
    );
  }

  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [recipient, amountWei]
  });

  const txHash = await wallet.sendTransaction({
    to: token,
    data,
    value: 0n
  });

  await publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: TX_CONFIRM_TIMEOUT_MS
  });

  console.log(
    `wld_${params.kind} bounty_id=${params.bountyId ?? '-'} cleanup_id=${
      params.cleanupId ?? '-'
    } recipient=${recipient} amount_wei=${amountWei.toString()} tx=${txHash}`
  );

  return { txHash, recipient, amountWei };
}

// ---------- Re-exports for callers ----------

export const Wld = {
  decimals: WLD_DECIMALS,
  microPerWld: MICRO_WLD_PER_WLD,
  tokenAddress: () => readWldTokenAddress(),
  vaultAddress: () => getVaultAddress()
};
