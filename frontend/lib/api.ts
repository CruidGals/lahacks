/**
 * Real API layer.
 *
 * Each function maps backend responses (Express + Supabase, see /backend) onto
 * the frontend's richer Bounty/User/Session types. The backend stores a small
 * canonical set of fields; everything else is derived deterministically here
 * so existing UI components keep working.
 */

import { api, ensureUser, setCachedUser, type ApiUser } from "./http";
import { SPOT_USD } from "./format";
import type {
  Bounty,
  BountyCategory,
  BountyStatus,
  CleanupSubmission,
  Currency,
  GeoPing,
  LeaderboardEntry,
  Session,
  Timeframe,
  User,
  VerificationResult,
} from "./types";

const BOUNTY_LIFETIME_HOURS = 48;
const CLAIM_LOCK_HOURS = 4;

// ---------- Backend response shapes ----------

type BackendBounty = {
  id: string;
  poster_id: string | null;
  claimer_id: string | null;
  lat: number;
  lng: number;
  reward_lamports: number;
  reward_currency?: Currency | null;
  reward?: number | null;
  reward_sol?: number | null;
  reward_wld?: number | null;
  description: string | null;
  reference_video_url: string | null;
  status: BackendBountyStatus;
  urgency_score: number;
  created_at: string | null;
  claimed_at: string | null;
  escrow_tx_sig: string | null;
  poster?: {
    id: string;
    wallet_address: string;
    world_address?: string | null;
    verified: boolean | null;
  } | null;
};

type BackendClaimedBounty = BackendBounty & {
  claim_expires_at: string | null;
};

export type ClaimedBounty = Bounty & {
  claim_expires_at: string;
  has_active_session: boolean;
};

type BackendBountyStatus = "open" | "claimed" | "completed" | "expired";

type BackendCleanup = {
  id: string;
  bounty_id: string | null;
  session_id: string | null;
  status: "pending" | "verified" | "rejected";
  video_url: string | null;
  payout_tx_sig: string | null;
  confidence_score: number | null;
  verification_result: Record<string, unknown> | null;
};

type BackendUserMe = ApiUser & {
  total_earned_sol: number;
  total_earned_wld?: number;
  total_completed: number;
  current_streak: number;
  world_address?: string | null;
  wallet: {
    address: string;
    world_address?: string | null;
    balance_sol: number;
    balance_wld?: number;
  };
  recent_completed: Array<{
    bounty_id: string;
    title: string;
    reward_sol?: number;
    reward_wld?: number;
    reward?: number;
    reward_currency?: Currency;
    completed_at: string;
  }>;
};

type BackendLeaderboardItem = {
  rank: number;
  user_id: string;
  handle: string;
  avatar_color: string;
  total_earned_sol: number;
  total_earned_wld?: number;
  total_earned_usd?: number;
  total_completed: number;
  wallet_address: string;
};

type WorldRpContextResponse = {
  app_id: `app_${string}`;
  action: string;
  environment: "production" | "staging";
  rp_context: {
    rp_id: `rp_${string}`;
    nonce: string;
    created_at: number;
    expires_at: number;
    signature: string;
  };
};

// ---------- Local session cache ----------
//
// The backend never exposes a "GET /sessions/:id" endpoint, so we cache
// what we receive from "POST /sessions/start" in localStorage. This lets
// the start/verify pages keep working across reloads without requiring a
// new backend route.

const SESSION_CACHE_KEY = "cleanr.sessions.v1";

type SessionCache = Record<string, Session>;

function readSessionCache(): SessionCache {
  if (typeof window === "undefined") return {};
  const raw = window.localStorage.getItem(SESSION_CACHE_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as SessionCache;
  } catch {
    return {};
  }
}

function writeSessionCache(cache: SessionCache) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(cache));
}

function persistSession(session: Session) {
  const cache = readSessionCache();
  cache[session.id] = session;
  writeSessionCache(cache);
}

// ---------- Helpers ----------

