root := $(CURDIR)

.PHONY: rebuild-and-run clean build run run-back run-front

CONFIG ?= $(root)/eerp-config.json

rebuild-and-run:
	make clean
	make build
	make run

clean:
	rm -rf $(root)/modules/vente/target
	rm -rf $(root)/modules/vente_particulier/target
	rm -rf $(root)/core/cmd/app/cache
	find $(root) -name '__debug_bin*' -delete

build:
	cd $(root)/modules/vente && cargo build --target wasm32-unknown-unknown --release
	cd $(root)/modules/vente_particulier && cargo build --target wasm32-unknown-unknown --release

run-back:
	cd $(root)/core/cmd/app && go run main.go -config="$(CONFIG)" --debug=0


BACKTESTPATH ?= ./...
run-back-tests:
	docker compose up -d 
	cd $(root)/core && go test $(BACKTESTPATH) $(ARGS) -config="$(CONFIG)" 

run-front:
	cd $(root)/core-front && npm run dev -- --host 0.0.0.0

run:
	docker compose up -d 
	@set -e; \
	npm --prefix "$(root)/core-front" run dev -- --host 0.0.0.0 & \
	FRONT_PID=$$!; \
	trap 'kill $$FRONT_PID' EXIT INT TERM; \
	$(MAKE) --no-print-directory run-back
