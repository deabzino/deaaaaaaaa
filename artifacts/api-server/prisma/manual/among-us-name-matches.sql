begin;

create table if not exists public.among_us_name_matches (
  guild_id text not null,
  normalized_name text not null,
  discord_user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (guild_id, normalized_name)
);

create index if not exists among_us_name_matches_user_idx
  on public.among_us_name_matches (guild_id, discord_user_id);

alter table public.among_us_name_matches enable row level security;
revoke all on table public.among_us_name_matches from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.among_us_name_matches to service_role;

commit;
