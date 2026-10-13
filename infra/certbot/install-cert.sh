#!/bin/sh
# Copies the Let's Encrypt certificate for $CERT_NAME into the gateway's cert volume,
# under the file names nginx serves (gateway.crt / gateway.key) — replacing the
# self-signed pair infra/nginx/gen-certs.sh wrote on the first start (it skips
# regenerating once these files exist). Runs inside the `certbot` service of
# compose.prod.yml: after the first issuance (infra/bootstrap-prod.sh) and as the
# renewal deploy hook (make renew-certs-prod). nginx must then be reloaded.
set -eu

LIVE="/etc/letsencrypt/live/${CERT_NAME:?CERT_NAME (the ERP host) is not set}"
if [ ! -f "$LIVE/fullchain.pem" ] || [ ! -f "$LIVE/privkey.pem" ]; then
  echo "install-cert: no certificate at $LIVE" >&2
  exit 1
fi
cp "$LIVE/fullchain.pem" /gateway-certs/gateway.crt.new
cp "$LIVE/privkey.pem" /gateway-certs/gateway.key.new
chmod 644 /gateway-certs/gateway.crt.new
chmod 600 /gateway-certs/gateway.key.new
# Swap both in one step each, so nginx never reloads a mismatched pair.
mv /gateway-certs/gateway.crt.new /gateway-certs/gateway.crt
mv /gateway-certs/gateway.key.new /gateway-certs/gateway.key
echo "install-cert: installed the $CERT_NAME certificate for the gateway"
