#!/usr/bin/env bash
# One-command, idempotent production launch on a single Docker host.
#
#   make bootstrap-prod                                   # prompts for what's missing
#   ERP_HOST=erp.example.com ACME_EMAIL=ops@example.com make bootstrap-prod
#   EERP_IMAGE_TAG=0.102.0 make bootstrap-prod            # upgrade: a new tag is pulled
#   PULL=1 make bootstrap-prod                            # re-pull the current tags (e.g. latest)
#
# Run it on the server, in a checkout of this repository. It:
# 0. Checks, before touching anything, that every tool and file it needs is there
#    and that Docker is running — listing everything missing at once.
# 1. Collects the settings — ERP_HOST (required), ACME_EMAIL, SITE_HOST (the public
#    website's own host, optional), EERP_IMAGE_TAG (default latest; a CI build number
#    such as 0.101.0 pins a release), CERT_MODE (letsencrypt | proxy), optional
#    SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD/SMTP_FROM/SMTP_TLS — from the
#    environment, else the .env of a previous run, else a prompt, and saves them in
#    .env so a re-run needs nothing.
# 2. Generates the secrets (database password, master key, S3 key pair, Garage RPC
#    secret) into .env when missing — never rotated by a re-run (ROTATE=1 does).
# 3. Writes eerp-config.prod.json from its template (secrets, site_url, SMTP).
# 4. Pulls only the images this host doesn't have yet (every run reuses the local
#    ones; PULL=1 refreshes them all), starts the infrastructure, sets the database
#    password, installs pg_trgm, initializes Garage, starts the app and waits until
#    healthy.
# 5. HTTPS, two ways (CERT_MODE):
#    - proxy: a reverse proxy in front of EERP (Traefik, Caddy, nginx, a CDN…) holds
#      the real certificate and forwards to the gateway over HTTPS (its internal
#      self-signed certificate). TRUSTED_PROXIES (the proxy's IPs/CIDRs) lets the
#      gateway take each visitor's real IP from X-Forwarded-For — otherwise every
#      visitor would be the proxy, sharing one rate-limit bucket. GATEWAY_HTTP_PORT /
#      GATEWAY_HTTPS_PORT (default 80/443) move the gateway off ports a proxy on the
#      same host already holds. No certbot, no cron.
#    - letsencrypt (default): obtains a real certificate for ERP_HOST (+ SITE_HOST)
#    over the HTTP-01 challenge (port 80 must reach this server) and installs it for
#    the gateway; ACME_STAGING=1 rehearses against Let's Encrypt's staging servers.
#    Renewal: `make renew-certs-prod`, added to this user's crontab twice a day
#    (INSTALL_CRON=0 skips it).
#
# The data volumes survive every re-run. Never point it at a host running the dev
# stack: both use the same container names.
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE=(docker compose -f compose.yml -f compose.prod.yml)
say() { echo "==> $*"; }
die() { echo "error: $*" >&2; exit 1; }

# ── Pre-flight: everything this needs, checked before anything changes ──────
missing=()
need_tool() { command -v "$1" >/dev/null 2>&1 || missing+=("tool: $1 ($2)"); }
need_tool docker "Docker Engine"
need_tool rg "ripgrep"
need_tool od "coreutils"
need_tool sed "sed"
if command -v docker >/dev/null 2>&1; then
  docker compose version >/dev/null 2>&1 || missing+=("tool: docker compose v2 (the Compose plugin)")
  docker info >/dev/null 2>&1 || missing+=("Docker daemon: not running, or this user can't reach it (docker group?)")
fi
for f in compose.yml compose.prod.yml eerp-config.prod.example.json \
  infra/garage/init.sh infra/garage/garage.toml infra/nginx/nginx.conf \
  infra/nginx/gen-certs.sh infra/certbot/install-cert.sh; do
  [ -f "$f" ] || missing+=("file: $f")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "error: can't bootstrap, missing:" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  exit 1
fi

touch .env
chmod 600 .env

# setting NAME PROMPT [DEFAULT] [optional]: environment > .env > prompt > default.
# The value is (re)written into .env so later runs and compose itself see it.
setting() {
  local name=$1 prompt=$2 default=${3:-} optional=${4:-} value
  value=${!name:-}
  if [ -z "$value" ]; then
    value=$(sed -nE "s/^$name=(.*)$/\1/p" .env | tail -n1)
  fi
  if [ -z "$value" ] && [ -t 0 ]; then
    read -r -p "$prompt${default:+ [$default]}: " value
  fi
  value=${value:-$default}
  if [ -z "$value" ] && [ -z "$optional" ]; then
    die "$name is required ($prompt)."
  fi
  sed -i -E "/^$name=/d" .env
  [ -n "$value" ] && echo "$name=$value" >> .env
  printf -v "$name" '%s' "$value"
  export "${name?}"
}

