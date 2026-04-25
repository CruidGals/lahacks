/**
 * Mock API layer.
 * Each function below mirrors the eventual backend contract one-for-one,
 * so swapping to real `fetch()` calls is a single-file change later.
 */

import type {
  Bounty,
  CleanupSubmission,
  GeoPing,
  LeaderboardEntry,
  Session,
  Timeframe,
  User,
  VerificationResult,
} from "./types";
import { MOCK_BOUNTIES, MOCK_LEADERBOARD, MOCK_USER } from "./mock-data";

const STORAGE_KEY = "cleanr.state.v1";

type LocalState = {
  bounties: Bounty[];
  user: User;
  sessions: Record<string, Session>;
  worldIdVerified: boolean;
};

function loadState(): LocalState {
  if (typeof window === "undefined") {
    return {
      bounties: MOCK_BOUNTIES,
      user: MOCK_USER,
      sessions: {},
      worldIdVerified: false,
    };
  }
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as LocalState;
    } catch {
      // fall through and reseed
    }
  }
  const seed: LocalState = {
    bounties: MOCK_BOUNTIES,
    user: MOCK_USER,
    sessions: {},
    worldIdVerified: false,
  };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
  return seed;
}

function saveState(s: LocalState) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

function delay<T>(value: T, ms = 250): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

// ---------- Bounties ----------

export async function getBounties(): Promise<Bounty[]> {
  const s = loadState();
  return delay(s.bounties);
}

export async function getBounty(id: string): Promise<Bounty | null> {
  const s = loadState();
  return delay(s.bounties.find((b) => b.id === id) ?? null);
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
  const s = loadState();
  const newBounty: Bounty = {
    id: uid("bnty"),
    title: input.title,
    description: input.description,
    lat: input.lat,
    lng: input.lng,
    address: input.address,
    reward_sol: input.reward_sol,
    reward_usd_estimate: Math.round(input.reward_sol * 153),
    status: "open",
    urgency_score: 60,
    category: input.category,
    poster: {
      id: s.user.id,
      name: s.user.handle,
      avatar_color: s.user.avatar_color,
      is_org: false,
    },
    reference_video_url: input.reference_video_url,
    reference_thumbnail_url: input.reference_thumbnail_url,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 48 * 3600_000).toISOString(),
  };
  s.bounties = [newBounty, ...s.bounties];
  saveState(s);
  return delay(newBounty, 700);
}

export async function claimBounty(id: string): Promise<Bounty> {
  const s = loadState();
  const idx = s.bounties.findIndex((b) => b.id === id);
  if (idx === -1) throw new Error("Bounty not found");
  s.bounties[idx] = {
    ...s.bounties[idx],
    status: "claimed",
    claimed_by: s.user.id,
    claim_lock_until: new Date(Date.now() + 4 * 3600_000).toISOString(),
  };
  saveState(s);
  return delay(s.bounties[idx], 500);
}

export async function cancelClaim(id: string): Promise<Bounty> {
  const s = loadState();
  const idx = s.bounties.findIndex((b) => b.id === id);
  if (idx === -1) throw new Error("Bounty not found");
  s.bounties[idx] = {
    ...s.bounties[idx],
    status: "open",
    claimed_by: undefined,
    claim_lock_until: undefined,
  };
  saveState(s);
  return delay(s.bounties[idx], 350);
}

// ---------- Sessions ----------

export async function startSession(bountyId: string): Promise<Session> {
  const s = loadState();
  const idx = s.bounties.findIndex((b) => b.id === bountyId);
  if (idx === -1) throw new Error("Bounty not found");
  const session: Session = {
    id: uid("sess"),
    bounty_id: bountyId,
    user_id: s.user.id,
    nonce: Math.random().toString(36).slice(2, 10).toUpperCase(),
    started_at: new Date().toISOString(),
    status: "active",
    pings: [],
  };
  s.sessions[session.id] = session;
  s.bounties[idx] = { ...s.bounties[idx], status: "in_progress" };
  saveState(s);
  return delay(session, 400);
}

export async function pingSession(sessionId: string, ping: GeoPing): Promise<void> {
  const s = loadState();
  const session = s.sessions[sessionId];
  if (!session) return;
  session.pings.push(ping);
  saveState(s);
}

export async function getSession(id: string): Promise<Session | null> {
  const s = loadState();
  return delay(s.sessions[id] ?? null, 50);
}

export async function submitCleanup(
  input: CleanupSubmission
): Promise<{ session: Session; verification: VerificationResult }> {
  const s = loadState();
  const session = s.sessions[input.session_id];
  if (!session) throw new Error("Session not found");
  session.status = "submitted";
  saveState(s);

  // Simulate verifier latency (3.5s)
  await new Promise((r) => setTimeout(r, 3500));

  const verification: VerificationResult = {
    passed: true,
    confidence: 0.94,
    checks: [
      { label: "Location trajectory", status: "pass", detail: "Within 12 m of pin" },
      { label: "Time on site", status: "pass", detail: "8 min 22 s" },
      { label: "Nonce watermark", status: "pass" },
      { label: "Reference frame match", status: "pass", detail: "Structural similarity 0.91" },
      { label: "Before/after change", status: "pass", detail: "Trash detected → cleared" },
      { label: "Street View cross-check", status: "pass" },
    ],
    reward_tx_signature: "5xK3...zR9P",
  };

  // Apply payout
  const idx = s.bounties.findIndex((b) => b.id === input.bounty_id);
  if (idx >= 0) {
    s.bounties[idx] = { ...s.bounties[idx], status: "completed" };
  }
  session.status = "verified";
  s.user = {
    ...s.user,
    total_earned_sol: +(s.user.total_earned_sol + (s.bounties[idx]?.reward_sol ?? 0)).toFixed(2),
    total_completed: s.user.total_completed + 1,
    wallet: {
      ...s.user.wallet,
      balance_sol: +(s.user.wallet.balance_sol + (s.bounties[idx]?.reward_sol ?? 0)).toFixed(2),
    },
  };
  saveState(s);

  return { session, verification };
}

// ---------- Users / leaderboard ----------

export async function getMe(): Promise<User> {
  const s = loadState();
  return delay(s.user, 200);
}

export async function getLeaderboard(_tf: Timeframe = "week"): Promise<LeaderboardEntry[]> {
  return delay(MOCK_LEADERBOARD, 250);
}

// ---------- World ID ----------

export async function verifyWorldId(): Promise<{ verified: true }> {
  const s = loadState();
  s.worldIdVerified = true;
  s.user = { ...s.user, world_id_verified: true };
  saveState(s);
  return delay({ verified: true }, 1200);
}

export function getWorldIdStatus(): boolean {
  const s = loadState();
  return s.worldIdVerified;
}

export function resetState() {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(STORAGE_KEY);
  }
}
