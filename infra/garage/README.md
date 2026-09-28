# Garage — dev object storage (S3)

[Garage](https://garagehq.deuxfleurs.fr/) is the S3-compatible object store backing the
picture service (`docs/roadmaps/field-widgets.md`, Phase 3): user-generated binary content
(pictures, signatures) goes to S3, while their metadata lives in the core `picture` table.
The backend only speaks the S3 API, so the provider is swappable; Garage is the dev/default
choice for its single-binary footprint.

## Layout

| File | Role |
| --- | --- |
| `garage.toml` | Node config, mounted read-only into the `garage` compose service. Holds no secret (`rpc_secret` comes from `GARAGE_RPC_SECRET`). |
| `init.sh` | Idempotent bootstrap: layout, S3 key from `.env`, `eerp` bucket, grants. |

## Usage

```bash
make bootstrap                # whole dev stack, this bootstrap included (infra/bootstrap.sh)
make garage-init              # just this bootstrap (safe to re-run; needs .env)
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

`rpc_secret` and the S3 key pair are generated per machine by `infra/bootstrap.sh` into the
gitignored `.env` (compose hands `GARAGE_RPC_SECRET` to the node, `init.sh` imports the key
pair, the configs' `s3_*` fields get the same pair). A real deployment also runs
`replication_factor >= 3`, and puts a TLS terminator in front of the S3 API.
