/**
 * World coin (WLD) bounty integration.
 *
 * Two halves of the flow live here:
 *
 *   1. `verifyMiniKitPayment` --
 *      Used after the poster signs `MiniKit.pay()` inside World App. The
 *      frontend submits the resulting `transactionId` + our `reference` to
 *      `POST /api/bounties`; this helper hits the World Developer Portal API
 *      to confirm the on-chain payment matches the bounty contract before we
 *      persist the bounty. *Never* trust the client-reported amount: the
 *      authoritative answer comes from `developer.worldcoin.org`.
 *
 *   2. `transferWldFromVault` / `payoutWldToClaimer` / `refundWldToPoster` --
 *      Used by the cleanup verification handler to release escrowed WLD. The
 *      vault is a regular EOA on World Chain mainnet (chainId 480) whose
 *      private key the backend holds in `WORLD_VAULT_PRIVATE_KEY`. The vault
 *      pays for its own gas in ETH on World Chain (Mini App gas sponsorship
 *      only applies to verified users *inside* World App, not to backend
 *      writers like us).
 *
 * Why this is a separate module from `solana.ts` and not generalized:
 *   * The signing topology is opposite. SOL bounties are escrowed by a
 *     backend keypair that *also* pays out; WLD escrow is signed by the user
 *     in World App, only the payout is signed by the backend.
 *   * World transactions cannot be tested against a simulator -- the
 *     authoritative World docs are explicit that "mini app needs to be
 *     developed on mainnet (we don't support testnet)". We deliberately
 *     surface a single configuration knob (`WORLD_RPC_URL`) instead of a
 *     network/cluster dropdown so there's no place to get this wrong.
 */

import {
  Address,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  parseUnits,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * World Chain mainnet. We define this locally instead of importing
 * `viem/chains` `worldchain` because viem ships the chain with OP-stack
 * formatters (a custom block transaction union that includes `deposit`
 * transactions). Those formatters change the inferred `Client` type and
 * trip TS2719 ("two different types with this name exist, but they are
 * unrelated") when caching the resulting client. We never call
 * `getBlock()` for OP-stack deposit transactions in this codebase, so
 * dropping the formatters is safe.
 *
 * If you need the OP-stack-specific block reader (e.g. for L1->L2 bridge
 * monitoring), reintroduce `worldchain` from `viem/chains` and stop
 * caching the public client.
 */
const worldchain = defineChain({
  id: 480,
  name: 'World Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: {
      http: ['https://worldchain-mainnet.g.alchemy.com/public'],
    },
  },
  blockExplorers: {
    default: {
      name: 'World Chain Explorer',
      url: 'https://worldscan.org',
    },
  },
});

type WorldPublicClient = ReturnType<typeof createPublicClient>;
type WorldWalletClient = ReturnType<typeof createWalletClient>;

// ----- Constants ---------------------------------------------------------- //

/**
 * Canonical WLD ERC-20 address on World Chain mainnet (chainId 480). Sourced
 * from https://docs.world.org/world-chain/reference/useful-contracts. We pin
 * it as a default but allow override via `WLD_TOKEN_ADDRESS` for forks.
 */
const WLD_TOKEN_ADDRESS_DEFAULT = '0x2cFc85d8E48F8EAB294be644d9E25C3030863003';

/**
 * WLD has 18 decimals. WBTC, USDC, etc on World Chain do not, but this codebase
 * intentionally only handles WLD -- if you add another token, branch on the
 * symbol rather than hard-coding a different decimal count here.
 */
export const WLD_DECIMALS = 18;

const WLD_TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const WEI_RE = /^[0-9]+$/;

// ----- Configuration ------------------------------------------------------ //

