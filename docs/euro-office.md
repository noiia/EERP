# Euro-Office in EERP

Euro-Office Document Server supplies the office editors. EERP keeps the file storage,
ownership, folder permissions, conversation visibility and sharing rules.

## Use

In Teams → Files, **New document** creates a document (`.docx`), spreadsheet (`.xlsx`)
or presentation (`.pptx`) in the current folder and opens it in Euro-Office. Existing
Office files open from the file list, shared files, conversation attachments and
file fields. The original download link remains available.

Team owners can edit all files they can see. Members can edit their own uploads.
Guests and recipients of an individual share get a viewer. Conversation attachments
and record attachments open read-only. Their existing replacement actions still apply.

DOCX, XLSX and PPTX support collaborative editing. DOC, XLS, PPT, ODT, ODS, ODP,
TXT, CSV, RTF, PDF and VSDX open for viewing and downloading. Other formats retain
their ordinary download behavior. Use Euro-Office's **File → Download as** for PDF
and other supported exports; the export comes from the current editor document.

The editor synchronizes changes to DocumentServer while users work. EERP receives
the final file when the last editor closes the document. Closing while changes are
still synchronizing shows a confirmation. A save preserves the file ID, owner,
folder, name, shares and conversation references. Concurrent or outdated callbacks
cannot overwrite a newer stored version. Force-save is disabled so collaborators
keep the same session key until their final save.

The signed editor session uses the connected EERP account's stable ID, display
name and avatar. If the display name is empty, it uses the full name, username,
email, then ID. These values are loaded by Go from the active account; the browser
cannot select another collaborator's identity. Fast co-editing is enabled.

## ERP diagrams

In an editable document, select **Plugins → ERP diagrams** (**Diagrammes ERP** in
French). Choose a module's task view, project and diagram: Gantt, WBS, PERT, PBS,
OBS, risk matrix (current or residual), Ishikawa or risk register (the project's AMDEC
register as a table, most critical first, with category and responsible names). Preview, optionally set a title,
then insert at the current document position. Double-click an inserted diagram to
reload the current ERP data, change its settings and update the same object.

The document contains a PNG preview and a small versioned specification (view path,
project ID, diagram type and display options). The preview remains available when
the recipient has no EERP access, and appears in Euro-Office's PDF exports. It is a
snapshot, not a live synchronization: refreshing is explicit and requires current
access to the source project. Do not share a document with recipients who should
not see its embedded snapshot. No ERP credentials or raw datasets are embedded.

Sources come from installed module view descriptors, including their declared
filters. Reads use the existing authenticated RelationOps server actions and Go
permissions; diagram insertion never changes project data or saved diagram layouts.
Snapshots are limited to 200 records per dataset. Partial snapshots are marked in
the exported diagram. PERT highlights the critical path and reports dependency
cycles; missing duration estimates use the existing one-day fallback.

Docker Compose mounts `infra/euro-office/plugins/erp-diagrams` into DocumentServer.
The SDK is served locally with its license and source notice in `vendor/`. When
upgrading an existing installation, recreate the `euro-office` service to apply
the new mount, and rebuild the backend and frontend. The plugin requires the
editor and EERP to share an origin. Messages are accepted only from that editor's
plugin iframe and are correlated to the open insertion request. Read-only editors
do not receive the diagram plugin.

## Docker Compose

Run `make bootstrap` for development. It generates a dedicated
`EERP_EURO_OFFICE_JWT_SECRET`, writes the Office settings into the local configs,
and starts the `euro-office` service. Production bootstrap configures the same
integration for `ERP_HOST`. Existing configurations gain the optional Office keys.

The image is `ghcr.io/euro-office/documentserver:v9.3.1`; set `EURO_OFFICE_TAG` to
select another release. Persistent volumes retain DocumentServer state and private
runtime data. Example and administration applications are disabled. The editor is
served through `/euro-office/` on the EERP gateway (with `/sdkjs/` asset compatibility), including collaboration
WebSockets. In development, `127.0.0.1:8092` also lets a host-native backend fetch
the final document. Production removes that host port.

Office pages use `X-Frame-Options: SAMEORIGIN` so the editor can be embedded in
EERP. Open EERP through the same origin as `euro_office_url` (including the scheme
and port). Other EERP pages retain `DENY`. After changing the gateway's headers,
validate and reload it with `docker compose exec api-gateway nginx -t` then
`docker compose exec api-gateway nginx -s reload`; hard-refresh an already open
browser tab if it cached the previous Office response.

The official [installation guide](https://github.com/Euro-Office/documentation/blob/main/docs/installation/docker.md)
lists the image's disk and memory requirements. The first boot can take several
minutes; Docker's health check waits for the document service.

## Configuration

| Setting                    | Purpose                                             | Docker example                  |
| -------------------------- | --------------------------------------------------- | ------------------------------- |
| `euro_office_url`          | DocumentServer address reached by the browser       | `https://localhost/euro-office` |
| `euro_office_internal_url` | Same DocumentServer reached by Go                   | `http://euro-office`            |
| `euro_office_storage_url`  | EERP backend reached by DocumentServer              | `http://core-back:8080`         |
| `euro_office_jwt_secret`   | Dedicated shared JWT secret, at least 32 characters | Generated by bootstrap          |

For a host-native Go process, the internal address is `http://127.0.0.1:8092` and
the storage address is `http://host.docker.internal:8080`. The Office container has
the corresponding host-gateway entry. An empty secret disables the integration;
downloads remain available and the editor explains that Office is not configured.

No ERP bearer token reaches DocumentServer. Go signs editor configurations, valid for five minutes, and
issues file-, tenant-, user- and purpose-scoped content/callback URLs, valid for
24 hours. Content requests and callbacks reload the active user and recheck the
source's current access. An editing session longer than 24 hours must be reopened.
Callbacks additionally require DocumentServer's signed outbox JWT. Result URLs
are restricted to the configured server's cache path, redirects are refused, and
saved packages are limited to 20 MiB. Storage bytes are replaced atomically before
the old object is deleted. A failed save returns the DocumentServer error response
and leaves the original file intact.
