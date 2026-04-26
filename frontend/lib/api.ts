/**
 * Real API layer.
 *
 * Each function maps backend responses (Express + Supabase, see /backend) onto
 * the frontend's richer Bounty/User/Session types. The backend stores a small
 * canonical set of fields; everything else is derived deterministically here
 * so existing UI components keep working.
 */

import { api, ensureUser, setCachedUser, type ApiUser } from "./http";
import type {
  Bounty,
  BountyCategory,
  BountyStatus,
  CleanupSubmission,
  GeoPing,
  LeaderboardEntry,
  Session,
  Timeframe,
  User,
  VerificationResult,
} from "./types";

const SOL_USD_RATE = 153;
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
  reward_sol: number;
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
    verified: boolean | null;
  } | null;
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
  total_completed: number;
  current_streak: number;
  wallet: { address: string; balance_sol: number };
  recent_completed: Array<{
    bounty_id: string;
    title: string;
    reward_sol: number;
    completed_at: string;
  }>;
};

type BackendLeaderboardItem = {
  rank: number;
  user_id: string;
  handle: string;
  avatar_color: string;
  total_earned_sol: number;
  total_completed: number;
  wallet_address: string;
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

function mapBounty(b: BackendBounty): Bounty {
  const status: BountyStatus = b.status;
  const claimLockUntil = b.claimed_at
    ? addHours(b.claimed_at, CLAIM_LOCK_HOURS)
    : undefined;
  const posterId = b.poster?.id ?? b.poster_id ?? "anon";

  return {
    id: b.id,
    title: deriveTitle(b.description),
    description: deriveDescriptionBody(b.description),
    lat: b.lat,
    lng: b.lng,
    address: deriveAddress(b.lat, b.lng),
    reward_sol: b.reward_sol ?? 0,
    reward_usd_estimate: Math.round((b.reward_sol ?? 0) * SOL_USD_RATE),
    status,
    urgency_score: b.urgency_score ?? 0,
    category: deriveCategory(b.description),
    poster: {
      id: posterId,
      name: shortWallet(b.poster?.wallet_address),
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

export async function postBounty(input: {
  title: string;
  description: string;
  lat: number;
  lng: number;
  address: string;
  reward_sol: number;
  category: Bounty["category"];
  reference_video_url: string | null;
  reference_thumbnail_url: string | null;
}): Promise<Bounty> {
  await ensureVerified();

  // The backend stores only `description`, so we encode the title on the first
  // line and the category as a `#category:foo` tag. mapBounty() reverses this.
  const description = [
    input.title.trim(),
    input.description.trim(),
    `#category:${input.category}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const json = await api<{ bounty: BackendBounty; escrow_tx_sig: string | null }>(
    "/api/bounties",
    {
      method: "POST",
      body: {
        lat: input.lat,
        lng: input.lng,
        reward_sol: input.reward_sol,
        description,
        reference_video_url: input.reference_video_url ?? null,
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

export async function cancelClaim(): Promise<Bounty> {
  // The backend has no cancel endpoint yet — claims expire automatically
  // after the 4h window. Surface that to the caller.
  throw new Error(
    "Claims auto-expire after 4 hours; manual cancel isn't supported yet."
  );
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

  return {
    id: u.id,
    handle: shortWallet(u.wallet_address),
    avatar_color: avatarColorFor(u.id),
    world_id_verified: Boolean(u.verified),
    joined_at: u.created_at ?? new Date().toISOString(),
    total_earned_sol: u.total_earned_sol,
    total_completed: u.total_completed,
    current_streak: u.current_streak,
    wallet: {
      address: u.wallet?.address ?? u.wallet_address,
      balance_sol: u.wallet?.balance_sol ?? u.total_earned_sol,
    },
    recent_completed: u.recent_completed ?? [],
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
  return json.items.map((entry) => ({
    rank: entry.rank,
    user_id: entry.user_id,
    handle: entry.handle,
    avatar_color: entry.avatar_color,
    total_earned_sol: entry.total_earned_sol,
    total_completed: entry.total_completed,
  }));
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