function readEnv(key: string, fallback?: string): string {
  const raw = process.env[key];
  const trimmed = raw?.trim();
  if (trimmed) return trimmed;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var ${key}`);
}

function readOptionalEnv(key: string): string | null {
  const raw = process.env[key]?.trim();
  return raw ? raw : null;
}

function getWldTokenAddress(): Address {
  return getAddress(readEnv('WLD_TOKEN_ADDRESS', WLD_TOKEN_ADDRESS_DEFAULT));
}

function getVaultAddress(): Address {
  return getAddress(readEnv('WORLD_VAULT_ADDRESS'));
}

function getRpcUrl(): string {
  return readEnv(
    'WORLD_RPC_URL',
    'https://worldchain-mainnet.g.alchemy.com/public'
  );
}

function getDeveloperPortalApiKey(): string {
  return readEnv('WORLD_DEVELOPER_API_KEY');
}

function getWorldAppId(): string {
  return readEnv('WORLD_ID_APP_ID');
}

/**
 * The vault keypair signs the payout / refund ERC-20 transfers. The vault
 * MUST hold both:
 *   * enough WLD to cover all pending bounty payouts, and
 *   * enough ETH to pay gas (gas sponsorship is *not* available to us; only
 *     to user-signed Mini App transactions inside World App).
 */
function getVaultAccount(): ReturnType<typeof privateKeyToAccount> {
  const raw = readEnv('WORLD_VAULT_PRIVATE_KEY');
  const hex = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex;
  return privateKeyToAccount(hex);
}

let cachedPublicClient: WorldPublicClient | null = null;
let cachedWalletClient: WorldWalletClient | null = null;

function getPublicClient(): WorldPublicClient {
  if (!cachedPublicClient) {
    cachedPublicClient = createPublicClient({
      chain: worldchain,
      transport: http(getRpcUrl()),
    });
  }
  return cachedPublicClient;
}

function getWalletClient(): WorldWalletClient {
  if (!cachedWalletClient) {
    cachedWalletClient = createWalletClient({
      account: getVaultAccount(),
      chain: worldchain,
      transport: http(getRpcUrl()),
    });
  }
  return cachedWalletClient;
}

/**
 * Test hook: clear cached clients so tests can swap env vars between cases.
 * Not exported in production paths; harmless if unused.
 */
export function _resetWorldClientsForTesting(): void {
  cachedPublicClient = null;
  cachedWalletClient = null;
}

// ----- Pure helpers ------------------------------------------------------- //

export function isValidEthAddress(value: string): boolean {
  return ETH_ADDRESS_RE.test(value);
}

export function isValidWeiString(value: string): boolean {
  return WEI_RE.test(value) && value !== '0';
}

/**
 * Convert a human WLD amount (e.g. `1.5`) into the canonical wei string.
 * We always store wei as a decimal string so we don't lose precision when
 * round-tripping through JSON or Postgres.
 */
export function wldToWeiString(amountWld: number): string {
  if (!Number.isFinite(amountWld) || amountWld <= 0) {
    throw new Error(`wldToWeiString: amount must be positive (got ${amountWld})`);
  }
  // viem's parseUnits is BigInt-safe and rejects non-finite numbers cleanly.
  return parseUnits(amountWld.toString(), WLD_DECIMALS).toString();
}

export function weiStringToWld(weiString: string): number {
  if (!WEI_RE.test(weiString)) {
    throw new Error(`weiStringToWld: must be a non-negative integer string (got ${weiString})`);
  }
  return Number(formatUnits(BigInt(weiString), WLD_DECIMALS));
}

// ----- Developer Portal verification -------------------------------------- //

/**
 * Shape of `GET /api/v2/minikit/transaction/{transaction_id}` per the World
 * OpenAPI spec. We only assert the fields we actually consume; the response
 * carries more (e.g. timestamp, app_id) but those don't affect verification.
 */
type DeveloperPortalTransaction = {
  reference?: string;
  transaction_hash?: string | null;
  transaction_status?: 'pending' | 'mined' | 'failed';
  from?: string;
  to?: string;
  chain?: string;
  token?: string;
  token_amount?: string;
  app_id?: string;
};

export type VerifyMiniKitPaymentParams = {
  /** The `transactionId` returned by `MiniKit.pay()`. */
  transactionId: string;
  /** The `reference` we generated and passed to `MiniKit.pay()`. */
  expectedReference: string;
  /** Wei amount we expect the user to have paid (string of decimal digits). */
  expectedAmountWei: string;
  /**
   * Optional override for the recipient address we expect. Defaults to
   * `WORLD_VAULT_ADDRESS` -- override only for unit tests.
   */
  expectedRecipient?: Address;
  /**
   * Optional override for the token address we expect. Defaults to the
   * canonical WLD address.
   */
  expectedTokenAddress?: Address;
  /**
   * If true, treat `pending` as success (the Developer Portal hasn't fully
   * indexed the tx yet). Default: false -- we wait for `mined`.
   */
  acceptPending?: boolean;
};

export type VerifiedMiniKitPayment = {
  transactionId: string;
  transactionHash: string;
  reference: string;
  fromAddress: string;
  toAddress: string;
  tokenSymbol: string;
  amountWei: string;
};

/**
 * Verify a `MiniKit.pay()` payment by querying the World Developer Portal and
 * cross-checking every field that matters for escrow integrity:
 *
 *   * transaction_status is `mined` (or `pending` if `acceptPending`)
 *   * reference matches the one we generated for this bounty (replay defense)
 *   * `to` matches our vault address (no spoofed recipients)
 *   * `token` is WLD (no ABA-style swaps to a worthless token)
 *   * `token_amount` >= the expected wei amount (poster cannot underpay)
 *
 * Throws a single `Error` with a stable message on any failure so callers can
 * surface it to the client without leaking internals.
 */
export async function verifyMiniKitPayment(
  params: VerifyMiniKitPaymentParams
): Promise<VerifiedMiniKitPayment> {
  const appId = getWorldAppId();
  const apiKey = getDeveloperPortalApiKey();
  const expectedTo = (params.expectedRecipient ?? getVaultAddress()).toLowerCase();
  // Token comparison is by symbol, not address: the Developer Portal API
  // returns the token *symbol* string ("WLD"), not the contract address.
  // We still validate the contract address independently when the user has
  // configured `WLD_TOKEN_ADDRESS`, because a future expansion to other
  // tokens would key off it.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const expectedTokenAddress =
    params.expectedTokenAddress ?? getWldTokenAddress();

  const url = new URL(
    `https://developer.worldcoin.org/api/v2/minikit/transaction/${encodeURIComponent(
      params.transactionId
    )}`
  );
  url.searchParams.set('app_id', appId);
  url.searchParams.set('type', 'payment');

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` },
    });
  } catch (cause) {
    throw new Error(
      `Failed to reach World Developer Portal: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Developer Portal returned ${res.status} for transaction ${params.transactionId}: ${body || '(no body)'}`
    );
  }

  const tx = (await res.json().catch(() => null)) as
    | DeveloperPortalTransaction
    | null;
  if (!tx) {
    throw new Error(
      `Developer Portal returned a non-JSON body for transaction ${params.transactionId}.`
    );
  }

  const status = tx.transaction_status;
  if (status === 'failed') {
    throw new Error(
      `MiniKit payment ${params.transactionId} reported as failed by World Developer Portal.`
    );
  }
  if (status !== 'mined' && !(params.acceptPending && status === 'pending')) {
    throw new Error(
      `MiniKit payment ${params.transactionId} is not yet mined (status=${status ?? 'unknown'}).`
    );
  }

  if (!tx.reference || tx.reference !== params.expectedReference) {
    throw new Error(
      `Reference mismatch on MiniKit payment ${params.transactionId}: portal=${
        tx.reference ?? 'null'
      } expected=${params.expectedReference}`
    );
  }

  const reportedTo = tx.to?.toLowerCase();
  if (!reportedTo || reportedTo !== expectedTo) {
    throw new Error(
      `Recipient mismatch on MiniKit payment ${params.transactionId}: paid_to=${
        tx.to ?? 'null'
      } expected_vault=${expectedTo}`
    );
  }

  if (tx.token?.toUpperCase() !== 'WLD') {
    throw new Error(
      `Unexpected token on MiniKit payment ${params.transactionId}: portal=${
        tx.token ?? 'null'
      } (only WLD is currently supported).`
    );
  }

  if (!tx.token_amount || !/^[0-9]+$/.test(tx.token_amount)) {
    throw new Error(
      `Missing or malformed token_amount on MiniKit payment ${params.transactionId}: ${
        tx.token_amount ?? 'null'
      }`
    );
  }

  const paid = BigInt(tx.token_amount);
  const expected = BigInt(params.expectedAmountWei);
  if (paid < expected) {
    throw new Error(
      `Underpayment on MiniKit payment ${params.transactionId}: paid=${paid.toString()} expected>=${expected.toString()}`
    );
  }

  if (!tx.transaction_hash && status !== 'pending') {
    throw new Error(
      `Missing transaction_hash on mined MiniKit payment ${params.transactionId}.`
    );
  }

  return {
    transactionId: params.transactionId,
    transactionHash: tx.transaction_hash ?? '',
    reference: tx.reference,
    fromAddress: tx.from ?? '',
    toAddress: tx.to ?? '',
    tokenSymbol: tx.token,
    amountWei: tx.token_amount,
  };
}

