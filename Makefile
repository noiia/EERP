root := $(CURDIR)

rebuild-and-run:
	make clean
	make build
	make run

clean:
	rm -rf $(root)/modules/vente/target
	rm -rf $(root)/modules/vente_particulier/target

build:
	cd $(root)/modules/vente && cargo build --target wasm32-unknown-unknown --release
	cd $(root)/modules/vente_particulier && cargo build --target wasm32-unknown-unknown --release

run:
	docker compose up -d 
	cd $(root)/core/cmd && go run main.go -config="$(root)/eerp-config.json"