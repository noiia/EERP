# api-gateway (nginx)

## Why it exists
The browser only ever talks to the gateway. It terminates TLS and speaks **HTTP/2** (browsers
do not negotiate h2 over plain HTTP), and routes `/api/v1/*` and `/health` to `core-back`,
everything else to `core-front`. Port 80 only redirects to HTTPS (plus `/healthz`), because a
`Secure` session cookie is dropped over plain HTTP.

The gateway is the **edge**: it overwrites `X-Forwarded-For` with the peer address
(`$remote_addr`, never appending a client-supplied chain, so the Go rate limiters cannot be
spoofed) and sets `Host`, `X-Forwarded-Host`, `X-Forwarded-Proto`. `server_name _` catches every
hostname, so the site and ERP hosts of [ADR-025](../../docs/adr/ADR-025-website-routing-and-erp-base-path.md)
need no extra server block.

## Dev certificate
`gen-certs.sh` runs in the one-shot `gateway-certs` compose service and writes a self-signed
cert into the `gateway-certs` volume; it is idempotent (skips if `gateway.crt`/`gateway.key`
exist). SANs: `localhost`, `api-gateway`, `127.0.0.1`, plus `SITE_HOST` / `ERP_HOST` when set
in `.env`. To regenerate (e.g. after adding a host), clear the volume:

```bash
docker compose down && docker volume rm <project>_gateway-certs && docker compose up -d
```

## Host mode in production
1. DNS A/AAAA records for both hostnames pointing at the gateway.
2. A certificate covering both names, either
   - copy your own cert/key into the `gateway-certs` volume as `gateway.crt` / `gateway.key`
     (the script then leaves them alone), or
   - use certbot (webroot). **Not wired by default**: add a
     `location /.well-known/acme-challenge/` serving the webroot to the `:80` server, *before*
     its `location /` redirect, and mount the webroot into the gateway.
3. Save Settings → Website → Routing (`mode: host`). The save is refused unless you made it
   through `erp_host`, so the ERP hostname must already resolve.

**Recovery:** if the setting locks you out, set `EERP_SITE_ROUTING=path` on `core-front`
and restart it; any unknown host (IP, `localhost`) also behaves like path mode.
