export type BountyStatus =
  | "open"
  | "claimed"
  | "in_progress"
  | "verifying"
  | "completed"
  | "expired";

export type BountyCategory =
  | "litter"
  | "graffiti"
  | "illegal_dumping"
  | "park"
  | "beach"
  | "other";

/**
 * Both currencies the marketplace supports. WLD lives on World Chain (ERC-20)
 * and is paid via the MiniKit pay flow; SOL lives on Solana and is escrowed
 * server-side from a backend-funded vault.
 */
export type Currency = "WLD" | "SOL";

export type Bounty = {
  id: string;
  title: string;
  description: string;
  lat: number;
  lng: number;
  address: string;
  /** Native amount in the bounty's `reward_currency`. */
  reward: number;
  reward_currency: Currency;
  /**
   * Convenience: same value as `reward` when `reward_currency === "SOL"`,
   * otherwise 0. Kept so older UI surfaces don't crash; new UI should read
   * `reward` + `reward_currency` instead.
   */
  reward_sol: number;
  /** Same idea as `reward_sol`, mirrored for WLD. */
  reward_wld: number;
  reward_usd_estimate: number;
  status: BountyStatus;
  urgency_score: number; // 0..100
  category: BountyCategory;
  poster: {
    id: string;
    name: string;
    avatar_color: string;
    is_org: boolean;
  };
  reference_video_url: string | null;
  reference_thumbnail_url: string | null;
  created_at: string; // ISO
  expires_at: string; // ISO
  claimed_by?: string;
  claim_lock_until?: string; // ISO
};

export type Session = {
  id: string;
  bounty_id: string;
  user_id: string;
  nonce: string;
  started_at: string;
  status: "active" | "submitted" | "verified" | "rejected";
  pings: GeoPing[];
};

export type GeoPing = {
  lat: number;
  lng: number;
  accuracy_m: number;
  ts: string;
};

export type User = {
  id: string;
  handle: string;
  avatar_color: string;
  world_id_verified: boolean;
  joined_at: string;
  total_earned_sol: number;
  total_earned_wld: number;
  total_completed: number;
  current_streak: number;
  wallet: {
    /** Solana wallet that receives SOL payouts and refunds. */
    address: string;
    /** Linked World App wallet for WLD payouts/refunds (null if not linked). */
    world_address: string | null;
    balance_sol: number;
    balance_wld: number;
  };
  recent_completed: Array<{
    bounty_id: string;
    title: string;
    reward: number;
    reward_currency: Currency;
    completed_at: string;
  }>;
};

export type LeaderboardEntry = {
  rank: number;
  user_id: string;
  handle: string;
  avatar_color: string;
  total_earned_sol: number;
  total_earned_wld: number;
  total_earned_usd: number;
  total_completed: number;
};

export type Timeframe = "week" | "month" | "all";

export type CleanupSubmission = {
  session_id: string;
  bounty_id: string;
  video_blob_url: string;
  end_lat: number;
  end_lng: number;
  ended_at: string;
};

export type VerificationResult = {
  passed: boolean;
  confidence: number;
  checks: Array<{
    label: string;
    status: "pass" | "fail" | "skipped";
    detail?: string;
  }>;
  reward_tx_signature?: string;
};