const AVATAR_PALETTE = [
  "#16a34a",
  "#2563eb",
  "#7c3aed",
  "#f59e0b",
  "#e11d48",
  "#0891b2",
  "#0a0a0a",
];

function avatarColorFor(seed: string): string {
  let hash = 0;
  for (const ch of seed) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length] ?? "#16a34a";
}

function shortWallet(addr: string | null | undefined): string {
  if (!addr) return "Anonymous";
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

const CATEGORY_TAG_RE = /^#category:(\w+)$/m;
const VALID_CATEGORIES: BountyCategory[] = [
  "litter",
  "graffiti",
  "illegal_dumping",
  "park",
  "beach",
  "other",
];

function stripMetaLines(description: string): string {
  return description
    .split("\n")
    .filter((line) => !line.trim().startsWith("#category:"))
    .join("\n")
    .trim();
}

function deriveTitle(description: string | null): string {
  if (!description) return "Cleanup task";
  const cleaned = stripMetaLines(description);
  const firstLine = cleaned.split("\n")[0]?.trim() ?? "";
  if (!firstLine) return "Cleanup task";
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

function deriveDescriptionBody(description: string | null): string {
  if (!description) return "";
  const cleaned = stripMetaLines(description);
  const lines = cleaned.split("\n");
  // Strip the title-on-first-line we encoded in postBounty.
  if (lines.length > 1) {
    return lines.slice(1).join("\n").trim();
  }
  return cleaned;
}

function deriveCategory(description: string | null): BountyCategory {
  if (!description) return "other";
  const match = description.match(CATEGORY_TAG_RE);
  const tag = match?.[1] as BountyCategory | undefined;
  if (tag && VALID_CATEGORIES.includes(tag)) return tag;
  return "other";
}

function deriveAddress(lat: number, lng: number): string {
  return `Pinned · ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
}

function addHours(iso: string | null, hours: number): string {
  const base = iso ? new Date(iso).getTime() : Date.now();
  return new Date(base + hours * 3600_000).toISOString();
}

/**
 * Resolve the canonical reward amount + currency from whatever shape the
 * backend returned. The backend is in the middle of a SOL → dual-currency
 * migration, so a row may carry any of `reward_currency`/`reward`/
 * `reward_sol`/`reward_wld`. We pick the most specific one available, default
 * to SOL only for back-compat with legacy rows.
 */
function resolveReward(b: BackendBounty): { amount: number; currency: Currency } {
  const currency: Currency =
    b.reward_currency === "WLD" || b.reward_currency === "SOL"
      ? b.reward_currency
      : typeof b.reward_wld === "number" && b.reward_wld > 0
        ? "WLD"
        : "SOL";

  let amount: number;
  if (currency === "WLD") {
    amount =
      typeof b.reward_wld === "number"
        ? b.reward_wld
        : typeof b.reward === "number"
          ? b.reward
          : 0;
  } else {
    amount =
      typeof b.reward_sol === "number"
        ? b.reward_sol
        : typeof b.reward === "number"
          ? b.reward
          : 0;
  }

  return { amount, currency };
}

function mapBounty(b: BackendBounty): Bounty {
  const status: BountyStatus = b.status;
  const claimLockUntil = b.claimed_at
    ? addHours(b.claimed_at, CLAIM_LOCK_HOURS)
    : undefined;
  const posterId = b.poster?.id ?? b.poster_id ?? "anon";
  const { amount, currency } = resolveReward(b);

  return {
    id: b.id,
    title: deriveTitle(b.description),
    description: deriveDescriptionBody(b.description),
    lat: b.lat,
    lng: b.lng,
    address: deriveAddress(b.lat, b.lng),
    reward: amount,
    reward_currency: currency,
    reward_sol: currency === "SOL" ? amount : 0,
    reward_wld: currency === "WLD" ? amount : 0,
    reward_usd_estimate: Math.round(amount * SPOT_USD[currency]),
    status,
    urgency_score: b.urgency_score ?? 0,
    category: deriveCategory(b.description),
    poster: {
      id: posterId,
      name: shortWallet(b.poster?.world_address || b.poster?.wallet_address),
      avatar_color: avatarColorFor(posterId),
      is_org: Boolean(b.poster?.verified),
    },
    reference_video_url: b.reference_video_url,
    reference_thumbnail_url: null,
    created_at: b.created_at ?? new Date().toISOString(),
    expires_at: addHours(b.created_at, BOUNTY_LIFETIME_HOURS),
    claimed_by: b.claimer_id ?? undefined,
    claim_lock_until: claimLockUntil,
  };
}

// ---------- Bounties ----------

export async function getBounties(): Promise<Bounty[]> {
  const json = await api<{ as_of: string; items: BackendBounty[] }>(
    "/api/bounties"
  );
  return json.items.map(mapBounty);
}

export async function getBounty(id: string): Promise<Bounty | null> {
  try {
    const b = await api<BackendBounty>(`/api/bounties/${id}`);
    return mapBounty(b);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export type PostBountyInput = {
  title: string;
  description: string;
  lat: number;
  lng: number;
  address: string;
  reward: number;
  currency: Currency;
  category: Bounty["category"];
  reference_video_url: string | null;
  reference_thumbnail_url: string | null;
};

/**
 * Encode the user-facing title + category into the single `description` field
 * the backend stores. `mapBounty()` reverses this on read.
 */
function encodeBountyDescription(
  title: string,
  description: string,
  category: Bounty["category"]
): string {
  return [title.trim(), description.trim(), `#category:${category}`]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Create a SOL bounty in a single request. The backend escrows reward funds
 * server-side from its funder keypair.
 */
export async function postBounty(input: PostBountyInput): Promise<Bounty> {
  if (input.currency !== "SOL") {
    throw new Error(
      "postBounty() only handles SOL bounties. Use createWldBountyIntent() + confirmWldBounty() for WLD."
    );
  }

  await ensureVerified();

  const description = encodeBountyDescription(
    input.title,
    input.description,
    input.category
  );

  const json = await api<{ bounty: BackendBounty; escrow_tx_sig: string | null }>(
    "/api/bounties",
    {
      method: "POST",
      body: {
        lat: input.lat,
        lng: input.lng,
        reward_currency: "SOL",
        reward_sol: input.reward,
        description,
        reference_video_url: input.reference_video_url ?? null,
      },
    }
  );

  return mapBounty(json.bounty);
}

// ---------- WLD payments (two-phase MiniKit flow) ----------

export type WldBountyIntent = {
  reference: string;
  recipient: `0x${string}`;
  token_address: `0x${string}`;
  chain_id: number;
  expected_amount_micro_wld: number;
  /** Stringified `bigint` so the wei amount survives JSON. */
  expected_amount_wei: string;
  expected_amount_wld: number;
  expires_at: number;
};

/**
 * Phase 1 of the WLD bounty flow. Reserves a one-shot reference + recipient
 * the client must use when calling `MiniKit.commandsAsync.pay`.
 */
export async function createWldBountyIntent(input: {
  title: string;
  description: string;
  lat: number;
  lng: number;
  reward_wld: number;
  category: Bounty["category"];
  reference_video_url: string | null;
}): Promise<WldBountyIntent> {
  await ensureVerified();

  const description = encodeBountyDescription(
    input.title,
    input.description,
    input.category
  );

  return api<WldBountyIntent>("/api/payments/intent", {
    method: "POST",
    body: {
      kind: "bounty_escrow",
      bounty: {
        lat: input.lat,
        lng: input.lng,
        reward_wld: input.reward_wld,
        description,
        reference_video_url: input.reference_video_url ?? null,
      },
    },
  });
}

/**
 * Phase 2 of the WLD bounty flow. Hands the on-chain `transactionId` from
 * `MiniKit.pay` back to the backend, which verifies it through the Worldcoin
 * Developer Portal and persists the bounty atomically.
 */
export async function confirmWldBounty(input: {
  reference: string;
  transaction_id: string;
}): Promise<Bounty> {
  const json = await api<{ bounty: BackendBounty; escrow_tx_sig: string | null }>(
    "/api/payments/confirm",
    {
      method: "POST",
      body: {
        reference: input.reference,
        transaction_id: input.transaction_id,
      },
    }
  );
  return mapBounty(json.bounty);
}

export async function claimBounty(id: string): Promise<Bounty> {
  await ensureVerified();
  const json = await api<{
    message: string;
    claim_expires_at: string;
    bounty: BackendBounty;
  }>(`/api/bounties/${id}/claim`, { method: "POST" });
  return mapBounty(json.bounty);
}

export async function getMyClaimedBounties(): Promise<ClaimedBounty[]> {
  const json = await api<{ as_of: string; items: BackendClaimedBounty[] }>(
    "/api/bounties/me/claimed"
  );
  return json.items.map((b) => {
    const mapped = mapBounty(b);
    return {
      ...mapped,
      claim_expires_at:
        b.claim_expires_at ??
        mapped.claim_lock_until ??
        new Date(Date.now() + CLAIM_LOCK_HOURS * 3600_000).toISOString(),
      has_active_session: hasLocalSession(b.id),
    };
  });
}

export async function cancelClaim(id: string): Promise<Bounty> {
  const json = await api<{ message: string; bounty: BackendBounty }>(
    `/api/bounties/${id}/unclaim`,
    { method: "POST" }
  );

  // Clear any local session/cleanup pointers so the UI doesn't try to
  // resume a task on a bounty the user no longer owns.
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(`cleanr.session.${id}`);
    window.localStorage.removeItem(`cleanr.cleanup.${id}`);
    window.localStorage.removeItem(`cleanr.pending.${id}`);
    window.localStorage.removeItem(`cleanr.result.${id}`);
  }

  return mapBounty(json.bounty);
}

function hasLocalSession(bountyId: string): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(window.localStorage.getItem(`cleanr.session.${bountyId}`));
}

// ---------- Sessions ----------

export async function startSession(bountyId: string): Promise<Session> {
  await ensureVerified();
  const me = await ensureUser();
  const json = await api<{ session_id: string; nonce: string }>(
    "/api/sessions/start",
    { method: "POST", body: { bounty_id: bountyId } }
  );

  const session: Session = {
    id: json.session_id,
    bounty_id: bountyId,
    user_id: me.id,
    nonce: json.nonce,
    started_at: new Date().toISOString(),
    status: "active",
    pings: [],
  };
  persistSession(session);
  return session;
}

export async function pingSession(
  sessionId: string,
  ping: GeoPing
): Promise<void> {
  try {
    await api(`/api/sessions/${sessionId}/ping`, {
      method: "POST",
      body: {
        lat: ping.lat,
        lng: ping.lng,
        accuracy: ping.accuracy_m,
        timestamp: ping.ts,
      },
    });
  } catch {
    // Pings are best-effort; never block the user flow on them.
  }

  const cache = readSessionCache();
  const cached = cache[sessionId];
  if (cached) {
    cached.pings = [...cached.pings, ping];
    writeSessionCache(cache);
  }
}

export async function getSession(id: string): Promise<Session | null> {
  return readSessionCache()[id] ?? null;
}

// ---------- Cleanups ----------

export async function submitCleanup(
  input: CleanupSubmission
): Promise<{ cleanup_id: string; status: "pending" }> {
  await ensureVerified();

  // The backend requires a real URL. Until video upload is wired, post a
  // deterministic placeholder URL that encodes the session id so logs are
  // traceable.
  const videoUrl =
    input.video_blob_url && /^https?:\/\//.test(input.video_blob_url)
      ? input.video_blob_url
      : `https://demo.cleanr.app/cleanups/${input.session_id}.mp4`;

  const json = await api<{ cleanup_id: string; status: "pending" }>(
    "/api/cleanups",
    {
      method: "POST",
      body: {
        session_id: input.session_id,
        video_url: videoUrl,
      },
    }
  );

  // Mark the local session as "submitted" so the start screen reflects it.
  const cache = readSessionCache();
  const cached = cache[input.session_id];
  if (cached) {
    cached.status = "submitted";
    writeSessionCache(cache);
  }

  return json;
}

export async function getCleanup(
  id: string
): Promise<{ status: "pending" | "verified" | "rejected"; raw: BackendCleanup }> {
  const json = await api<{ cleanup: BackendCleanup }>(`/api/cleanups/${id}`);
  return { status: json.cleanup.status ?? "pending", raw: json.cleanup };
}

export function buildVerificationResult(
  cleanup: BackendCleanup
): VerificationResult | null {
  if (cleanup.status === "pending") return null;

  const passed = cleanup.status === "verified";
  const confidence = cleanup.confidence_score ?? (passed ? 0.9 : 0.3);
  const reasoning =
    (cleanup.verification_result?.["reasoning"] as string | undefined) ??
    (passed
      ? "Verified by AI checks"
      : "Did not pass automatic verification");

  const checks: VerificationResult["checks"] = [
    {
      label: "GPS trajectory",
      status: passed ? "pass" : "fail",
      detail: passed ? "Within bounty geofence" : "Trajectory off-site",
    },
    {
      label: "Session duration",
      status: passed ? "pass" : "fail",
      detail: passed ? "On-site long enough" : "Session too short",
    },
    {
      label: "Nonce watermark",
      status: passed ? "pass" : "skipped",
    },
    {
      label: "Reference frame match",
      status:
        (cleanup.verification_result?.["scene_match"] as boolean | undefined) ??
        passed
          ? "pass"
          : "fail",
    },
    {
      label: "Before/after change",
      status:
        (cleanup.verification_result?.["task_complete"] as boolean | undefined) ??
        passed
          ? "pass"
          : "fail",
    },
    {
      label: "Reasoning",
      status: passed ? "pass" : "skipped",
      detail: reasoning,
    },
  ];

  const txSig =
    (cleanup.payout_tx_sig as string | null) ??
    ((cleanup.verification_result?.["refund_tx_sig"] as string | undefined) ??
      undefined);

  return {
    passed,
    confidence,
    checks,
    reward_tx_signature: txSig ?? undefined,
  };
}

// ---------- Users / leaderboard ----------

export async function getMe(): Promise<User> {
  const json = await api<{ user: BackendUserMe }>("/api/users/me");
  const u = json.user;
  setCachedUser({
    id: u.id,
    wallet_address: u.wallet_address,
    verified: u.verified,
    world_id_hash: u.world_id_hash,
    created_at: u.created_at,
  });

  const recentCompleted = (u.recent_completed ?? []).map((entry) => {
    const currency: Currency =
      entry.reward_currency === "SOL" || entry.reward_currency === "WLD"
        ? entry.reward_currency
        : typeof entry.reward_wld === "number" && entry.reward_wld > 0
          ? "WLD"
          : "SOL";

    const amount =
      currency === "WLD"
        ? typeof entry.reward_wld === "number"
          ? entry.reward_wld
          : typeof entry.reward === "number"
            ? entry.reward
            : 0
        : typeof entry.reward_sol === "number"
          ? entry.reward_sol
          : typeof entry.reward === "number"
            ? entry.reward
            : 0;

    return {
      bounty_id: entry.bounty_id,
      title: entry.title,
      reward: amount,
      reward_currency: currency,
      completed_at: entry.completed_at,
    };
  });

  const worldAddress =
    u.wallet?.world_address ?? u.world_address ?? null;
  const handleWallet = worldAddress || u.wallet_address;

  return {
    id: u.id,
    handle: shortWallet(handleWallet),
    avatar_color: avatarColorFor(u.id),
    world_id_verified: Boolean(u.verified),
    joined_at: u.created_at ?? new Date().toISOString(),
    total_earned_sol: u.total_earned_sol ?? 0,
    total_earned_wld: u.total_earned_wld ?? 0,
    total_completed: u.total_completed,
    current_streak: u.current_streak,
    wallet: {
      address: u.wallet?.address ?? u.wallet_address,
      world_address: worldAddress,
      balance_sol: u.wallet?.balance_sol ?? u.total_earned_sol ?? 0,
      balance_wld:
        typeof u.wallet?.balance_wld === "number"
          ? u.wallet.balance_wld
          : (u.total_earned_wld ?? 0),
    },
    recent_completed: recentCompleted,
  };
}

export async function getCurrentUserId(): Promise<string> {
  const me = await ensureUser();
  return me.id;
}

export async function getLeaderboard(
  tf: Timeframe = "week"
): Promise<LeaderboardEntry[]> {
  const json = await api<{ timeframe: Timeframe; items: BackendLeaderboardItem[] }>(
    "/api/leaderboard",
    { query: { timeframe: tf } }
  );
  return json.items.map((entry) => {
    const sol = entry.total_earned_sol ?? 0;
    const wld = entry.total_earned_wld ?? 0;
    const usd =
      typeof entry.total_earned_usd === "number"
        ? entry.total_earned_usd
        : sol * SPOT_USD.SOL + wld * SPOT_USD.WLD;
    return {
      rank: entry.rank,
      user_id: entry.user_id,
      handle: entry.handle,
      avatar_color: entry.avatar_color,
      total_earned_sol: sol,
      total_earned_wld: wld,
      total_earned_usd: usd,
      total_completed: entry.total_completed,
    };
  });
}

// ---------- World ID ----------

export async function verifyWorldId(): Promise<{ verified: true }> {
  const json = await api<{ ok: boolean; user: ApiUser }>("/api/users/verify", {
    method: "POST",
    body: {},
  });
  setCachedUser(json.user);
  return { verified: true };
}

export async function verifyWorldIdWithProof(input: {
  rp_id: string;
  idkit_response: Record<string, unknown>;
}): Promise<{ verified: true }> {
  const json = await api<{ ok: boolean; user: ApiUser }>("/api/users/verify", {
    method: "POST",
    body: input,
  });
  setCachedUser(json.user);
  return { verified: true };
}

export async function createWorldIdRpContext(action?: string): Promise<WorldRpContextResponse> {
  return api<WorldRpContextResponse>("/api/users/world/rp-context", {
    method: "POST",
    body: action ? { action } : {},
  });
}

export function getWorldIdStatus(): boolean {
  if (typeof window === "undefined") return false;
  const raw = window.localStorage.getItem("cleanr.user_cache.v1");
  if (!raw) return false;
  try {
    return Boolean((JSON.parse(raw) as ApiUser).verified);
  } catch {
    return false;
  }
}

export function resetState() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem("cleanr.user_id.v1");
  window.localStorage.removeItem("cleanr.user_cache.v1");
  window.localStorage.removeItem(SESSION_CACHE_KEY);
  // Also remove any session pointers that pages stash per bounty.
  for (let i = window.localStorage.length - 1; i >= 0; i--) {
    const key = window.localStorage.key(i);
    if (!key) continue;
    if (
      key.startsWith("cleanr.session.") ||
      key.startsWith("cleanr.cleanup.") ||
      key.startsWith("cleanr.pending.") ||
      key.startsWith("cleanr.result.")
    ) {
      window.localStorage.removeItem(key);
    }
  }
}

// ---------- Internal ----------

async function ensureVerified(): Promise<void> {
  const me = await ensureUser();
  if (me.verified) return;
  // Auto-verify in dev/demo mode. The backend accepts an empty body and
  // generates a placeholder hash so the bounty/claim/cleanup flow can run
  // before a real World ID SDK is wired in.
  await verifyWorldId();
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number };
  return e.status === 404;
}
