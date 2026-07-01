# Finora

Finora is a local-first personal finance service. It imports statement files,
syncs supported provider connections, stores normalized records in SQLite, and
exposes the same application core through a CLI, a local HTTP API with a web UI,
a desktop app, and a read-only MCP server.

## Principles

- Local by default: data is stored in one SQLite database on your machine.
- Deterministic imports: CSV and OFX/QFX files do not require an LLM.
- Exact money: amounts are integer minor units, never floating point.
- Clear direction: positive amounts are inflows; negative amounts are outflows.
- One core: CLI, HTTP, and MCP call the same application service.
- Explicit provider ownership: Plaid and SnapTrade accounts are managed through
  provider connection flows, not by deleting local rows directly.
- Extension through ports: import formats, provider syncs, storage, and client
  protocols stay behind application interfaces.

Finora does not move money, store bank credentials, or provide financial advice.

## Web workspace

The web UI includes:

- Insights, banking, brokerage, dashboards, credit reports, and settings.
- Dashboard widgets from saved artifacts plus locally created charts. Locally
  created charts can be edited or deleted in the browser; built-in and saved
  widgets can be hidden from the dashboard without deleting server data.
- Credit report import for text-searchable PDFs downloaded from
  AnnualCreditReport.com. The overview is report-first and does not assume a
  score is present; uploaded reports can be deleted from the local store.
- Alert rules managed from Settings. Creating an alert opens a preview flow
  before saving delivery scope, cadence, channel, and schedule.

## Quick start

Requirements: Node.js 22.13 or newer and pnpm.

```bash
pnpm install
pnpm cli accounts add --institution "Example Bank" --name "Checking"
pnpm cli ingest ./statement.csv --account <account-id>
pnpm dev
```

Open <http://127.0.0.1:3011>. The database defaults to
`~/.finora/finora.db`. Configure the host, port, and data path with `.env`
variables shown in [`.env.example`](.env.example).

## Desktop application

The Tauri application starts and stops its own authenticated local backend. It
does not require a separately running server.

```bash
pnpm tauri:dev
pnpm tauri:build
```

Development mode runs the TypeScript backend from the repository. A packaged
application includes the compiled backend, web assets, and the matching Node.js
runtime. Desktop data is stored in the operating system's application data
directory under the `com.finora.desktop` identifier.

The UI is built as a React/Vite web app. The desktop app packages the same
static web output in a Tauri webview.

## Releases

GitHub Actions builds unsigned desktop installers for macOS arm64, macOS x64,
Windows x64, and Linux x64, then publishes them to this repository's GitHub
Releases.

Create a release by pushing a version tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

You can also run the `Release` workflow manually from the Actions tab and
provide the tag to publish under.

## Commands

```text
finora accounts list
finora accounts add --institution <name> --name <name> [--type checking]
finora ingest <file> --account <account-id> [--format auto|csv|ofx]
finora transactions [--account <account-id>] [--limit 50]
finora summary [--from YYYY-MM-DD] [--to YYYY-MM-DD]
finora serve
finora mcp
```

An import is idempotent at both file and transaction level. Importing identical
content into the same account returns the existing import and inserts no
duplicate rows.

CSV imports recognize common date, description, amount, debit, credit, category,
type, and transaction ID headers. A single signed amount column uses Finora's
native convention: positive is inflow and negative is outflow. A type column can
make unsigned amounts explicit (`debit`, `credit`, `deposit`, or `purchase`). OFX
and QFX signs already use the native convention and are preserved.

## Provider connections

Plaid banking and SnapTrade brokerage integrations are configured from the web
UI or HTTP API. Provider-managed accounts are created and refreshed by provider
sync. They cannot be hard-deleted through the account delete endpoint; remove
the provider connection instead so the next sync cannot recreate stale local
rows.

Provider credentials are stored in the local SQLite database. Finora does not
proxy credentials to any service other than the configured provider SDK call.

## Development

```bash
pnpm typecheck
pnpm test
pnpm build:web
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml
```

The architecture and extension contracts are documented in
[`docs/architecture.md`](docs/architecture.md). The HTTP contract lives in
[`docs/openapi.yaml`](docs/openapi.yaml) and is also served at
`/openapi.json` by the local server.
