FROM golang:1.26 AS builder

WORKDIR /app

COPY core/go.mod core/go.sum ./core/
RUN cd core && go mod download

COPY core/ ./core/

# Build WASM modules — skip Go modules (type:"go" in module.json) and
# directories without a module.json (e.g. the 'all' aggregator package).
RUN for dir in /app/core/modules/*/; do \
    name=$(basename "$dir"); \
    [ -f "$dir/module.json" ] || continue; \
    grep -q '"type"[[:space:]]*:[[:space:]]*"go"' "$dir/module.json" 2>/dev/null && continue; \
    mkdir -p "$dir/build"; \
    GOOS=wasip1 GOARCH=wasm go build -C /app/core -o "$dir/build/$name.wasm" "./modules/$name"; \
    done

# Build the backend binary (CGO on for wasmtime-go)
RUN go build -C /app/core -o /app/eerp ./cmd/app

# ── Runtime ────────────────────────────────────────────────────────────────
FROM golang:1.26

# RUN apt-get update && apt-get install -y --no-install-recommends \
#     ca-certificates \
#     && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/eerp           ./eerp
COPY --from=builder /app/core/modules/  ./modules/
COPY eerp-config.docker.json            ./eerp-config.json

EXPOSE 8080

CMD ["./eerp", "-config=/app/eerp-config.json"]
