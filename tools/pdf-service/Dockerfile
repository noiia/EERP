FROM golang:1.26 AS builder

WORKDIR /app

COPY tools/pdf-service/go.mod tools/pdf-service/go.sum ./
RUN go mod download

COPY tools/pdf-service/ ./

RUN go build -o /app/pdf-service .

# ── Runtime ────────────────────────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium fonts-liberation curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/pdf-service ./pdf-service

ENV CHROME_PATH=/usr/bin/chromium
EXPOSE 8090

CMD ["./pdf-service"]
