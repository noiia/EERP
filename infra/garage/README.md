# Garage — dev object storage (S3)

[Garage](https://garagehq.deuxfleurs.fr/) is the S3-compatible object store backing the
picture service (`docs/roadmaps/field-widgets.md`, Phase 3): user-generated binary content
(pictures, signatures) goes to S3, while their metadata lives in the core `picture` table.
The backend only speaks the S3 API, so the provider is swappable; Garage is the dev/default
choice for its single-binary footprint.

## Layout

| File | Role |
| --- | --- |
| `garage.toml` | Node config, mounted read-only into the `garage` compose service. Dev secrets only. |
| `init.sh` | Idempotent bootstrap: layout, dev key, `eerp` bucket, grants. |

## Usage

```bash
docker compose up -d garage   # start the node (also started by `make run`)
make garage-init              # one-time bootstrap (safe to re-run)
```

The S3 endpoint is `http://127.0.0.1:3910` from the host (`http://garage:3900` inside the
compose network), region `garage`, bucket `eerp`. The backend reads all of it from the
`s3_*` fields in `eerp-config.json` / `eerp-config.docker.json`; the dev credentials are
**imported** by `init.sh` (not generated) so those config files never chase a random key.

Poke at it directly:

```bash
docker compose exec garage /garage status
docker compose exec garage /garage bucket list
```

## Reset

Object data and cluster metadata live in the `garage-meta` / `garage-data` volumes:

```bash
docker compose down garage
docker volume rm eerp_garage-meta eerp_garage-data
docker compose up -d garage && make garage-init
```

## Not for production

`rpc_secret` and the S3 key pair are committed dev values (same stance as the
`postgres/postgres` DB credentials). A real deployment generates its own secrets, runs
`replication_factor >= 3`, and puts a TLS terminator in front of the S3 API.
