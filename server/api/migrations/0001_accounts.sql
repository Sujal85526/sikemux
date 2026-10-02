create table users (
  id text primary key,
  created_at timestamptz not null default now()
);

create table devices (
  key text primary key check (key ~ '^[0-9a-f]{64}$'),
  user_id text not null references users (id) on delete cascade,
  role text not null check (role in ('host', 'client')),
  name text not null check (length(name) between 1 and 64),
  platform text not null,
  channel text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create index devices_by_user on devices (user_id, created_at desc);

create table challenges (
  nonce text primary key,
  user_id text not null,
  expires_at timestamptz not null
);

create index challenges_by_expiry on challenges (expires_at);

create table audit (
  id bigserial primary key,
  user_id text,
  actor text not null,
  action text not null,
  subject text,
  detail jsonb not null default '{}',
  at timestamptz not null default now()
);

create index audit_by_user on audit (user_id, at desc);
