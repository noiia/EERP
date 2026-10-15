# Real-IP trust (generated)

`infra/bootstrap-prod.sh` writes `proxy.conf` here when production runs behind a
reverse proxy (`CERT_MODE=proxy`): nginx `set_real_ip_from` lines for the proxy's
`TRUSTED_PROXIES`, so the gateway sees each visitor's IP instead of the proxy's.
`compose.prod.yml` mounts this folder at `/etc/nginx/realip`, and `infra/nginx/nginx.conf`
includes `*.conf` from it. Generated files are gitignored; don't edit them, re-run
the bootstrap.
