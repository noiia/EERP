# EERP

An open-source, modular, self-hostable ERP. Two independently deployable services share
one repo: a Go backend (**`core/`**, plus business modules under `core/modules/` — each
either compiled in or, eventually, loaded at runtime as WASM) and a Next.js frontend
(**`core-front/`**) that talks to it purely over HTTP as a BFF. An nginx **api-gateway**
fronts both over TLS/HTTP2 in every deployment (dev and prod alike) — see
`core/CLAUDE.md`'s deployment-topology diagram for the full picture.

For the actual architecture — the ORM, the module system, permissions, the frontend's
view engine — read **`core/CLAUDE.md`** and **`core-front/CLAUDE.md`**. This README is a
quickstart and contributor guide only; those two files are the framework reference and
stay current as the design evolves.

---

## 🧰 Requirements

- Go **1.26+**
- Node **22+** and pnpm (via `corepack enable`, pinned to `pnpm@12.4.2` in
  `core-front/package.json`) — only needed for frontend work outside Docker
- Docker + Docker Compose
- Git

---

## 🚀 Getting Started

Clone the repository:

```bash
git clone git@github.com:noiia/EERP.git
cd EERP
```

### Configure secrets (first time only)

`eerp-config.json` / `eerp-config.docker.json` / `eerp-config.prod.json` carry real
credentials (JWT signing key, DB password, S3 keys) and are **gitignored** — a past
incident committed working defaults for these and they had to be rotated and scrubbed
from tracking (`docs/security/pentest-2026-09-24.md`). Copy the matching `*.example.json`
template for whichever path you're using and fill in real values; the backend refuses to
boot on an empty, default, or previously-known-leaked value (`core/cmd/app/main.go`).

```bash
cp eerp-config.example.json eerp-config.json                # host-native go run/tests
cp eerp-config.docker.example.json eerp-config.docker.json  # docker compose (dev)
cp eerp-config.prod.example.json eerp-config.prod.json      # docker compose -f compose.prod.yml
```

Generate a strong secret per `master_key`/`db_password` field, e.g.:

```bash
openssl rand -base64 48 | tr -d '\n=+/' | head -c 48
```

`db_password` must be the **same** value in all three files you use, plus one more
place: a gitignored `.env` at the repo root sets `POSTGRES_PASSWORD` for the `db`
container (the only value `docker compose` needs as a plain container env var rather
than reading it from a config file):

```bash
echo "POSTGRES_PASSWORD=<same value as db_password above>" > .env
```

Set `"environment"` to `"development"` in the configs you're running locally —
`"production"` disables demo-data seeding and forces the seeded default admin
(`admin@eerp.local`) to change its password before it can do anything else.

### Run it

```bash
make run              # docker (db, garage, nats, pdf-service, api-gateway) + backend + frontend, dev mode
make rebuild-and-run   # clean WASM module builds, rebuild, then run
make run-back-tests    # brings the docker stack up, then `go test` against it
make run-docker-prod    # full stack from ghcr.io images, compose.prod.yml layered on top
```

The gateway serves the app at `https://localhost` (self-signed dev cert, provisioned
automatically). `make run` also starts the frontend's own dev server directly (not
through Docker) for fast iteration — see the Makefile for exactly what each target does;
it's short enough to read end to end.

Format and lint the backend before sending a change:

```bash
gofmt -w .
cd core && golangci-lint run ./...
```

---

## 📁 Project Structure

```
.
├── core/                    # Go backend service
│   ├── cmd/app/main.go      # entry point
│   ├── internal/            # auth, middleware, settings, pictures, reports, cron, ...
│   ├── orm/                 # the generic CRUD/permission/migration engine modules build on
│   ├── modules/              # business modules (crm, contact, sale, warehouse, propertymanagement, ...)
│   ├── configs/, schema/, scripts/, pkg/
│   └── Dockerfile
├── core-front/               # Next.js frontend service (its own process/Dockerfile)
│   ├── apps/shell/           # the App Router host app
│   └── packages/core-front/  # @eerp/core-front — the reusable view engine
├── tools/
│   ├── eerp-init-module/     # scaffolds a new module: go run ./tools/eerp-init-module -p core/modules/<name> -t go|wasm
│   └── pdf-service/          # standalone Chromium-backed PDF renderer
├── infra/
│   ├── nginx/                 # api-gateway config + dev TLS cert generation
│   └── garage/                # S3-compatible object storage config (pictures/attachments/reports)
├── docs/
│   ├── adr/                   # architecture decision records
│   ├── roadmaps/              # in-progress feature design docs
│   └── security/              # audits and their remediation follow-ups
├── compose.yml                # dev stack: db, garage, nats, pdf-service, api-gateway, core-back, core-front
├── compose.prod.yml           # overlay: pulls ghcr.io images, tighter network exposure — see its own header comment
├── eerp-config*.example.json  # committed templates — copy, don't edit in place
├── eerp-config*.json          # your real, gitignored configs
├── .env                       # gitignored — POSTGRES_PASSWORD only
└── Makefile
```

