# EERP MCP Server

EERP exposes its business features to MCP clients at **`/api/v1/mcp`**, directly
in the Go backend. The server uses the [official MCP Go SDK](https://github.com/modelcontextprotocol/go-sdk),
version 1.8.0, with stateless Streamable HTTP and JSON responses. It requires no
additional process or direct client connection to PostgreSQL.

## Enabling the server

Add these options to the backend configuration file, then restart the backend.
Rebuild its image first if you have just installed the implementation:

```json
{
  "mcp_enabled": true,
  "mcp_allow_writes": false,
  "mcp_allowed_origins": [],
  "mcp_rate_limit_per_minute": 120
}
```

All four options are optional. MCP is disabled by default, and writes are
disabled independently. Setting `mcp_allow_writes: true` makes the create,
update, delete, restore and business action tools available. Existing EERP
permissions are still required for every action.

An empty origin list allows native clients that do not send an `Origin` header.
For a web client, add its exact origin, such as `https://assistant.example.com`,
to both `mcp_allowed_origins` and EERP's general CORS `allowed_origins` setting.
Wildcards, paths, embedded credentials and `null` origins are rejected. Origin
validation also applies to CORS preflight requests.

The existing nginx proxy already forwards `/api/v1/*` to the backend. In
production, use the same server's public HTTPS URL:
`https://erp.example.com/api/v1/mcp`.

## Authentication and connection

Every request must include **`Authorization: Bearer <ERP access token>`**.
Use a dedicated ERP account with the appropriate roles. This endpoint has no
shared MCP token, automatic privilege elevation or cookie authentication.
Website visitor tokens, refresh tokens and identities without a user or tenant
are rejected. Accounts required to change their password must do so in EERP
before using MCP.

The client must support Streamable HTTP and a configurable Bearer header.
For clients that accept the following `mcpServers` format, use a configuration
like this. Adapt the keys and secret storage mechanism to your client:

```json
{
  "mcpServers": {
    "eerp": {
      "type": "http",
      "url": "https://erp.example.com/api/v1/mcp",
      "headers": {
        "Authorization": "Bearer <ERP access token>"
      }
    }
  }
}
```

Obtain an access token through the existing ERP sign-in flow
(`POST /api/v1/auth/login`, or the configured LDAP/OIDC flow). The client renews
its token through EERP's existing refresh mechanism and updates its header when
the token expires. Keep passwords, the master key and refresh tokens out of
tool arguments, URLs and version-controlled configuration files.

The server does not implement an MCP OAuth authorization server or OAuth
discovery. Clients that require OAuth and cannot set a custom Bearer header
need an additional authentication integration.

To check the protocol with an access token already stored in the
`EERP_ACCESS_TOKEN` environment variable:

```bash
curl --fail-with-body https://erp.example.com/api/v1/mcp \
  -H "Authorization: Bearer ${EERP_ACCESS_TOKEN}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"eerp-check","version":"1"}}}'
```

The SDK negotiates supported protocol versions. Tests cover version
`2025-11-25` and interoperability with the official SDK client. The endpoint
does not retain user sessions: there is no `Mcp-Session-Id`, persistent SSE
stream or asynchronous notification channel. `GET` and `DELETE` on the MCP
endpoint return `405`; JSON-RPC methods use `POST`.

## Tools

| Tool | Purpose |
| --- | --- |
| `eerp_list_models` | List active models the caller can read, with pagination |
| `eerp_describe_model` | Inspect API fields, Go types, nullability and computed/read-only fields |
| `eerp_list_records`, `eerp_get_record` | Search and read records |
| `eerp_create_record`, `eerp_update_record` | Create and update records with business validation |
| `eerp_delete_record`, `eerp_restore_record` | Delete and restore records according to model rules |
| `eerp_list_operations` | Browse registered business API methods and routes, with pagination |
| `eerp_read_operation` | Execute a GET operation from the catalog |
| `eerp_write_operation` | Execute a JSON or multipart mutation from the catalog |
| `eerp_list_projects` | List projects visible to the caller |
| `eerp_get_project` | Read a project, its metrics, schedule or management capabilities |
| `eerp_list_project_tasks` | List a project's tasks and subtasks, with filters and pagination |

In read-only mode, the five write tools are absent from `tools/list`, and write
operations are removed from the catalog. MCP annotations identify read tools
and potentially destructive mutations. These annotations inform the client;
enforcement happens on the server.

The **`eerp://guide`** resource provides usage instructions, and the
**`eerp://models/{model}`** resource template provides the authorized model
schema. The **`eerp_review_project`** prompt accepts a `project_id` argument
and prepares a project review.

## Business and project coverage

Generic tools automatically cover models registered on the CRUD surface:
contacts, CRM, sales, invoices, product catalog, inventory, property management,
events, website pages and workflows, and all project entities. The operation
catalog also includes dedicated routes for teams, conversations, notes,
attachments, images, PDF reports, mail, filters, preferences, settings, users,
roles and module management, depending on the services available in the
deployment.

Schemas respect field exclusions and group restrictions. Accounts and roles
use their dedicated administration routes; their internal tables remain
excluded from generic CRUD. Catalog entries describe server capabilities.
Executing an advertised operation still requires authorization and may be
denied to the caller or rejected when its module is disabled.

Project access covers members, stages, tasks and subtasks, assignments,
dependencies, milestones, timesheets, colors and tags, OBS, PBS, RACI, capacity,
risks and categories, baselines and baseline tasks. Counters, history and other
computed data retain EERP's business rules. History tables excluded from CRUD
remain internal; metrics use them through dedicated business endpoints.

Example arguments for `eerp_list_projects`:

```json
{"query":{"search[name]":"Migration","page":"1","page_size":"50"}}
```

For `eerp_get_project`:

```json
{"id":"<project UUID>","section":"metrics"}
```

`section` accepts `record` (the default), `metrics` (burndown, EVM, flow and
risk), `schedule` (the computed schedule) or `can_manage`.

For `eerp_list_project_tasks`:

```json
{"id":"<project UUID>","query":{"page":"1","page_size":"50","order":"sequence","assigned_to_me":"1"}}
```

Other project entities use the same query format with `eerp_list_records`:

```json
{"model":"project_risk","query":{"filter[project_id]":"<project UUID>","page_size":"50"}}
```

Create a baseline with `eerp_write_operation`:

```json
{
  "operation":"POST /api/v1/project/:id/baseline",
  "path_params":{"id":"<project UUID>"},
  "body":{"name":"Approved baseline"}
}
```

A members-only project remains hidden from other users. Project managers and
administrators retain their additional permissions, and task assignees retain
the access granted by EERP's existing rules.

## Filters, results and files

`query` is an object of strings, forwarded as encoded API parameters: `page`,
`page_size`, `order`, `filter[column]`, `search[column]`, `in[column]`, `gt[]`,
`gte[]`, `lt[]`, `lte[]`, and so on. Endpoints retain their own validation and
limits. A first page is never a complete export. MCP additionally restricts
`page_size` to values between 1 and 200.

Discovery tools accept `search`, `offset` and `limit` (50 by default, 200
maximum), and return `data`, `total`, `next_offset` and `has_more`.

Business responses use the form `{"status":200,"data":...}`. The `data` field
preserves the original API envelope, such as `{data:[...],total:42}` for a list.
A business `4xx` response preserves its status and message and sets `isError`
in the MCP result. Internal `5xx` errors are masked; details remain in the
server logs. Binary downloads return `mime_type` and `base64`. Cookies are not
forwarded, and redirects are not followed.

For multipart uploads, replace `body` with `form` and `files`:

```json
{
  "operation":"POST /api/v1/attachments",
  "form":{"table_name":"project","record_id":"<project UUID>","field":"documents"},
  "files":[{"field":"file","name":"report.pdf","mime_type":"application/pdf","base64":"<base64 content>"}]
}
```

The server limits an MCP request to **1 MiB**, an API response to **4 MiB**, an
operation to **30 seconds**, and encoded API query parameters to **16 KiB**.
Each process allows at most 16 concurrent MCP business operations. Additional
operations are rejected before execution.

Base64 encoding increases file size. Use the regular EERP HTTP endpoints for
large files, and reduce page sizes when a response exceeds the limit. A
mutation may have completed before a timeout, cancellation or response limit
error: check its outcome before retrying it.

## Security and maintenance

- Operations re-enter the final HTTP router. JWT authentication, permissions,
  tenant isolation, field groups, row visibility, active module checks and
  business overrides apply as they do in the application.
- MCP arguments cannot set a remote URL, request headers or the authenticated
  tenant. Paths are built from known operation IDs, with segment validation
  and verification of the resolved route. Raw SQL execution is not exposed.
- Internal requests do not forward cookies, proxy headers or WebSocket upgrade
  requests. Presence provides its HTTP snapshot only.
- Origins are checked before CORS processing. Requests are limited per IP
  (120 per minute by default, per process), in addition to existing API checks.
- MCP audit logs record the operation, user, tenant, status and duration.
  They do not record tokens or argument bodies.
- Authentication, public and visitor routes, webhooks, database administration
  and development data seeding are excluded. New families of dedicated routes
  require explicit admission in `mcpbridge.New`; new CRUD models are discovered
  automatically.
- Business content and files are untrusted data. Clients must retain control
  over tool calls and obtain the user's consent for mutations.

Permissions and groups follow EERP's existing session and cache mechanisms.
Revocation is subject to those mechanisms' guarantees and must not be assumed
to take effect immediately. MCP adds no authorization cache of its own.

The implementation is in `core/internal/mcpbridge`, with final route wiring in
`core/internal/app/app.go` and schema projection in `core/orm/server/catalog.go`.
The [MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
and SDK define JSON-RPC negotiation and the protocol lifecycle.

## Verification

From `core/`, using Go 1.27.3 (the repository's pinned version):

```bash
go test -race ./internal/mcpbridge ./orm/server
go test ./internal/types ./internal/app
CONFIG=../eerp-config.json go test ./modules/project -run MCP
```

Tests that do not require a database cover the protocol, tools, resources,
prompts, official client interoperability, origins, JWT authentication,
read-only mode, permissions, concurrent identity isolation, files, errors and
limits. PostgreSQL project tests verify access for managers, members,
non-members and other tenants through the actual MCP endpoint. They use an
isolated test tenant and clean up only the rows created by the test.
