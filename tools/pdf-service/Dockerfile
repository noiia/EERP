FROM golang:1.27.1 AS builder

WORKDIR /app

COPY tools/pdf-service/go.mod tools/pdf-service/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download

COPY tools/pdf-service/ ./

# Static, stripped binary: no libc dependency on the runtime image, no debug info.
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /app/pdf-service .

# ── Runtime ────────────────────────────────────────────────────────────────
# chromedp's headless-only Chrome build: no GUI stack, far smaller than
# Debian's full `chromium` package (the old base was ~1.1GB).
FROM chromedp/headless-shell:stable

# report.css asks for Helvetica/Arial: Liberation is their metric-compatible
# stand-in, so text widths — and therefore page breaks — stay stable.
RUN apt-get update && apt-get install -y --no-install-recommends fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/pdf-service ./pdf-service

ENV CHROME_PATH=/headless-shell/headless-shell
EXPOSE 8090

HEALTHCHECK --interval=10s --timeout=5s --retries=5 CMD ["/app/pdf-service", "-healthcheck"]

# The base image's ENTRYPOINT launches headless-shell itself; we launch it
# from Go instead.
ENTRYPOINT ["./pdf-service"]
