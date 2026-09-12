#!/usr/bin/env bash
# One-time (idempotent) bootstrap of the dev Garage node — run from the repo root
# (or via `make garage-init`) AFTER `docker compose up -d garage`.
#
# Garage starts empty: no cluster layout, no key, no bucket. This script, in order:
#   1. waits for the node to answer,
#   2. assigns the single-node layout (zone dc1, 1G capacity) and applies it,
#   3. imports the FIXED dev credentials that eerp-config.json's s3_* fields reference
#      (imported, not generated, so the config never has to chase a random key),
#   4. creates the `eerp` bucket and grants the key read+write+owner on it.
# Every step is guarded, so re-running is safe. The garage image has no shell, hence
# `docker compose exec` from the host rather than an entrypoint script in the image.

set -euo pipefail
cd "$(dirname "$0")/../.."

# Dev-only credentials — must match the s3_access_key / s3_secret_key in
# eerp-config.json and eerp-config.docker.json.
ACCESS_KEY="GKdeadbeefdeadbeefdeadbeef"
SECRET_KEY="3b7932955ae6e6d18fa87084d6c4f35898471aee3bbce0da3d5779b65195080c"
BUCKET="eerp"
KEY_NAME="eerp-dev"

garage() { docker compose exec -T garage /garage "$@"; }

echo "==> waiting for garage to answer"
for i in $(seq 1 30); do
  if garage status >/dev/null 2>&1; then break; fi
  [ "$i" = 30 ] && { echo "garage did not come up"; exit 1; }
  sleep 1
done

if garage status | grep -q "NO ROLE ASSIGNED"; then
  echo "==> assigning single-node layout"
  NODE_ID="$(garage node id -q | cut -d@ -f1)"
  garage layout assign -z dc1 -c 1G "$NODE_ID"
  garage layout apply --version 1
else
  echo "==> layout already assigned"
fi

if garage key info "$KEY_NAME" >/dev/null 2>&1; then
  echo "==> key $KEY_NAME already imported"
else
  echo "==> importing dev key $KEY_NAME"
  garage key import --yes -n "$KEY_NAME" "$ACCESS_KEY" "$SECRET_KEY"
fi

if garage bucket info "$BUCKET" >/dev/null 2>&1; then
  echo "==> bucket $BUCKET already exists"
else
  echo "==> creating bucket $BUCKET"
  garage bucket create "$BUCKET"
fi

echo "==> granting $KEY_NAME read/write/owner on $BUCKET"
garage bucket allow --read --write --owner "$BUCKET" --key "$KEY_NAME" >/dev/null

echo "==> done"
garage bucket list
