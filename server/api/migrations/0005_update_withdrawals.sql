alter table update_channels add column withdrawn_at timestamptz;

create table update_rollbacks (
  id bigint generated always as identity primary key,
  update_id uuid not null references updates (id) on delete cascade,
  platform text not null check (platform in ('android', 'ios')),
  runtime_version text not null,
  channel text not null check (channel in ('nightly', 'stable')),
  directive bytea not null,
  signature text not null,
  commit_time timestamptz not null,
  assigned_at timestamptz not null default now()
);

create index update_rollbacks_by_runtime on update_rollbacks (
  platform, runtime_version, channel, assigned_at desc
);
