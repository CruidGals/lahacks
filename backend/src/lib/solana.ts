import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  clusterApiUrl,
  sendAndConfirmTransaction
} from '@solana/web3.js';

type EscrowParams = {
  bountyId?: string;
  posterId?: string;
  posterWallet?: string;
  rewardLamports: number;
};

type PayoutParams = {
  bountyId: string;
  recipientWallet: string;
  cleanupId: string;
  rewardLamports: number;
};

type RefundParams = {
  bountyId: string;
  posterWallet: string;
  cleanupId: string;
  rewardLamports: number;
};

function parseSecretKey(raw: string | undefined, envVarName: string): Uint8Array {
  if (!raw) {
    throw new Error(`Missing required env var ${envVarName}`);
  }

  const trimmed = raw.trim();
  try {
    if (trimmed.startsWith('[')) {
      return Uint8Array.from(JSON.parse(trimmed) as number[]);
    }
    return Uint8Array.from(trimmed.split(',').map((value) => Number(value.trim())));
  } catch {
    throw new Error(`Invalid secret key format for ${envVarName}`);
  }
}

function getConnection(): Connection {
  return new Connection(
    process.env.SOLANA_RPC_URL ?? clusterApiUrl('devnet'),
    'confirmed'
  );
}

function getFunderKeypair(): Keypair {
  return Keypair.fromSecretKey(
    parseSecretKey(process.env.SOLANA_FUNDER_SECRET_KEY, 'SOLANA_FUNDER_SECRET_KEY')
  );
}

function getVaultKeypair(): Keypair {
  return Keypair.fromSecretKey(
    parseSecretKey(process.env.SOLANA_VAULT_SECRET_KEY, 'SOLANA_VAULT_SECRET_KEY')
  );
}

export async function escrowBounty(params: EscrowParams): Promise<string> {
  const connection = getConnection();
  const vault = getVaultKeypair();
  const useFunder = process.env.SET_BOUNTY_WITH_FUNDER?.trim().toLowerCase() === 'true';
  if (!useFunder) {
    if (!params.posterWallet) {
      throw new Error('Poster wallet is required when SET_BOUNTY_WITH_FUNDER=false.');
    }

    const posterPubkey = new PublicKey(params.posterWallet);
    const posterBalance = await connection.getBalance(posterPubkey, 'confirmed');
    if (posterBalance < params.rewardLamports + 5_000) {
      throw new Error(
        `Poster wallet has insufficient balance for bounty + fees. Required ${
          params.rewardLamports + 5_000
        } lamports, found ${posterBalance}.`
      );
    }

    throw new Error(
      `SET_BOUNTY_WITH_FUNDER=false requires a client-signed escrow transfer from poster wallet ${posterPubkey.toBase58()} to vault. Backend cannot debit a wallet from address alone.`
    );
  }

  const signer = getFunderKeypair();
  const signerLabel = 'funder';

  const balance = await connection.getBalance(signer.publicKey, 'confirmed');
  if (balance < params.rewardLamports + 5_000) {
    throw new Error(
      `${signerLabel} wallet has insufficient balance for escrow + fees. Required ${
        params.rewardLamports + 5_000
      } lamports, found ${balance}.`
    );
  }

  const transferIx = SystemProgram.transfer({
    fromPubkey: signer.publicKey,
    toPubkey: vault.publicKey,
    lamports: params.rewardLamports
  });

  const tx = new Transaction().add(transferIx);
  const signature = await sendAndConfirmTransaction(connection, tx, [signer], {
    commitment: 'confirmed'
  });

  const bountyLabel = params.bountyId ?? 'pending-db-id';
  const posterLabel = params.posterId ?? 'unknown-poster';
  console.log(
    `escrow_bounty bounty_id=${bountyLabel} poster_id=${posterLabel} source=${signerLabel} tx=${signature}`
  );
  return signature;
}

export async function releaseBountyToClaimer(
  params: PayoutParams
): Promise<string> {
  const connection = getConnection();
  const vault = getVaultKeypair();
  const recipient = new PublicKey(params.recipientWallet);

  const { value: latestBlockhash } = await connection.getLatestBlockhashAndContext(
    'confirmed'
  );

  const balance = await connection.getBalance(vault.publicKey, 'confirmed');
  if (balance < params.rewardLamports + 5_000) {
    throw new Error('Vault has insufficient balance for payout + fees.');
  }

  const transferIx = SystemProgram.transfer({
    fromPubkey: vault.publicKey,
    toPubkey: recipient,
    lamports: params.rewardLamports
  });

  const tx = new Transaction({
    feePayer: vault.publicKey,
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
  }).add(transferIx);

  const signature = await sendAndConfirmTransaction(connection, tx, [vault], {
    commitment: 'confirmed'
  });

  console.log(
    `release_bounty bounty_id=${params.bountyId} cleanup_id=${params.cleanupId} tx=${signature}`
  );
  return signature;
}

export async function refundEscrowToPoster(params: RefundParams): Promise<string> {
  const connection = getConnection();
  const vault = getVaultKeypair();
  const recipient = new PublicKey(params.posterWallet);

  const { value: latestBlockhash } = await connection.getLatestBlockhashAndContext(
    'confirmed'
  );

  const balance = await connection.getBalance(vault.publicKey, 'confirmed');
  if (balance < params.rewardLamports + 5_000) {
    throw new Error('Vault has insufficient balance for refund + fees.');
  }

  const transferIx = SystemProgram.transfer({
    fromPubkey: vault.publicKey,
    toPubkey: recipient,
    lamports: params.rewardLamports
  });

  const tx = new Transaction({
    feePayer: vault.publicKey,
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
  }).add(transferIx);

  const signature = await sendAndConfirmTransaction(connection, tx, [vault], {
    commitment: 'confirmed'
  });

  console.log(
    `refund_bounty bounty_id=${params.bountyId} cleanup_id=${params.cleanupId} tx=${signature}`
  );
  return signature;
}
