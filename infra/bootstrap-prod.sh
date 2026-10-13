#!/usr/bin/env bash
# One-command, idempotent production launch on a single Docker host.
#
#   make bootstrap-prod                                   # prompts for what's missing
#   ERP_HOST=erp.example.com ACME_EMAIL=ops@example.com make bootstrap-prod
#   make bootstrap-prod                                   # later: upgrade to the tagged images
#
# Run it on the server, in a checkout of this repository. It:
# 1. Collects the settings — ERP_HOST (required), ACME_EMAIL, SITE_HOST (the public
#    website's own host, optional), EERP_IMAGE_TAG (default latest; a CI build number
#    such as 0.101.0 pins a release), CERT_MODE (letsencrypt | self-signed), optional
#    SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD/SMTP_FROM/SMTP_TLS — from the
#    environment, else the .env of a previous run, else a prompt, and saves them in
#    .env so a re-run needs nothing.
# 2. Generates the secrets (database password, master key, S3 key pair, Garage RPC
#    secret) into .env when missing — never rotated by a re-run (ROTATE=1 does).
# 3. Writes eerp-config.prod.json from its template (secrets, site_url, SMTP).
# 4. Pulls the CI images, starts the infrastructure, sets the database password,
#    installs pg_trgm, initializes Garage, starts the app and waits until healthy.
# 5. CERT_MODE=letsencrypt: obtains a real certificate for ERP_HOST (+ SITE_HOST)
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

# ── Pre-flight ──────────────────────────────────────────────────────────────
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose …)."
[ -f compose.prod.yml ] || die "run this from the repository checkout."

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
setting CERT_MODE "Certificate: letsencrypt or self-signed" letsencrypt
case "$CERT_MODE" in letsencrypt | self-signed) ;; *) die "CERT_MODE must be letsencrypt or self-signed." ;; esac
if [ "$CERT_MODE" = letsencrypt ]; then
  setting ACME_EMAIL "Email for Let's Encrypt (expiry warnings)"
fi
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

for host in "$ERP_HOST" ${SITE_HOST:+"$SITE_HOST"}; do
  if ! getent hosts "$host" >/dev/null 2>&1; then
    echo "warning: $host doesn't resolve yet — Let's Encrypt needs its DNS pointing at this server." >&2
  fi
done
# Ports 80/443 must be free — unless our own gateway already holds them (a re-run).
if ! "${COMPOSE[@]}" ps --status running --services 2>/dev/null | rg -qx api-gateway; then
  for port in 80 443; do
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
set -a
# shellcheck disable=SC1091
. ./.env
set +a

# ── Config ──────────────────────────────────────────────────────────────────
CONFIG=eerp-config.prod.json
# set_json KEY VALUE (string fields, one `"key": "value"` per line in the template).
set_json() { sed -i -E "s|(\"$1\"[[:space:]]*:[[:space:]]*\")[^\"]*\"|\1$2\"|" "$CONFIG"; }
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

# ── Services ────────────────────────────────────────────────────────────────
say "pulling images (tag $EERP_IMAGE_TAG)"
"${COMPOSE[@]}" pull --quiet

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
  echo "note: CERT_MODE=self-signed — browsers will warn unless a proxy/CDN in front serves a real certificate." >&2
fi

say "up: https://$ERP_HOST/app"
echo "    first sign-in: admin@eerp.local / admin — you'll be asked to change the password at once."
echo "    upgrade later: set EERP_IMAGE_TAG in .env (or keep latest) and run make bootstrap-prod again."
