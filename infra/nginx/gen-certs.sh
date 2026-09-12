#!/bin/sh
# Idempotent bootstrap of the api-gateway's self-signed TLS cert (dev/internal
# use only — HTTP/2 requires TLS, browsers never negotiate h2 over plain HTTP).
# Runs INSIDE the `gateway-certs` one-shot compose service (alpine + openssl),
# writing into the `gateway-certs` named volume that api-gateway also mounts
# read-only at /etc/nginx/certs — so `docker compose up` alone provisions the
# cert with no separate manual step, mirroring infra/garage/init.sh's
# idempotent bootstrap but running as its own container instead of via
# `docker compose exec` (nginx's image has no shell tooling to bootstrap
# itself, and its own container stays read_only at runtime).
set -eu

CERT_DIR="/certs"
CRT="$CERT_DIR/gateway.crt"
KEY="$CERT_DIR/gateway.key"

if [ -f "$CRT" ] && [ -f "$KEY" ]; then
  echo "==> gateway cert already present, skipping"
  exit 0
fi

echo "==> generating self-signed gateway cert (10y, dev/internal only)"
apk add --no-cache openssl >/dev/null
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$KEY" -out "$CRT" \
  -subj "/CN=eerp-gateway" \
  -addext "subjectAltName=DNS:localhost,DNS:api-gateway,IP:127.0.0.1"

echo "==> done: $CRT"
