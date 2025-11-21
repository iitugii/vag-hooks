# vag-hooks Architecture Overview

## Runtime Picture

- **Server entrypoint (`src/index.ts`)** bootstraps an Express app, wires middleware, mounts routers, and starts listening on `PORT` (default `3000`).
- **Persistence layer** is PostgreSQL accessed through Prisma. A shared client lives in `src/lib/prisma.ts`, but a few routes instantiate ad-hoc Prisma clients when needed.
- **Primary data record** is the `WebhookEvent` Prisma model, representing every webhook delivery together with derived metadata (`day`, optional `cash_collected`).
- **Auth gate**: when `DASH_TOKEN` is set, routes that expose dashboard/export/metrics functionality enforce it via the `gate` middleware declared in `src/index.ts`.
- **Static dashboards** in `public/` provide operator views (`dashboard.html` for event inspection, `cashout.html` for cash tracking).

```
Vagaro → /webhooks/vagaro (rawBody → vagaro router) → WebhookEvent table
       ↘ dashboards/exports query WebhookEvent via metrics/export/debug routers ↗
```

## Module Inventory

| Module | Responsibility | Key Data In/Out |
| --- | --- | --- |
| `src/index.ts` | Express bootstrap; mounts middleware, auth gate, static assets, and feature routers. Provides `/config` for front-end auth discovery and `/health/db` inline DB check. | Reads env (`PORT`, `DASH_TOKEN`); orchestrates routers; queries Prisma for health check. |
| `src/lib/prisma.ts` | Singleton Prisma client with error/warn logging. | Exposes `prisma` used by most modules. |
| `src/middleware/rawBody.ts` | Captures raw request body for signature verification or replay; backfills `req.body` for JSON payloads. | Reads `req` stream; attaches `rawBody`/`body`. |
| `src/routes/health.ts` | Liveness at `/health`; DB readiness at `/health/db`. Uses shared Prisma client. | Returns status messages, row count. |
| `src/routes/events.ts` | Paginated list/detail of stored webhook rows at `/events`. Supports `?limit`. | Reads `WebhookEvent` records; returns JSON list or single record. |
| `src/routes/vagaro.ts` | Primary webhook ingestion endpoint at `/webhooks/vagaro`. Normalizes payload, derives timestamps and optional `cash_collected`, and upserts into `WebhookEvent`. | Consumes HTTP webhook payloads; persists to DB; responds with `{ ok, id, eventId }`. |
| `src/routes/dashboard.ts` | Serves `public/dashboard.html`. | Static file response. |
| `src/routes/export.ts` | Streams Excel workbook at `/export/webhooks.xlsx`. Accepts filters (`entityType`, `action`, `dateFrom`, `dateTo`, `limit`). Uses Prisma to fetch rows and ExcelJS to write workbook. | Outputs XLSX stream. |
| `src/routes/metrics.ts` | Aggregates daily cash totals for a month at `/metrics/cash-daily?month=YYYY-MM`. Re-computes totals from stored payload fields or `cash_collected`. | Returns `{ month, results: [{ day, total }] }`. |
| `src/routes/cashout.ts` | **Heads-up:** file currently contains a leftover git patch instead of executable TypeScript. Intended behavior: serve `public/cashout.html` and provide `/cashout/data` with per-day `cashTotal` and `soldTotal` rollups using a raw SQL window over `WebhookEvent`. | Should read from DB and return chart data; presently needs cleanup. |
| `src/routes/debug.ts` | Token-protected helpers under `/debug-cash-list` to inspect cash-related payload fields for a given day. Uses raw SQL to pull and annotate source keys. | Returns diagnostic JSON with value sources. |
| `src/routes/debugFind.ts` | Token-protected `/debug-find-cash` to find events matching a specific cash amount on a date, identifying which payload key carried the value. | Returns matching rows with key metadata. |
| `src/routes/export.ts` | See above; also invoked by dashboard download button. | — |
| `src/routes/metrics.ts` | See above; consumed by external dashboards. | — |
| `src/routes/health.ts` | See above; used by uptime checks. | — |
| `src/services/eventService.ts` | Legacy helper to persist events with derived `cash_collected`. Normalizes `createdDate` and payload casing, ensuring day partitioning. Not wired into current routes but kept for reuse. | Provides `storeEvent` function. |
| `src/utils/logger.ts` | Minimal console logger wrapper with level prefixes. | Used by `src/index.ts` error handler and startup log. |
| `public/dashboard.html` | Front-end UI for browsing webhook events. Calls `/config`, `/events`, `/export/webhooks.xlsx`, and links to `/cashout`. | Renders table, modal payload viewer, periodic refresh. |
| `public/cashout.html` | Operator UI for cash calendar. Fetches `/cashout/data` and draws monthly calendar with blue (total sold) and green (cash collected) values. Currently committed as a git diff—needs the raw HTML rendered (see note below). |
| `prisma/schema.prisma` | Defines `WebhookEvent` schema, indexes, and optional `cash_collected`/`day` columns. | Drives Prisma migrations and client typings. |