setting ERP_HOST "Domain of the ERP (e.g. erp.example.com)"
setting CERT_MODE "HTTPS certificate: letsencrypt (EERP gets its own) or proxy (a reverse proxy in front holds it)" letsencrypt
# `self-signed` was this mode's earlier name.
if [ "$CERT_MODE" = self-signed ]; then
  CERT_MODE=proxy
  sed -i -E "s/^CERT_MODE=.*/CERT_MODE=proxy/" .env
fi
case "$CERT_MODE" in letsencrypt | proxy) ;; *) die "CERT_MODE must be letsencrypt or proxy." ;; esac
if [ "$CERT_MODE" = letsencrypt ]; then
  setting ACME_EMAIL "Email for Let's Encrypt (expiry warnings)"
  GATEWAY_HTTP_PORT=80 GATEWAY_HTTPS_PORT=443 # the HTTP-01 challenge comes in on 80
  sed -i -E "/^GATEWAY_HTTPS?_PORT=/d" .env
else
  setting TRUSTED_PROXIES "IPs/CIDRs of the reverse proxy, comma-separated (e.g. 10.0.0.5 or 172.16.0.0/12)"
  # Stored as one token (comma-separated, no spaces).
  TRUSTED_PROXIES=$(printf '%s' "$TRUSTED_PROXIES" | tr -s ' ,' ',' | sed -e 's/^,//' -e 's/,$//')
  sed -i -E "s|^TRUSTED_PROXIES=.*|TRUSTED_PROXIES=$TRUSTED_PROXIES|" .env
  setting GATEWAY_HTTP_PORT "Port the gateway publishes plain HTTP on" 80
  setting GATEWAY_HTTPS_PORT "Port the gateway publishes HTTPS on (what the proxy forwards to)" 443
  # Each entry becomes an nginx directive: only plain IPv4/IPv6 addresses or CIDRs.
  for cidr in ${TRUSTED_PROXIES//,/ }; do
    printf '%s' "$cidr" | rg -q '^(([0-9]{1,3}\.){3}[0-9]{1,3}(/[0-9]{1,2})?|[0-9A-Fa-f:]+(/[0-9]{1,3})?)$' ||
      die "TRUSTED_PROXIES: \"$cidr\" is not an IP address or CIDR."
  done
  for port in "$GATEWAY_HTTP_PORT" "$GATEWAY_HTTPS_PORT"; do
    printf '%s' "$port" | rg -q '^[0-9]{1,5}$' || die "gateway port \"$port\" is not a number."
  done
fi
export GATEWAY_HTTP_PORT GATEWAY_HTTPS_PORT
setting SITE_HOST "Public website domain, if different from the ERP (empty = none)" "" optional
setting EERP_IMAGE_TAG "Image tag to run (latest, or a build number such as 0.101.0)" latest
setting SMTP_HOST "SMTP relay host for outgoing email (empty = no email)" "" optional
if [ -n "${SMTP_HOST:-}" ]; then
  setting SMTP_PORT "SMTP port" 587
  setting SMTP_TLS "SMTP TLS: starttls, implicit or none" starttls
  setting SMTP_USER "SMTP user (empty = none)" "" optional
  setting SMTP_PASSWORD "SMTP password (empty = none)" "" optional
  setting SMTP_FROM "Sender address" "no-reply@$ERP_HOST"
fi

if [ "$CERT_MODE" = letsencrypt ]; then
  for host in "$ERP_HOST" ${SITE_HOST:+"$SITE_HOST"}; do
    if ! getent hosts "$host" >/dev/null 2>&1; then
      echo "warning: $host doesn't resolve yet — Let's Encrypt needs its DNS pointing at this server." >&2
    fi
  done
fi
# The gateway's ports must be free — unless our own gateway already holds them (a re-run).
if ! "${COMPOSE[@]}" ps --status running --services 2>/dev/null | rg -qx api-gateway; then
  for port in "$GATEWAY_HTTP_PORT" "$GATEWAY_HTTPS_PORT"; do
    if ss -ltnH "sport = :$port" 2>/dev/null | rg -q .; then
      die "port $port is already in use on this host."
    fi
  done
fi

# ── Secrets ─────────────────────────────────────────────────────────────────
hex() { od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; }
SECRETS='POSTGRES_PASSWORD|EERP_MASTER_KEY|EERP_S3_ACCESS_KEY|EERP_S3_SECRET_KEY|GARAGE_RPC_SECRET'
if [ "${ROTATE:-0}" = 1 ]; then
  say "ROTATE=1: regenerating secrets"
  sed -i -E "/^($SECRETS)=/d" .env
fi
# Hex only, so no quoting concerns in .env, sed, JSON or the DSN (same rules as
# infra/bootstrap.sh: Garage wants GK + 24 hex chars and a 64-hex secret).
ensure() { rg -q "^$1=" .env || { say "generating $1"; echo "$1=$2" >> .env; }; }
ensure POSTGRES_PASSWORD "$(hex 24)"
ensure EERP_MASTER_KEY "$(hex 32)"
ensure EERP_S3_ACCESS_KEY "GK$(hex 12)"
ensure EERP_S3_SECRET_KEY "$(hex 32)"
ensure GARAGE_RPC_SECRET "$(hex 32)"
# Read .env back literally (KEY=value per line), never executing it: values may hold
# spaces, quotes or $ (an SMTP password), which sourcing the file would mangle.
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in '' | '#'*) continue ;; esac
  key=${line%%=*}
  printf '%s' "$key" | rg -q '^[A-Za-z_][A-Za-z0-9_]*$' || continue
  export "$key=${line#*=}"