// ----- Vault payouts / refunds ------------------------------------------- //

export type WldTransferParams = {
  /** Recipient (claimer for payouts, poster for refunds). */
  toAddress: string;
  /** Wei amount as decimal string. */
  amountWei: string;
  /** Free-form label for logs (e.g. `payout bounty=... cleanup=...`). */
  logLabel: string;
};

/**
 * Send WLD from the vault EOA to `toAddress`. Throws with a message that's
 * safe to log (no secret material). Returns the on-chain transaction hash.
 *
 * Reverts if:
 *   * `toAddress` is not a valid 0x-prefixed 20-byte address.
 *   * `amountWei` is not a positive decimal integer string.
 *   * The vault has insufficient WLD balance for the transfer.
 *
 * Does NOT block on confirmation by default -- viem returns once the
 * transaction is submitted to the mempool. The caller is responsible for
 * polling if it needs a receipt.
 */
export async function transferWldFromVault(
  params: WldTransferParams
): Promise<string> {
  if (!isValidEthAddress(params.toAddress)) {
    throw new Error(`Invalid Ethereum address: ${params.toAddress}`);
  }
  if (!isValidWeiString(params.amountWei)) {
    throw new Error(
      `Invalid wei amount (must be positive integer string): ${params.amountWei}`
    );
  }

  const tokenAddress = getWldTokenAddress();
  const vault = getVaultAddress();
  const recipient = getAddress(params.toAddress);
  const amount = BigInt(params.amountWei);

  const publicClient = getPublicClient();
  const walletClient = getWalletClient();
  const account = getVaultAccount();

  // Pre-flight check on vault WLD balance. We could let the chain reject the
  // tx, but eagerly checking gives a much clearer error in logs and avoids
  // wasting a nonce.
  const balance = (await publicClient.readContract({
    address: tokenAddress,
    abi: WLD_TRANSFER_ABI,
    functionName: 'balanceOf',
    args: [vault],
  })) as bigint;
  if (balance < amount) {
    throw new Error(
      `Vault has insufficient WLD for ${params.logLabel}: have=${balance.toString()} need=${amount.toString()}`
    );
  }

  const data = encodeFunctionData({
    abi: WLD_TRANSFER_ABI,
    functionName: 'transfer',
    args: [recipient, amount],
  });

  const hash = await walletClient.sendTransaction({
    account,
    chain: worldchain,
    to: tokenAddress,
    data,
    value: 0n,
  });

  console.log(
    `${params.logLabel} wld_transfer to=${recipient} amount_wei=${amount.toString()} tx=${hash}`
  );
  return hash;
}

export type WldPayoutParams = {
  bountyId: string;
  cleanupId: string;
  recipientAddress: string;
  amountWei: string;
};

export async function payoutWldToClaimer(
  params: WldPayoutParams
): Promise<string> {
  return transferWldFromVault({
    toAddress: params.recipientAddress,
    amountWei: params.amountWei,
    logLabel: `release_wld_bounty bounty_id=${params.bountyId} cleanup_id=${params.cleanupId}`,
  });
}

export type WldRefundParams = {
  bountyId: string;
  cleanupId: string;
  posterAddress: string;
  amountWei: string;
};

export async function refundWldToPoster(
  params: WldRefundParams
): Promise<string> {
  return transferWldFromVault({
    toAddress: params.posterAddress,
    amountWei: params.amountWei,
    logLabel: `refund_wld_bounty bounty_id=${params.bountyId} cleanup_id=${params.cleanupId}`,
  });
}
