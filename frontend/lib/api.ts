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
  RewardType,
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
  reward_type: RewardType;
  reward_sol: number;
  reward_xp: number | null;
  reward_wld: number;
  reward_wld_wei: string | null;
  xp_award: number;
  difficulty_score: number | null;
  importance_score: number | null;
  xp_reasoning: string | null;
  title: string | null;
  description: string | null;
  reference_video_url: string | null;
  status: BackendBountyStatus;
  urgency_score: number;
  created_at: string | null;
  claimed_at: string | null;
  escrow_tx_sig: string | null;
  world_pay_tx_hash: string | null;
  poster?: {
    id: string;
    wallet_address: string;
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
  xp: number;
  total_earned_xp: number;
  total_earned_sol: number;
  total_earned_lamports: number;
  total_earned_wld: number;
  total_earned_wld_wei: string;
  total_completed: number;
  current_streak: number;
  wallet: { address: string; balance_sol: number };
  world_wallet_address: string | null;
  recent_completed: Array<{
    bounty_id: string;
    title: string;
    reward_type: RewardType;
    reward_sol: number;
    reward_xp: number | null;
    reward_wld: number;
    xp_award: number;
    completed_at: string;
  }>;
};

type BackendLeaderboardItem = {
  rank: number;
  user_id: string;
  handle: string;
  avatar_color: string;
  total_xp: number;
  total_earned_sol: number;
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

// Rough USD-conversion factors used purely for sort/UX hints. Not a price
// oracle -- both fluctuate. Keep these aligned (within an order of magnitude)
// with the SOL_USD_RATE constant up top.
const WLD_USD_RATE = 2.5;

function mapBounty(b: BackendBounty): Bounty {
  const status: BountyStatus = b.status;
  const claimLockUntil = b.claimed_at
    ? addHours(b.claimed_at, CLAIM_LOCK_HOURS)
    : undefined;
  const posterId = b.poster?.id ?? b.poster_id ?? "anon";
  const rewardType: RewardType = b.reward_type ?? "sol";
  const rewardSol = b.reward_sol ?? 0;
  const rewardWld = b.reward_wld ?? 0;

  // Pick the right currency for the USD estimate so the map cards never
  // show "$0" for a 1 WLD bounty just because we forgot to branch here.
  const usdEstimate =
    rewardType === "sol"
      ? Math.round(rewardSol * SOL_USD_RATE)
      : rewardType === "wld"
        ? Math.round(rewardWld * WLD_USD_RATE)
        : 0;

  return {
    id: b.id,
    title: b.title?.trim() || deriveTitle(b.description),
    description: deriveDescriptionBody(b.description),
    lat: b.lat,
    lng: b.lng,
    address: deriveAddress(b.lat, b.lng),
    reward_type: rewardType,
    reward_sol: rewardSol,
    reward_xp: b.reward_xp ?? null,
    reward_wld: rewardWld,
    reward_wld_wei: b.reward_wld_wei ?? null,
    xp_award: b.xp_award ?? 0,
    difficulty_score: b.difficulty_score ?? null,
    importance_score: b.importance_score ?? null,
    reward_usd_estimate: usdEstimate,
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

export type PostBountyInput = {
  title: string;
  description: string;
  lat: number;
  lng: number;
  address: string;
  category: Bounty["category"];
  reference_video_url: string | null;
  reference_thumbnail_url: string | null;
} & (
  | { reward_type: "sol"; reward_sol: number; reward_xp?: undefined; reward_wld?: undefined }
  | { reward_type: "xp"; reward_xp: number; reward_sol?: undefined; reward_wld?: undefined }
  | { reward_type: "wld"; reward_wld: number; reward_sol?: undefined; reward_xp?: undefined }
);

export type XpEvaluation = {
  xp_award: number;
  difficulty_score: number;
  importance_score: number;
  reasoning: string;
  source: "ai" | "fallback";
};

export type PostBountyResult = {
  bounty: Bounty;
  xp_evaluation: XpEvaluation;
  /**
   * For WLD bounties only: the on-chain transaction hash from the
   * `MiniKit.pay()` -> vault transfer, after the backend has verified it
   * against the Developer Portal. Null for SOL/XP bounties.
   */
  world_pay_tx_hash?: string | null;
};

export async function postBounty(
  input: PostBountyInput
): Promise<PostBountyResult> {
  await ensureVerified();

  // The backend stores only `description`, so we encode the title on the first
  // line and the category as a `#category:foo` tag. mapBounty() reverses this.
  // We *also* send `title` and `category` as top-level fields so the AI XP
  // pipeline can use them, but the legacy encoding stays for SOL bounties
  // already in the DB that rely on it.
  const description = [
    input.title.trim(),
    input.description.trim(),
    `#category:${input.category}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const body: Record<string, unknown> = {
    lat: input.lat,
    lng: input.lng,
    title: input.title.trim() || undefined,
    category: input.category,
    description,
    reference_video_url: input.reference_video_url ?? null,
  };

  if (input.reward_type === "sol") {
    body.reward_sol = input.reward_sol;
  } else if (input.reward_type === "xp") {
    body.reward_xp = input.reward_xp;
  } else {
    // WLD path: must run inside World App. We sign `MiniKit.pay()` to the
    // backend vault FIRST, get back a `transactionId` + `reference`, then
    // POST to /api/bounties so the backend can verify the payment via the
    // World Developer Portal before persisting. Doing the payment first
    // gives us a consistent failure model: if MiniKit throws, no bounty
    // record is ever created and the user has lost no funds.
    //
    // We dynamic-import the helper so SSR builds don't try to load
    // `@worldcoin/minikit-js` at module-eval time.
    const { payWldEscrow, syncWorldWalletAddress } = await import("./world");

    // Best-effort: make sure the backend has the user's World wallet on
    // file. The backend will need it for refunds if this bounty is later
    // rejected, and at the latest by the next time *any* WLD bounty is
    // posted by this user. Failure is non-fatal; we proceed.
    void syncWorldWalletAddress();

    const escrow = await payWldEscrow({
      amountWld: input.reward_wld,
      description: `Bounty: ${input.title.trim() || "Cleanup task"}`,
    });
    body.reward_wld = input.reward_wld;
    body.world_pay_transaction_id = escrow.transactionId;
    body.world_payment_reference = escrow.reference;
  }

  const json = await api<{
    bounty: BackendBounty;
    escrow_tx_sig: string | null;
    world_pay_tx_hash?: string | null;
    xp_evaluation: XpEvaluation;
  }>("/api/bounties", {
    method: "POST",
    body,
  });

  return {
    bounty: mapBounty(json.bounty),
    xp_evaluation: json.xp_evaluation,
    world_pay_tx_hash: json.world_pay_tx_hash ?? null,
  };
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

/**
 * Base URL of the Python AI service (no trailing slash). Used for
 * ``/upload-fixture`` and ``/verify-progress/:cleanup_id``. Set
 * ``NEXT_PUBLIC_AI_FIXTURE_UPLOAD_URL`` to that origin, e.g.
 * ``http://127.0.0.1:8001``.
 */
export function getAiFixtureServiceBaseUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_AI_FIXTURE_UPLOAD_URL;
  if (!raw?.trim()) return null;
  return raw.replace(/\/+$/, "");
}

export type VerificationProgress = {
  cleanup_id: string;
  phase: string;
  percent: number;
  detail: string;
  updated_at: number | null;
};

/**
 * Poll live fixture-pipeline status from the AI service (same phases / copy as
 * uvicorn logs: ``fixture_verification_start``, ``fixture_stage1_*``, etc.).
 * Returns null if the base URL is not set or the request fails.
 */
export async function fetchVerificationProgress(
  cleanupId: string
): Promise<VerificationProgress | null> {
  const base = getAiFixtureServiceBaseUrl();
  if (!base) return null;
  const url = `${base}/verify-progress/${encodeURIComponent(cleanupId)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as VerificationProgress;
  } catch {
    return null;
  }
}

export type FixtureKind = "submission" | "request";

/**
 * Set ``USE_DEMO_VIDEO=true`` in ``.env.local`` (exposed via ``next.config``)
 * to skip real uploads. The AI service should use ``USE_DEMO_VIDEO=true`` so
 * it reads ``data/videos/fixtures/sample``; when off, the verifier uses
 * ``data/videos/fixtures/eg{Request,UserPost}.MOV`` (upload targets). Also
 * supported: ``NEXT_PUBLIC_USE_DEMO_VIDEO`` without next.config.
 */
export function isUseDemoVideo(): boolean {
  const v = String(
    process.env.USE_DEMO_VIDEO ?? process.env.NEXT_PUBLIC_USE_DEMO_VIDEO ?? ""
  )
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Upload a recorded clip to one of the AI service's fixture slots.
 *
 * `kind="submission"` (default) overwrites the claimer "after" fixture used
 * by Stage 2 — call this from the verify page before submitting the cleanup
 * so the verdict reflects the user's actual recording.
 *
 * `kind="request"` overwrites the poster "before" fixture used by Stage 1.
 * Replacing it invalidates the in-process GroundTruthSpec cache, so the next
 * verification re-derives the ground truth from the new reference video.
 */
export async function uploadFixtureVideo(
  blob: Blob,
  kind: FixtureKind = "submission"
): Promise<{
  kind: FixtureKind;
  saved_path: string;
  bytes_written: number;
  content_type: string | null;
  demo_mode?: boolean;
}> {
  if (isUseDemoVideo()) {
    if (!blob || blob.size === 0) {
      throw new Error("Recorded clip is empty.");
    }
    return {
      kind,
      saved_path: "data/videos/fixtures/sample (demo; upload skipped)",
      bytes_written: 0,
      content_type: null,
      demo_mode: true,
    };
  }

  const baseRaw = process.env.NEXT_PUBLIC_AI_FIXTURE_UPLOAD_URL;
  if (!baseRaw) {
    throw new Error(
      "AI fixture upload URL is not configured (set NEXT_PUBLIC_AI_FIXTURE_UPLOAD_URL)."
    );
  }
  if (!blob || blob.size === 0) {
    throw new Error("Recorded clip is empty.");
  }

  const base = baseRaw.replace(/\/+$/, "");
  const url = `${base}/upload-fixture`;

  const mime = blob.type || "video/mp4";
  const ext = mime.includes("mp4")
    ? "mp4"
    : mime.includes("webm")
    ? "webm"
    : mime.includes("quicktime")
    ? "mov"
    : "bin";
  const filename = `${kind}.${ext}`;

  const formData = new FormData();
  formData.append("file", blob, filename);
  formData.append("kind", kind);

  const res = await fetch(url, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
    }
    throw new Error(
      `Fixture upload failed (${res.status})${detail ? `: ${detail}` : ""}`
    );
  }

  return (await res.json()) as {
    kind: FixtureKind;
    saved_path: string;
    bytes_written: number;
    content_type: string | null;
  };
}

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
      label: "AI reasoning",
      status: passed ? "pass" : "fail",
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
    xp: u.xp ?? 0,
    total_earned_xp: u.total_earned_xp ?? 0,
    total_earned_sol: u.total_earned_sol,
    total_earned_wld: u.total_earned_wld ?? 0,
    total_completed: u.total_completed,
    current_streak: u.current_streak,
    wallet: {
      address: u.wallet?.address ?? u.wallet_address,
      balance_sol: u.wallet?.balance_sol ?? u.total_earned_sol,
    },
    world_wallet_address: u.world_wallet_address ?? null,
    recent_completed: (u.recent_completed ?? []).map((c) => ({
      bounty_id: c.bounty_id,
      title: c.title,
      reward_type: c.reward_type ?? "sol",
      reward_sol: c.reward_sol ?? 0,
      reward_xp: c.reward_xp ?? null,
      reward_wld: c.reward_wld ?? 0,
      xp_award: c.xp_award ?? 0,
      completed_at: c.completed_at,
    })),
  };
}

export async function getCurrentUserId(): Promise<string> {
  const me = await ensureUser();
  return me.id;
}

export async function getLeaderboard(
  tf: Timeframe = "all"
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
    total_xp: entry.total_xp ?? 0,
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
