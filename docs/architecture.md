# Architecture

Finora uses a ports-and-adapters layout without an application framework. The
application service owns business rules; adapters translate CLI, HTTP, MCP,
desktop, provider, and file-format concerns into that service.

```text
CLI  ----\
HTTP ----+--> FinanceService --> FinanceRepository --> SQLite
MCP  ----/          |
                    +--> StatementParser registry --> CSV / OFX
                    +--> Provider SDK adapters --> Plaid / SnapTrade
React web --> local HTTP API
Tauri --> authenticated loopback HTTP + packaged React webview
```

## Boundaries

- `domain` contains stable financial types and invariants.
- `application` implements use cases and declares storage/parser ports.
- `infrastructure` contains SQLite, LLM, Telegram, and statement format adapters.
- `http`, `mcp`, and `cli` translate external protocols into application calls.
- `src/http/web` is the React web client source. Vite builds it to
  `dist/http/web`, and both the local HTTP server and Tauri package serve that
  same static output.
- `composition.ts` is the only place that wires concrete adapters together.
- `src-tauri` owns only the native window and backend process lifecycle.

Accounts can record provider ownership with `source` and `providerAccountId`.
Provider payloads belong in metadata or provider connection records. Business
rules should depend on normalized account, transaction, holding, balance, and
connection fields rather than provider SDK objects.

## Money model

All amounts are signed integer minor units. For USD, `1250` means an inflow of
`$12.50`; `-1250` means an outflow of `$12.50`. Currency is recorded alongside
every account and transaction. Aggregation never mixes currencies silently.

## Persistence

SQLite is the default because Finora is a single-user local service. WAL mode,
account-scoped file hashes, transaction fingerprints, provider connection
records, and insert-time deduplication are enabled. The repository port isolates
SQLite so another store can be supplied.

## Extension points

### Statement format

Implement `StatementParser`, then register it in `createApplication`. A parser
only transforms bytes into normalized transactions; it never writes storage.

### Account provider

Provider integration code obtains remote records, converts them into normalized
account, transaction, holding, and balance inputs, and stores connection state
through the provider connection port. Credentials and provider SDK types stay
outside the domain.

Provider-managed accounts should not be deleted directly. Removing a provider
connection is the owner operation because a later provider sync can recreate
accounts that still exist upstream.

### New client protocol

Instantiate `FinanceService` and translate protocol input/output at the edge.
Business rules must not be duplicated in the client adapter.

## API policy

The HTTP API binds to loopback by default. Deployments that expose it beyond
loopback must add authentication at a trusted reverse proxy. The API is
path-versioned under `/v1`. Additive changes remain in `v1`; breaking changes
require a new path version.

The desktop application launches the same API on a random loopback port and
requires a per-process session token for every data route. The token is passed
only to the Tauri webview. Health checks remain unauthenticated. Packaged builds
carry a platform-native Node runtime so users do not need Node.js installed.

## Notifications

Notification setup is channel-first. The user chooses one active delivery
channel, then sees only that channel's credentials and instructions. Channel
credentials and setup instructions should be rendered together so the UI does
not ask for unrelated inputs.

Telegram should not ask users to paste a manual target identifier. Save the bot
token first, then bind the target chat through a Connect flow when the Telegram
gateway exists. Slack may keep a channel target until a channel picker is
available.

## Alerts and insights

Rules are read-only, deterministic at the trigger boundary, explainable, and
quiet unless there is something worth acting on. Built-in and custom generated
rules share the same high-level taxonomy:

- Cash flow: income timing, bill runway, idle cash, recurring spend.
- Spending: large charges, duplicates, subscriptions, fees, categorization
  cleanup.
- Credit: utilization, card interest, late or fee signals.
- Investments: cash drag, concentration, portfolio movement, executed orders.
- Connections: provider status, missing tokens, stale cursors, sync health.

Detection levels:

- `D`: deterministic compute. Trigger, dedupe key, severity, and copy are local.
- `L`: deterministic trigger plus generated copy from local facts.
- `L+`: deterministic prefilter plus LLM admit/reject, with deterministic
  fallback.

Custom rules are stored as normalized rule metadata, not as separate query
programs per detection level. The preview flow may use the configured chat model
to infer delivery fields, then falls back to local inference. The saved rule
keeps scope, cadence, channel, and scheduled hour; evaluators decide whether the
rule runs as `D`, `L`, or `L+` from the rule kind.

Built-in evaluators should cover connection health, idle cash, low or negative
balance risk, large transactions, duplicate or unusual charges, subscription
drift, trial conversions, discretionary spending, cash runway, expected income,
fees and interest, credit utilization, credit report review, credit payment
timing, brokerage cash drag, portfolio concentration, allocation drift, executed
orders, dividends or interest, weekly financial health, net-worth movement, and
stale imports.

The alert creation UI should live with the page-level controls rather than
inside the rules list. A new rule is saved only after the preview flow has
resolved concrete delivery metadata.

## Dashboards

Dashboards render saved chart artifacts together with locally created charts.
Local chart definitions live in browser storage so users can iterate on charts
without changing server-side dashboard records. A local chart can be edited or
deleted. Built-in or server-backed widgets can be hidden locally; hiding is not a
server delete and does not change the underlying artifact.

Dashboard chart creation is prompt-first: the user describes the desired chart,
previews it against local data, then saves it. Editing an existing chart reuses
the same chart identifier instead of creating a duplicate.

## Credit reports

Credit report import is intentionally modal. The credit page should provide one
upload action plus instructions to download a free report from
https://www.annualcreditreport.com/. The upload control itself belongs in the
modal so accidental page-level drops do not start parsing private PDFs.

Credit report PDFs commonly do not include a score, so the UI must not be
score-first. The default view is the latest uploaded report, followed by AI
insights, open accounts, and all parsed inquiries. Historical reports belong in
the Reports tab. Deleting a report removes the parsed local record and returns
the overview to the next latest report, if any.
