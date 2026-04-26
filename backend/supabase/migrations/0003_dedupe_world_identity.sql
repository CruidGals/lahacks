-- Fix duplicate World ID nullifiers / World App wallet addresses.
-- Keeps the oldest row (by created_at, then id) for each distinct value and
-- clears duplicates so unique indexes can be applied safely.

-- 1) world_id_hash: one human identifier per account
update public.users u
set
  world_id_hash = null,
  verified = false
where id in (
  select id
  from (
    select
      id,
      row_number() over (
        partition by world_id_hash
        order by created_at asc nulls last, id asc
      ) as rn
    from public.users
    where world_id_hash is not null and trim(world_id_hash) <> ''
  ) sub
  where rn > 1
);

-- 2) world_address: case-insensitive uniqueness (same ETH address = same payout target)
update public.users u
set world_address = null
where id in (
  select id
  from (
    select
      id,
      row_number() over (
        partition by lower(trim(world_address))
        order by created_at asc nulls last, id asc
      ) as rn
    from public.users
    where world_address is not null and trim(world_address) <> ''
  ) sub
  where rn > 1
);

create unique index if not exists users_world_id_hash_unique
  on public.users (world_id_hash)
  where world_id_hash is not null and trim(world_id_hash) <> '';

create unique index if not exists users_world_address_lower_unique
  on public.users (lower(trim(world_address)))
  where world_address is not null and trim(world_address) <> '';