### Rules

`cmd/` contains only main packages.

`internal/` is preferred for business logic.

Avoid circular dependencies.

Keep packages small and focused.

A module lives under `core/modules/<name>/` (Go source either way — `module.json`'s
`type` decides whether it compiles into the binary or loads as WASM) and, if it has a
frontend, `core-front/apps/shell`-visible views under its own `views/` folder, declared
in the same `module.json`. Scaffold one with `go run ./tools/eerp-init-module`.

---

## 🧠 Go Code Style Guidelines

This project follows idiomatic Go conventions:

### Formatting

Always run:
```bash
gofmt -w .
```
No manual formatting.

### Linting

Install golangci-lint
```bash
curl -sSfL https://golangci-lint.run/install.sh | sh -s -- -b $(go env GOPATH)/bin v2.10.1
echo 'export PATH=$PATH:$HOME/go/bin' >> ~/.bashrc
source ~/.bashrc
```

Always run (from `core/`):
```bash
cd core
golangci-lint run ./...
```

### Naming

- Use camelCase for variables and functions.
- Use PascalCase for exported identifiers.
- Keep names short but meaningful.

Avoid stuttering:

`❌ user.UserService`

`✅ user.Service`

### Error Handling

- Errors are values — handle them explicitly.
- Return errors as the last return value.
- Wrap errors with context when needed:

`return fmt.Errorf("failed to load config: %w", err)`
### Comments

Exported identifiers must have comments.

Comments should start with the name of the thing they describe.
```bash
// Server represents the HTTP server.
type Server struct {}
```
### Interfaces

Define interfaces where they are used, not where they are implemented.

Prefer small interfaces and Bento box style.

### Testing

Tests live in `*_test.go` files.

Table-driven tests are preferred.

Use `t.Helper()` for helpers.

Avoid testing implementation details.

---
## 🧪 Testing Conventions

Test names should be descriptive:
```bash
func TestUserService_CreateUser(t *testing.T)
```
Use subtests:
```bash
t.Run("invalid email", func(t *testing.T) {})
```

Run the backend suite with `make run-back-tests` (brings the docker stack up first, then
runs `go test` against it — pass `BACKTESTPATH=./orm/...` or `ARGS="-v -run TestFoo"` to
narrow it down). Frontend tests run via `pnpm test` inside `core-front/`.

---
## 🐛 Issues Guidelines

⚠️ Before opening an issue:
- Search existing issues.
- Use the appropriate issue template.
- Provide clear reproduction steps.
- Attach logs, screenshots, or code snippets when relevant.

Issue titles should be:
- Short
- Actionable
- Descriptive

Templates are enabled depending on your necessity (feature, improvement, bug), when you create a new issue, begin by typing `/template` in the description and select the one that fits bests for your situation.

Please contact the team if you need a custom template.

```bash
<type>(optional scope): <description>
```
Examples:

`bug(config): panic when config file is missing`

`feat(security): add JWT authentication`

`docs(installation): clarify installation steps`

---
## 🧾 Commit Message Convention

This project uses Conventional Commits (GitHub-friendly).

### Format
```bash
<type>(optional scope): <description>
```
### Types
```bash
feat – new feature
```
```bash
fix – bug fix
```
```bash
docs – documentation only
```
```bash
style – formatting, no logic change
```
```bash
refactor – code change without feature/fix
```
```bash
test – tests only
```
```bash
chore – tooling, CI, deps, etc
```
### Examples
```bash
feat(auth): add JWT token validation
fix(config): handle missing config file
docs(readme): update setup instructions
refactor(user): simplify repository interface
```
### Rules:
- Use present tense
- No capital letter at the beginning
- No trailing period
- Keep it under ~72 characters
---
## 🤝 Contributing

### Fork the repository

Create a feature branch:
```bash
git checkout -b feat/my-feature
```
Commit using the convention above

Open a Pull Request

## 📄 License

This project is licensed under the GNU AGPL v3.

## Contributions

By contributing to this project, you agree to the terms of the
Contributor License Agreement (CLA) available in the CLA.md file.

In short:
- You allow the project owner to reuse your contributions freely
- Your contributions may be relicensed, including into proprietary software
