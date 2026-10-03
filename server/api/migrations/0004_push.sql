create table push_tokens (
  device_key text primary key references devices (key) on delete cascade,
  platform text not null check (platform in ('apns', 'fcm')),
  app text not null check (app in ('production', 'dev')),
  apns_environment text check (apns_environment in ('sandbox', 'production')),
  token text not null,
  updated_at timestamptz not null default now(),
  last_ok_at timestamptz,
  failures integer not null default 0,
  check ((platform = 'apns') = (apns_environment is not null))
);

create unique index push_tokens_by_token on push_tokens (token);
