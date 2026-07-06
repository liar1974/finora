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

Schema changes run through a versioned migration runner. A `schema_migrations`
ledger records which numbered migrations have applied; each new migration runs
once, in order, inside its own transaction, on the first launch of a build that
ships it — which is what keeps desktop auto-update safe across schema changes.
Before applying a pending migration to a database that already holds data, the
runner writes a consistent snapshot to `<db>.backup-v<fromVersion>` via
`VACUUM INTO` and refuses to migrate if that backup cannot be written, so an
upgrade can never mutate data it has not first backed up.

## Extension points

### Statement format

Implement `StatementParser`, then register it in `createApplication`. A parser
only transforms bytes into normalized transactions; it never writes storage.

### Account provider

Provider integration code obtains remote records, converts them into normalized
account, transaction, holding, and balance inputs, and stores connection state
through the provider connection port. Credentials and provider SDK types stay
outside the domain.

Provider-managed accounts should not be deleted through the local account delete
endpoint. The correct owner operation depends on the provider. A later provider
sync can recreate accounts that still exist upstream, so account removal must
first change provider-side authorization or connection state.

### Plaid connector rules

These rules are written for engineers implementing Plaid flows. The post-read
action is: add or change a Plaid account-management flow without creating a
duplicate Item, deleting an Item by accident, or deleting local rows before
Plaid authorization has changed.

Terms:

- Item: the Plaid connection for one institution login. It owns the access
  token and can contain multiple accounts.
- Account: one checking, savings, credit, brokerage, or other financial account
  inside an Item.
- Local account: Finora's normalized account row for a Plaid account.

Hard rules:

- Never call Plaid Item removal from normal account-management UI.
- Do not expose an HTTP route whose purpose is to remove a Plaid Item.
- Do not use local account deletion as a substitute for Plaid account
  deauthorization.
- Do not create a new Link flow when the user is changing account selection for
  an existing healthy Item.
- Do not exchange a public token after Link update mode succeeds. Plaid update
  mode keeps the existing access token.

Initial Plaid connection:

- Use normal Plaid Link to create a new Item.
- Exchange the public token once.
- Store the Item id, access token, institution, environment, cursor, and shared
  Plaid account ids in the provider connection record.
- Upsert local accounts from the accounts returned by Plaid.

Reconnect after an Item is gone:

- If Plaid reports that an Item cannot be found, the old access token cannot be
  reused.
- The user must go through a new Link flow.
- Treat the result as a new Item. Reconcile it to existing local accounts only
  by stable evidence such as institution, mask, account subtype, and user
  intent; do not assume the old Item id or account ids remain valid.
- A new Item may count as a new Plaid connection for quota or billing purposes.

Account-level add or remove on an existing Item:

- Open Plaid Link in update mode for the existing Item.
- Create the update link token with the Item's access token.
- Enable account selection on the update token.
- Let the user select or deselect accounts inside Plaid Link.
- On Link success, do not exchange a public token.
- Refresh Plaid accounts for the same Item.
- Compare the refreshed Plaid account ids with local Plaid accounts for that
  Item.
- Add or update local rows for accounts Plaid returns.
- Delete local rows and dependent local data only for accounts Plaid no longer
  returns.
- Keep the provider connection active and keep the same access token unless
  Plaid reports an Item-level error.

Sync behavior:

- Sync only active Plaid connections with saved access tokens.
- Non-active states such as reconnect-required, error, or removed must not make
  provider API calls.
- Account refresh may create or update local account rows, but it must not
  remove local rows unless it is running after a completed account-selection
  update or another explicit provider authorization change.

Provider-specific caveats:

- Some OAuth institutions may require account permission changes in the
  institution's own security center instead of Plaid account selection. In that
  case, show a clear failure or instruction and do not fall back to Item
  removal.
- Duplicate Item handling must prefer repairing or updating the existing Item
  when it still exists. Creating a duplicate Item can increase Plaid usage and
  confuse account matching.
- If an Item is already deleted upstream, there is no local recovery path for
  the old access token. The only path is a new Link flow.

Regression checks:

- Tests should assert that direct local deletion of Plaid-managed accounts is
  rejected.
- Tests should assert that no Plaid Item removal route is exposed.
- Code search during review should find no Plaid Item removal SDK call in the
  application path.

### SnapTrade connector rules

> SnapTrade is an experimental brokerage adapter reachable through the HTTP API
> only; the shipping desktop UI connects brokerage accounts through Plaid Link.
> The rules below apply if and when SnapTrade is exposed in a client.

SnapTrade brokerage accounts are managed through SnapTrade authorizations. A
SnapTrade remove flow may remove the brokerage authorization when the user
chooses to disconnect that brokerage connection. That behavior must not be
copied to Plaid; Plaid account-level changes use update mode instead.

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

The desktop app updates itself through the Tauri updater: it polls
`releases/latest/download/latest.json` and installs an update only after
verifying its minisign signature against the public key embedded in the app.
Because that signature is independent of OS code signing, updates are verified
even though the published installers are unsigned. The updater is driven from the
sidebar "Update available" banner; because the UI is served from the loopback
origin, a capability grants that origin IPC access to the updater/process
plugins.

## Insight delivery

Insight delivery setup is channel-first. The user chooses one active delivery
channel, then sees only that channel's credentials and instructions. Channel
credentials and setup instructions should be rendered together so the UI does
not ask for unrelated inputs.

Telegram should not ask users to paste a manual target identifier. Save the bot
token first, then bind the target chat through a Connect flow when the Telegram
gateway exists. Slack may keep a channel target until a channel picker is
available.

## Rules and insights

Rules are read-only at the trigger boundary, deterministic where correctness
allows, explainable, and quiet unless there is something worth acting on. The
full design — the rule-metadata-plus-evaluator-registry model, the `D` / `L` /
`L+` execution classes, the facts-and-questions layer, the finding contract with
dollar impact and confidence, the ranking function, and the action trust ladder —
lives in
[`rules-design.md`](./rules-design.md).

The rule creation UI should live with the page-level controls rather than
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
