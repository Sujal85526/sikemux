create table updates (
  id uuid primary key,
  platform text not null check (platform in ('android', 'ios')),
  runtime_version text not null check (
    length(runtime_version) <= 256 and runtime_version ~ '^[A-Za-z0-9._+-]+$'
  ),
  created_at timestamptz not null,
  manifest bytea not null,
  signature text not null,
  commit text not null check (commit ~ '^[0-9a-f]{40}$'),
  message text not null,
  published_at timestamptz not null default now()
);

create index updates_by_runtime on updates (platform, runtime_version, created_at desc);

create table update_channels (
  update_id uuid not null references updates (id) on delete cascade,
  channel text not null check (channel in ('nightly', 'stable')),
  assigned_at timestamptz not null default now(),
  primary key (channel, update_id)
);
