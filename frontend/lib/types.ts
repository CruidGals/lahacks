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

export type Bounty = {
  id: string;
  title: string;
  description: string;
  lat: number;
  lng: number;
  address: string;
  reward_sol: number;
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

export type LeaderboardEntry = {
  rank: number;
  user_id: string;
  handle: string;
  avatar_color: string;
  total_earned_sol: number;
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
