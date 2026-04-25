use anchor_lang::prelude::*;

declare_id!("ReplaceWithProgramId");

#[program]
pub mod cleanup_bounty {
    use super::*;

    pub fn initialize(_ctx: Context<Initialize>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
