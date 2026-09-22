root := $(CURDIR)

.PHONY: rebuild-and-run clean build run run-back run-back-tests run-front-dev garage-init logs run-docker-prod

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
	$(COMPOSE) up -d
	cd $(root)/core && CONFIG="$(CONFIG)" go test $(BACKTESTPATH) $(ARGS)

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
