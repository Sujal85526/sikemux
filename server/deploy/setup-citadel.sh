#!/usr/bin/env bash
# Prepares citadel to run the Sikemux API and web app. Run as root from a copy of this folder:
#   ./setup-citadel.sh <deploy-public-key-file>
# Safe to run again: each step checks what is already there.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
deploy_key="${1:?usage: setup-citadel.sh <deploy-public-key-file>}"
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

PG_VERSION=17
PG_CONF="/etc/postgresql/$PG_VERSION/main"
PG_ADMIN=nodelike

step() { printf '\n== %s\n' "$*"; }

step "users"
id sikemux >/dev/null 2>&1 ||
  useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin sikemux
id sikemux-deploy >/dev/null 2>&1 ||
  useradd --system --create-home --home-dir /var/lib/sikemux-deploy --shell /bin/bash sikemux-deploy
passwd -l sikemux-deploy >/dev/null

step "deploy key, limited to receiving releases"
install -d -m 700 -o sikemux-deploy -g sikemux-deploy /var/lib/sikemux-deploy/.ssh
printf 'restrict,command="/usr/local/lib/sikemux/receive-release" %s\n' "$(tr -d '\n' <"$deploy_key")" \
  >/var/lib/sikemux-deploy/.ssh/authorized_keys
chown sikemux-deploy:sikemux-deploy /var/lib/sikemux-deploy/.ssh/authorized_keys
chmod 600 /var/lib/sikemux-deploy/.ssh/authorized_keys
install -D -m 755 -o root -g root "$here/receive-release" /usr/local/lib/sikemux/receive-release

cat >/etc/sudoers.d/sikemux-deploy <<'EOF'
sikemux-deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart sikemux-api, /usr/bin/journalctl -u sikemux-api -n 50 --no-pager
EOF
chmod 440 /etc/sudoers.d/sikemux-deploy
visudo -cf /etc/sudoers.d/sikemux-deploy

step "folders"
install -d -m 755 -o sikemux-deploy -g sikemux-deploy /srv/sikemux /srv/sikemux/releases
install -d -m 750 -o root -g sikemux /etc/sikemux
if [ ! -f /etc/sikemux/api.env ]; then
  cat >/etc/sikemux/api.env <<'EOF'
HOST=127.0.0.1
PORT=4000
DATABASE_URL=postgresql://sikemux@%2Fvar%2Frun%2Fpostgresql/sikemux
APP_ORIGIN=https://app.sikemux.com
CLERK_ISSUER=https://immense-llama-6668.clerk.accounts.dev
CLERK_MAC_CLIENT_ID=IfRz79s1n2WGOt3J
LOG_LEVEL=info
EOF
fi
chown root:sikemux /etc/sikemux/api.env
chmod 640 /etc/sikemux/api.env

step "database, reachable only by the sikemux users through the local socket"
psql -U "$PG_ADMIN" -d postgres -v ON_ERROR_STOP=1 -q <<'SQL'
select 'create role sikemux login' where not exists (select from pg_roles where rolname = 'sikemux') \gexec
select 'create database sikemux owner sikemux' where not exists (select from pg_database where datname = 'sikemux') \gexec
revoke all on database sikemux from public;
SQL

if ! grep -q '^# sikemux: begin' "$PG_CONF/pg_hba.conf"; then
  cp "$PG_CONF/pg_hba.conf" "$PG_CONF/pg_hba.conf.bak.$(date +%Y%m%d%H%M%S)"
  rules="$(mktemp)"
  cat >"$rules" <<'EOF'
# sikemux: begin
# Only the sikemux service and its deploy user reach the sikemux database, as the sikemux role,
# through the local socket. These come first, so no broader rule below applies to it.
local   sikemux         sikemux                                 peer map=sikemux
local   sikemux         all                                     reject
host    sikemux         all             all                     reject
# sikemux: end

EOF
  first_rule="$(grep -n '^[^#[:space:]]' "$PG_CONF/pg_hba.conf" | head -1 | cut -d: -f1)"
  sed -i "$((first_rule - 1))r $rules" "$PG_CONF/pg_hba.conf"
  rm -f "$rules"
fi
if ! grep -q '^sikemux ' "$PG_CONF/pg_ident.conf"; then
  printf 'sikemux         sikemux                 sikemux\nsikemux         sikemux-deploy          sikemux\n' >>"$PG_CONF/pg_ident.conf"
fi
systemctl reload "postgresql@$PG_VERSION-main"
sudo -u sikemux-deploy psql 'postgresql://sikemux@%2Fvar%2Frun%2Fpostgresql/sikemux' -Atc 'select current_user' |
  grep -qx sikemux
if psql -U "$PG_ADMIN" -d sikemux -c 'select 1' >/dev/null 2>&1; then
  echo "other roles can still reach the sikemux database" >&2
  exit 1
fi

step "service"
install -m 644 "$here/sikemux-api.service" /etc/systemd/system/sikemux-api.service
systemctl daemon-reload
systemctl enable sikemux-api >/dev/null

step "caddy"
install -d -m 755 /etc/caddy/sites
install -m 644 "$here/sikemux.caddy" /etc/caddy/sites/sikemux.caddy
grep -qx 'import /etc/caddy/sites/\*.caddy' /etc/caddy/Caddyfile ||
  printf '\nimport /etc/caddy/sites/*.caddy\n' >>/etc/caddy/Caddyfile
sudo -u caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl reload caddy

step "done"
echo "citadel is ready for the first deploy"
