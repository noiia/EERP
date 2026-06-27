root := $(CURDIR)

.PHONY: rebuild-and-run clean build run run-back run-front

CONFIG ?= $(root)/eerp-config.json

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
	docker compose up -d core-back
# 	cd $(root)/core/cmd/app && go run main.go -config="$(CONFIG)" --debug=0


BACKTESTPATH ?= ./...
run-back-tests:
	docker compose up -d 
	cd $(root)/core && CONFIG="$(CONFIG)" go test $(BACKTESTPATH) $(ARGS)

run-front-dev:
	cd $(root)/core-front && npm run dev -- --host 0.0.0.0

run:
	docker compose up -d 
	@set -e; \
	npm --prefix "$(root)/core-front" run dev -- --host 0.0.0.0 & \
	FRONT_PID=$$!; \
	trap 'kill $$FRONT_PID' EXIT INT TERM; \
	$(MAKE) --no-print-directory run-back

logs:
	docker compose logs -f -n 50