#!/usr/bin/env bash
# One-command, idempotent start of the whole dev Docker Compose stack.
#
#   infra/bootstrap.sh            # first run: generate secrets, fill configs, start all
#   infra/bootstrap.sh            # later runs: keep secrets, rebuild, start
#   ROTATE=1 infra/bootstrap.sh   # regenerate every secret (data is kept)
#
# 1. Secrets live in the gitignored .env: POSTGRES_PASSWORD, EERP_MASTER_KEY, the S3 key
#    pair (EERP_S3_ACCESS_KEY/EERP_S3_SECRET_KEY) and GARAGE_RPC_SECRET. A missing key is
#    generated, an existing one kept, so a re-run never changes a live password.
# 2. They are written into every place that needs them: master_key, db_password and
#    s3_* in the gitignored eerp-config.json (host-native go run/tests) and
#    eerp-config.docker.json (compose), each created from its committed *.example.json
#    template when missing; compose reads POSTGRES_PASSWORD and GARAGE_RPC_SECRET from
#    .env itself, and infra/garage/init.sh imports the S3 pair. eerp-config.prod.json is
#    never touched: production must not share dev secrets.
# 3. Infra services start first and are waited on until healthy, Garage gets its
#    layout/key/bucket, then the app services start and are waited on too — one run
#    instead of several `docker compose up -d`.
#
# Postgres only applies POSTGRES_PASSWORD when it initializes an empty data dir, and the
# data dir outlives container recreation, so the password is (re)set over the local
# socket (trusted by the image) on every run — which also makes rotation data-safe.
set -euo pipefail
cd "$(dirname "$0")/.."

hex() { od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; }
SECRETS='POSTGRES_PASSWORD|EERP_MASTER_KEY|EERP_S3_ACCESS_KEY|EERP_S3_SECRET_KEY|GARAGE_RPC_SECRET'

touch .env
chmod 600 .env
if [ "${ROTATE:-0}" = 1 ]; then
  echo "==> ROTATE=1: regenerating secrets"
  sed -i -E "/^($SECRETS)=/d" .env
fi
# ensure KEY VALUE: append KEY only when .env lacks it. Hex only: no quoting/escaping
# concerns in .env, sed, JSON or the DSN; Garage wants its access key as GK + 24 hex
# chars and a 64-hex secret; master_key needs 32+ bytes (main.go's boot guard).
ensure() { rg -q "^$1=" .env || { echo "==> generating $1"; echo "$1=$2" >> .env; }; }
ensure POSTGRES_PASSWORD "$(hex 24)"
ensure EERP_MASTER_KEY "$(hex 32)"
ensure EERP_S3_ACCESS_KEY "GK$(hex 12)"
ensure EERP_S3_SECRET_KEY "$(hex 32)"
ensure GARAGE_RPC_SECRET "$(hex 32)"
set -a
# shellcheck disable=SC1091
. ./.env
set +a

# set_json FILE KEY VALUE: the configs are one `"key": "value"` per line.
set_json() { sed -i -E "s|(\"$2\"[[:space:]]*:[[:space:]]*\")[^\"]*\"|\1$3\"|" "$1"; }
echo "==> writing secrets into eerp-config.json and eerp-config.docker.json"
for f in eerp-config.json eerp-config.docker.json; do
  # A bind mount whose source is missing makes Docker create an empty DIRECTORY there.
  [ -d "$f" ] && rmdir "$f"
  [ -f "$f" ] || cp "${f%.json}.example.json" "$f"
  set_json "$f" master_key "$EERP_MASTER_KEY"
  set_json "$f" db_password "$POSTGRES_PASSWORD"
  set_json "$f" s3_access_key "$EERP_S3_ACCESS_KEY"
  set_json "$f" s3_secret_key "$EERP_S3_SECRET_KEY"
  chmod 600 "$f"
done

echo "==> starting infra (db, nats, garage)"
docker compose up -d --wait db nats garage
docker compose exec -T db psql -qU postgres -v ON_ERROR_STOP=1 \
  -c "ALTER USER postgres PASSWORD '$POSTGRES_PASSWORD'"
bash infra/garage/init.sh

echo "==> building and starting the app"
# core-back reads its bind-mounted config at boot only: always recreate it, alone
# (--no-deps: never recreate db/garage just for that).
docker compose up -d --build --wait --force-recreate --no-deps core-back
# The gateway is stateless but bind-mounts nginx.conf, whose content compose never
# watches — and on Docker Desktop a container even keeps the file it was created
# with, so after a branch switch it can fail with "no such file". Remove it so it
# is always created fresh (with its gateway-certs dependency still honored).
docker compose rm -sf api-gateway >/dev/null
# Named services only: --wait fails on the one-shot gateway-certs exiting, but still
# waits on it as a dependency of api-gateway.
docker compose up -d --build --wait api-gateway pdf-service

echo "==> up: https://localhost"