done < .env

# ── Config ──────────────────────────────────────────────────────────────────
CONFIG=eerp-config.prod.json
# set_json KEY VALUE (string fields, one `"key": "value"` per line in the template).
# The value is JSON-escaped (\\ and "), then escaped for sed's replacement (\\ and &);
# the delimiter is a control character no value can hold, so a password with any
# printable character — quotes, |, &, $, # — lands in the file as written. The old
# value is matched as a whole JSON string, escapes included, so re-runs are safe.
set_json() {
  local v=$2 d=$'\001'
  v=${v//\\/\\\\}
  v=${v//\"/\\\"}
  v=$(printf '%s' "$v" | sed -e 's/[\\&]/\\&/g')
  sed -i -E "s${d}(\"$1\"[[:space:]]*:[[:space:]]*\")([^\"\\\\]|\\\\.)*\"${d}\\1$v\"${d}" "$CONFIG"
}
set_json_number() { sed -i -E "s|(\"$1\"[[:space:]]*:[[:space:]]*)[0-9]+|\1$2|" "$CONFIG"; }
# A bind mount whose source is missing makes Docker create an empty DIRECTORY there.
[ -d "$CONFIG" ] && rmdir "$CONFIG"
if [ ! -f "$CONFIG" ]; then
  say "creating $CONFIG from its template"
  cp eerp-config.prod.example.json "$CONFIG"
fi
say "writing secrets and settings into $CONFIG"
set_json master_key "$EERP_MASTER_KEY"
set_json db_password "$POSTGRES_PASSWORD"
set_json s3_access_key "$EERP_S3_ACCESS_KEY"
set_json s3_secret_key "$EERP_S3_SECRET_KEY"
set_json site_url "https://${SITE_HOST:-$ERP_HOST}"
if [ -n "${SMTP_HOST:-}" ]; then
  set_json smtp_host "$SMTP_HOST"
  # shellcheck disable=SC2153 # assigned by setting() through printf -v
  set_json_number smtp_port "$SMTP_PORT"
  set_json smtp_tls "$SMTP_TLS"
  set_json smtp_user "${SMTP_USER:-}"
  set_json smtp_password "${SMTP_PASSWORD:-}"
  set_json smtp_from "$SMTP_FROM"
fi
chmod 600 "$CONFIG"

# Real visitor IPs behind a reverse proxy: nginx (infra/nginx/nginx.conf includes
# infra/nginx/realip/*.conf, mounted by compose.prod.yml) replaces the proxy's
# address with the X-Forwarded-For client — only when the request comes from a
# trusted proxy. Removed again in letsencrypt mode, where nothing sits in front.
REALIP=infra/nginx/realip/proxy.conf
if [ "$CERT_MODE" = proxy ]; then
  say "trusting X-Forwarded-For from: $TRUSTED_PROXIES"
  {
    echo "# Generated by infra/bootstrap-prod.sh (CERT_MODE=proxy) — don't edit; re-run it."
    for cidr in ${TRUSTED_PROXIES//,/ }; do echo "set_real_ip_from $cidr;"; done
    echo "real_ip_header X-Forwarded-For;"
    echo "real_ip_recursive on;"
  } > "$REALIP"
else
  rm -f "$REALIP"
fi

# ── Images: reuse what the host has, pull only what's missing ───────────────
# Every image the stack runs, certbot included, as compose resolves them (tags
# from .env). A missing one — first run, or a new EERP_IMAGE_TAG — is pulled;
# present ones are reused as they are, so a re-run never silently moves `latest`.
# PULL=1 refreshes them all (an explicit upgrade of the current tags).
mapfile -t images < <("${COMPOSE[@]}" --profile certbot config --images | sort -u)
[ ${#images[@]} -gt 0 ] || die "compose resolved no images."
to_pull=()
for image in "${images[@]}"; do
  if [ "${PULL:-0}" = 1 ] || ! docker image inspect "$image" >/dev/null 2>&1; then
    to_pull+=("$image")
  fi
done
if [ ${#to_pull[@]} -eq 0 ]; then
  say "all ${#images[@]} images already on this host"
else
  say "pulling ${#to_pull[@]} of ${#images[@]} images"
  for image in "${to_pull[@]}"; do
    echo "    $image"
    docker pull --quiet "$image" >/dev/null || die "could not pull $image (registry login? tag published by CI?)"
  done
fi

# ── Services ────────────────────────────────────────────────────────────────

say "starting infrastructure (db, nats, garage, redis)"
"${COMPOSE[@]}" up -d --wait db nats garage redis
# Postgres applies POSTGRES_PASSWORD only when it initializes an empty data dir:
# set it over the local socket (trusted by the image) on every run.
"${COMPOSE[@]}" exec -T db psql -qU postgres -v ON_ERROR_STOP=1 \
  -c "ALTER USER postgres PASSWORD '$POSTGRES_PASSWORD'"
# pg_trgm backs the search indexes; postgis comes with the image (core-back creates
# that extension at boot). template1 too, so databases created later inherit it.
say "installing pg_trgm"
app_db=$(sed -nE 's/.*"db_name"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' "$CONFIG")
for target in template1 "$app_db"; do
  [ -n "$target" ] || continue
  exists=$("${COMPOSE[@]}" exec -T db psql -qtAU postgres -c "SELECT 1 FROM pg_database WHERE datname = '$target'")
  [ "$exists" = 1 ] || continue
  "${COMPOSE[@]}" exec -T db psql -qU postgres -d "$target" -v ON_ERROR_STOP=1 \
    -c "CREATE EXTENSION IF NOT EXISTS pg_trgm"
done
bash infra/garage/init.sh

say "starting the app"
# core-back reads its config at boot only: recreate it alone (never db/garage).
"${COMPOSE[@]}" up -d --wait --force-recreate --no-deps core-back
"${COMPOSE[@]}" up -d --wait core-front pdf-service
# The gateway bind-mounts nginx.conf, whose content compose never watches: recreate it.
"${COMPOSE[@]}" rm -sf api-gateway >/dev/null
"${COMPOSE[@]}" up -d --wait api-gateway

# ── HTTPS ───────────────────────────────────────────────────────────────────
if [ "$CERT_MODE" = letsencrypt ]; then
  domains=(-d "$ERP_HOST")
  [ -n "${SITE_HOST:-}" ] && domains+=(-d "$SITE_HOST")
  staging=()
  [ "${ACME_STAGING:-0}" = 1 ] && staging=(--staging)
  say "obtaining the Let's Encrypt certificate for ${domains[*]//-d /}"
  # --keep-until-expiring: a re-run with a valid certificate doesn't request a new one;
  # --expand: adding SITE_HOST later extends the same certificate.
  "${COMPOSE[@]}" run --rm certbot certonly --webroot -w /var/www/acme \
    --cert-name "$ERP_HOST" "${domains[@]}" "${staging[@]}" \
    --email "$ACME_EMAIL" --agree-tos --no-eff-email --non-interactive \
    --keep-until-expiring --expand
  "${COMPOSE[@]}" run --rm --entrypoint sh certbot /install-cert.sh
  "${COMPOSE[@]}" exec -T api-gateway nginx -s reload

  if [ "${INSTALL_CRON:-1}" = 1 ] && command -v crontab >/dev/null 2>&1; then
    line="17 3,15 * * * cd $PWD && make renew-certs-prod >> $PWD/.certbot-renew.log 2>&1"
    if ! crontab -l 2>/dev/null | rg -qF "make renew-certs-prod"; then
      say "scheduling certificate renewal (crontab, twice a day)"
      { crontab -l 2>/dev/null || true; echo "$line"; } | crontab -
    fi
  fi
else
  say "behind your reverse proxy — set it up to:"
  echo "    - serve https://$ERP_HOST${SITE_HOST:+ and https://$SITE_HOST} with its own certificate,"
  echo "    - forward to https://<this server>:$GATEWAY_HTTPS_PORT (the gateway's self-signed"
  echo "      certificate: turn upstream certificate verification off, or trust it),"
  echo "    - pass the Host header and set X-Forwarded-For (from ${TRUSTED_PROXIES}),"
  echo "    - not forward to port $GATEWAY_HTTP_PORT: the gateway redirects plain HTTP to HTTPS (a loop)."
fi

say "up: https://$ERP_HOST/app"
echo "    first sign-in: admin@eerp.local / admin — you'll be asked to change the password at once."
echo "    upgrade later: EERP_IMAGE_TAG=<new build> make bootstrap-prod (or PULL=1 to refresh the current tag)."
