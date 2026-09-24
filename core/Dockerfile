FROM golang:1.27.1 AS builder

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
FROM golang:1.27.1

# ca-certificates: outbound HTTPS (NATS/pdf-service over TLS, any future
# webhook). postgresql-client-18: pg_dump/pg_restore/psql for
# internal/dbmanage's database extract/restore (shells out rather than
# reimplementing the dump/restore format) — pulled from the PGDG apt repo,
# not Debian's own (older) default, to match compose.yml's postgres:18
# server exactly rather than hoping cross-major compatibility holds.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc --fail \
        https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt trixie-pgdg main" \
        > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y --no-install-recommends postgresql-client-18 \
    && apt-get purge -y curl gnupg && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/eerp           ./eerp
COPY --from=builder /app/core/modules/  ./modules/

EXPOSE 8080

CMD ["./eerp", "-config=/app/eerp-config.json"]
