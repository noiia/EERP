rebuild-and-run:
	make clean
	make build
	make run

clean:
	rm -rf modules/vente/target
	rm -rf modules/vente_particulier/target

build:
	cd modules/vente && cargo build --target wasm32-unknown-unknown --release
	cd modules/vente_particulier && cargo build --target wasm32-unknown-unknown --release

run:
	docker compose up -d 
	cd core/cmd/main.go && go run main.go