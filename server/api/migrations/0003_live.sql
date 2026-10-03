alter table users
  add column deleted_at timestamptz,
  add column clerk_deleted_at timestamptz,
  add column clerk_attempts integer not null default 0,
  add column clerk_retry_at timestamptz,
  add column purge_after timestamptz,
  add column events_pruned_through bigint not null default 0;

create index users_awaiting_clerk on users (clerk_retry_at)
  where deleted_at is not null and clerk_deleted_at is null;
create index users_to_purge on users (purge_after) where purge_after is not null;

create table events (
  id bigserial primary key,
  user_id text not null references users (id) on delete cascade,
  type text not null check (
    type in ('device.added', 'device.changed', 'device.revoked', 'account.deleted')
  ),
  subject text,
  subject_role text check (subject_role in ('host', 'client')),
  reason text check (reason in ('removed', 'signed_out', 'account_deleted')),
  at timestamptz not null default now()
);

create index events_by_user on events (user_id, id);
create index events_by_age on events (at);

alter table devices
  add column acked_event_id bigint not null default 0,
  add column clerk_session_id text;

create table removed_devices (
  key text primary key,
  user_id text not null references users (id) on delete cascade,
  role text not null check (role in ('host', 'client')),
  reason text not null check (reason in ('removed', 'signed_out', 'account_deleted')),
  acked_event_id bigint not null,
  clerk_session_id text,
  clerk_revoked_at timestamptz,
  clerk_attempts integer not null default 0,
  clerk_retry_at timestamptz,
  removed_at timestamptz not null default now()
);

create index removed_devices_by_age on removed_devices (removed_at);
create index removed_devices_by_user on removed_devices (user_id);
create index removed_devices_by_session on removed_devices (clerk_session_id)
  where clerk_session_id is not null;
create index removed_devices_awaiting_clerk on removed_devices (clerk_retry_at)
  where clerk_session_id is not null and clerk_revoked_at is null;

create index audit_by_age on audit (at);
