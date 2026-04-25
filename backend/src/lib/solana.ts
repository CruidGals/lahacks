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
  bountyId: string;
  posterId: string;
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
  const funder = getFunderKeypair();
  const vault = getVaultKeypair();

  const transferIx = SystemProgram.transfer({
    fromPubkey: funder.publicKey,
    toPubkey: vault.publicKey,
    lamports: params.rewardLamports
  });

  const tx = new Transaction().add(transferIx);
  const signature = await sendAndConfirmTransaction(connection, tx, [funder], {
    commitment: 'confirmed'
  });

  console.log(
    `escrow_bounty bounty_id=${params.bountyId} poster_id=${params.posterId} tx=${signature}`
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
