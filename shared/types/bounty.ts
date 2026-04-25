export type BountyStatus = 'open' | 'claimed' | 'verifying' | 'completed' | 'cancelled';

export interface Coordinates {
  lat: number;
  lng: number;
}

export interface Bounty {
  id: string;
  title: string;
  description: string;
  location: Coordinates;
  rewardLamports: number;
  posterWallet: string;
  status: BountyStatus;
}