## Data Flow & Routing Map

1. **Inbound Webhook Handling**
   - `src/index.ts` registers `rawBody` middleware before JSON parsing for `POST /webhooks/vagaro` requests.
   - `src/routes/vagaro.ts` reads the normalized body, enriches with metadata (`businessIds`, `sourceIp`, derived `cash_collected`, `day`), and upserts into `WebhookEvent` via Prisma.
   - Prisma model stores raw JSON (`payload`, `rawBody`, `headers`) to support downstream analytics.

2. **Persistence & Schema**
   - `prisma/schema.prisma` describes the PostgreSQL table with indices on `entityType/action` and `day` for reporting.
   - Migrations in `prisma/migrations/` align the DB with schema (init + added `cash_collected`).

3. **Operator Dashboards**
   - `/dashboard` (`dashboard.html`) polls `/events` for recent deliveries, showing payload details with an optional auth token field (`DASH_TOKEN`). Excel downloads route through `/export/webhooks.xlsx`.
   - `/cashout` (HTML) calls `/cashout/data` to plot cash vs. total sales per day. **Action item:** replace the git diff content in `public/cashout.html` with the rendered HTML to restore front-end behavior.

4. **Analytics & Reports**
   - `/export/webhooks.xlsx` constructs an Excel workbook with the selected filters.
   - `/metrics/cash-daily` recomputes daily totals for charting or external BI usage.
   - `/cashout/data` (once restored) issues a raw SQL aggregation to power the calendar UI.

5. **Diagnostics & Debugging**
   - `/health` and `/health/db` provide basic service and DB checks.
   - `/debug-cash-list` and `/debug-find-cash` (token-gated) help trace which payload fields populated cash values on a given day or amount. These rely on raw SQL expressions to inspect nested JSON.

6. **Security & Auth Flow**
   - `DASH_TOKEN` controls access to `/events`, `/dashboard`, `/export`, `/metrics`, `/cashout`, and any other admin routes. Clients supply the token as `?auth=` or `x-auth-token` header.
   - `/config` informs the front-end whether a token is required so the UI can prompt accordingly.

## Notable Implementation Details

- **Raw body capture**: `rawBody` middleware must remain ahead of `express.json()` for webhook signature verification compatibility.
- **Prisma client usage**: prefer the shared `prisma` instance (`src/lib/prisma.ts`) to avoid connection churn; `vagaro.ts`, `cashout.ts`, `debug.ts`, and `debugFind.ts` currently instantiate private clients.
- **Date normalization**: routers frequently convert timestamps to the `America/New_York` timezone for reporting. Adjust queries if your operations move to a different locale.
- **Legacy service**: `src/services/eventService.ts` duplicates portions of `vagaro.ts` logic. Consolidate or remove if unused.
- **Checked-in diffs**: `src/routes/cashout.ts` and `public/cashout.html` include raw `git apply` diff snippets. Replace them with the compiled TypeScript/HTML to re-enable those features.

## Quick Lookup

| Concern | Go-To Module |
| --- | --- |
| Change port, add middleware | `src/index.ts` |
| Modify DB schema | `prisma/schema.prisma` (run `prisma migrate`) |
| Adjust webhook ingestion logic | `src/routes/vagaro.ts` |
| Update dashboard UI | `public/dashboard.html` |
| Tweak cash calendar | `public/cashout.html`, `src/routes/cashout.ts` |
| Export/report tuning | `src/routes/export.ts`, `src/routes/metrics.ts` |
| Debug cash discrepancies | `src/routes/debug.ts`, `src/routes/debugFind.ts` |
| Toggle/require auth token | `src/index.ts` (`DASH_TOKEN` gate) |

## Next Maintenance Actions

1. Restore `src/routes/cashout.ts` to valid TypeScript (remove embedded git diff, keep router/export defaults) so the route can compile.
2. Replace `public/cashout.html` with the actual HTML markup (currently stored as a diff) to re-enable the calendar UI.
3. Optionally refactor routes to share a single Prisma client (`import { prisma } from "../lib/prisma"`) to reduce connection overhead.
