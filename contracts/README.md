# Solana Contracts Scaffold

This folder is prepared for an Anchor-based Solana program.

## Planned modules

- `programs/cleanup-bounty/`: escrow + payout program
- `tests/`: integration tests for claim + release flow

## Suggested next steps

1. Initialize Anchor workspace.
2. Define bounty PDA and claim account schema.
3. Implement `fund_bounty`, `claim_bounty`, `release_bounty` instructions.
4. Add tests for timeout and failed verification handling.
