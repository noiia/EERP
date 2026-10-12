root := $(CURDIR)

.PHONY: rebuild-and-run clean build run run-back run-back-tests run-pdf-tests run-front-tests test run-front-dev garage-init logs run-docker-prod bootstrap

CONFIG ?= $(root)/eerp-config.json

# Which `docker compose` invocation the compose-touching targets below use.
# run-docker-prod overrides this to layer compose.prod.yml on top (see there) — every
# other target keeps the plain dev default, unchanged.
COMPOSE ?= docker compose
PROD_COMPOSE := docker compose -f $(root)/compose.yml -f $(root)/compose.prod.yml

rebuild-and-run:
	make clean
	make build
	make run

clean:
	@for dir in $(root)/core/modules/*/; do \
		name=$$(basename $$dir); \
		echo "Cleaning $$name..."; \
		rm -rf $$dir/build/;\
	done
	rm -rf $(root)/core/cmd/app/cache
	find $(root) -name '__debug_bin*' -delete

build:
	@for dir in $(root)/core/modules/*/; do \
		name=$$(basename $$dir); \
		echo "Building $$name..."; \
		GOOS=wasip1 GOARCH=wasm go build -C $(root)/core -o $$dir/build/$$name.wasm ./modules/$$name; \
	done

run-back:
	$(COMPOSE) up -d core-back
# 	cd $(root)/core/cmd/app && go run main.go -config="$(CONFIG)" --debug=0


BACKTESTPATH ?= ./...
run-back-tests:
	$(COMPOSE) up -d --wait db garage
	cd $(root)/core && CONFIG="$(CONFIG)" go test $(BACKTESTPATH) $(ARGS)

run-pdf-tests:
	cd $(root)/tools/pdf-service && go test ./... $(ARGS)

# pnpm pinned to the workspace's packageManager version through npx (a broken
# corepack shim can't get in the way); override with PNPM=pnpm. The engine is
# built first: the shell and the modules import its dist/, as in CI.
PNPM ?= npx -y pnpm@12.4.2
run-front-tests:
	cd $(root)/core-front && $(PNPM) install --frozen-lockfile && \
		$(PNPM) --filter @eerp/core-front build && \
		$(PNPM) lint && $(PNPM) typecheck && $(PNPM) test

# Every test suite the CI runs: Go backend (+ the Redis-backed cache tests),
# pdf-service, then the frontend's lint, typecheck and tests. Stops at the first
# failing suite.
test:
	$(COMPOSE) up -d --wait redis
	REDIS_URL=redis://127.0.0.1:6379/0 $(MAKE) --no-print-directory run-back-tests ARGS="-timeout 30m $(ARGS)"
	$(MAKE) --no-print-directory run-pdf-tests
	$(MAKE) --no-print-directory run-front-tests

run-front-dev:
	cd $(root)/core-front && npm run dev -- --host 0.0.0.0

run:
	$(COMPOSE) up -d
	@set -e; \
	npm --prefix "$(root)/core-front" run dev -- --host 0.0.0.0 & \
	FRONT_PID=$$!; \
	trap 'kill $$FRONT_PID' EXIT INT TERM; \
	$(MAKE) --no-print-directory run-back

logs:
	$(COMPOSE) logs -f -n 50

# Whole dev stack in one run: generates missing secrets into .env, fills every
# gitignored config that needs them (created from the *.example.json templates),
# starts + waits on every service, bootstraps Garage. Safe to re-run; ROTATE=1
# regenerates the secrets. See infra/bootstrap.sh.
bootstrap:
	bash $(root)/infra/bootstrap.sh

# One-time (idempotent) bootstrap of the dev Garage node: layout, dev S3 key, eerp bucket.
garage-init:
	$(COMPOSE) up -d garage
	bash $(root)/infra/garage/init.sh

# Full prod stack: pulls the ghcr.io images (compose.prod.yml overrides compose.yml's
# local `build:`), with db/garage off the host network entirely. See compose.prod.yml's
# own header comment for the API_BASE/EERP_IMAGE_TAG details.
run-docker-prod:
	$(MAKE) COMPOSE="$(PROD_COMPOSE)" garage-init
	$(PROD_COMPOSE) up -d
	$(MAKE) COMPOSE="$(PROD_COMPOSE)" logs
