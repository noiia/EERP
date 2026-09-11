#!/bin/sh
# Deploys the latest released images: pulls whatever tag `compose.yml`
# currently points at (moved forward by a new release/publish) and recreates
# any service whose pulled image actually changed. Safe to re-run — `up -d`
# is a no-op for a service already running the image it just pulled. Run
# this from anywhere; it cd's to the repo root itself so `docker compose`
# picks up the root `compose.yml`.
set -eu

cd "$(dirname "$0")/.."

echo "==> pulling latest images"
docker compose pull

echo "==> recreating changed services"
docker compose up -d

echo "==> done"
