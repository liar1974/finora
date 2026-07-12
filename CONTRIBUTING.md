# Contributing to Finora

This guide is for developers who want to run Finora from source, work on the
code, or cut a release. If you just want to *use* the app, see the
[README](README.md) and the [onboarding guide](docs/onboarding.md) instead.

## License and contributor agreement

Finora is open source under the [GNU AGPL-3.0](LICENSE). By contributing, you
agree that your contributions are licensed under the AGPL-3.0, and — because
maintaining the project sustainably may involve dual-licensing — you also agree
to the [Contributor License Agreement (CLA)](CLA.md).

**In short:** you keep ownership of your work; you grant the maintainers a broad
license (including the right to relicense) so Finora can be offered under the
AGPL-3.0 and, if needed, separate commercial terms. You accept the CLA by signing
off your commits:

```bash
git commit -s   # adds a "Signed-off-by: Name <email>" line
```

See [CLA.md](CLA.md) for the full terms.

## Architecture and API

- [Architecture](docs/architecture.md) — local-first boundaries, provider rules,
  extension points, and API policy.
- **OpenAPI contract** — the running local server serves it at
  `GET /openapi.json`, generated from `src/http/openapi.ts` (the single source of
  truth for the HTTP surface).

Principles that shape the code:

- **Local by default** — data is stored in one SQLite database on your machine.
- **Deterministic imports** — CSV and OFX/QFX files do not require an LLM.
- **Exact money** — amounts are integer minor units, never floating point.
- **Clear direction** — positive amounts are inflows; negative are outflows.
- **One core** — CLI, HTTP, MCP, and desktop call the same application service.
- **Explicit provider ownership** — Plaid accounts (bank and brokerage) are
  managed through Link update-mode account selection, not by deleting local rows.
  (A SnapTrade brokerage adapter exists in the backend/HTTP API but is not wired
  into the desktop UI, which connects brokerage through Plaid Link.)
- **Extension through ports** — import formats, provider syncs, storage, and
  client protocols stay behind application interfaces.

## Run From Source

You need Node.js 22.13 or newer and pnpm.

```bash
pnpm install
pnpm cli accounts add --institution "Demo Bank" --name "Checking"
pnpm cli ingest ./statement.csv --account <account-id>
pnpm dev
```

Open <http://127.0.0.1:3011>. The database defaults to `~/.finora/finora.db`.
Configure the host, port, and data path with `.env` variables shown in
[`.env.example`](.env.example).

Common CLI commands:

```text
finora accounts list
finora accounts add --institution <name> --name <name> [--type checking]
finora ingest <file> --account <account-id> [--format auto|csv|ofx]
finora transactions [--account <account-id>] [--limit 50]
finora summary [--from YYYY-MM-DD] [--to YYYY-MM-DD]
finora serve
finora mcp
```

An import is idempotent at both the file and transaction level. Importing
identical content into the same account returns the existing import and inserts
no duplicate rows.

CSV imports recognize common date, description, amount, debit, credit, category,
type, and transaction ID headers. A single signed amount column uses Finora's
native convention: positive is inflow and negative is outflow. A type column can
make unsigned amounts explicit (`debit`, `credit`, `deposit`, or `purchase`).
OFX and QFX signs already use the native convention and are preserved.

## Desktop application

The Tauri application starts and stops its own authenticated local backend, so
it does not need a separately running server.

```bash
pnpm tauri:dev
pnpm tauri:build
```

Development mode runs the TypeScript backend from the repository. A packaged
application bundles the compiled backend, the static web assets (the same
React/Vite build the web UI uses), and a matching Node.js runtime. Desktop data
is stored in the OS application data directory under `com.finora.desktop`.

## Provider connections

Plaid banking and brokerage connections are configured from the desktop UI or
HTTP API and are optional — Finora also works with CLI/HTTP file imports. (A
SnapTrade brokerage adapter exists in the HTTP API only and is not exposed in the
desktop UI.) Provider-managed accounts are created and refreshed by provider sync
and cannot
be hard-deleted through the account delete endpoint. In particular, Finora never
removes a Plaid Item as part of account management: dropping one bank account
uses Plaid Link update mode with account selection, after which Finora deletes
only local rows for accounts Plaid no longer returns. Credentials are stored in
the local SQLite database and are never proxied anywhere except the configured
provider SDK call. See the [architecture guide](docs/architecture.md) for the
full connector rules.

## Development checks

```bash
pnpm typecheck
pnpm test
pnpm build:web
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml
```

## Cutting a release

Create a release by pushing a version tag (or run the `Release` workflow
manually from the Actions tab):

```bash
git tag v0.1.0
git push origin v0.1.0
```

The [`Release` workflow](.github/workflows/release.yml) builds installers for
macOS (arm64/x64), Windows x64, and Linux x64, then publishes them to a GitHub
release. The Linux job builds only the native `.deb`/`.rpm` bundles (`--bundles
deb,rpm`); AppImage is skipped because `linuxdeploy` cannot self-extract on the
FUSE-less GitHub-hosted runners and aborts. Alongside the versioned Tauri outputs
it also uploads version-less copies (`Finora-macOS-AppleSilicon.dmg`,
`Finora-macOS-Intel.dmg`, `Finora-Windows-Setup.exe`, `Finora-Linux-x86_64.deb`)
so the README's "latest build" download links keep working across releases. If
you change the product name or bundle targets, update the copy step's globs to
match the new Tauri output filenames.

### Auto-update signing

The desktop app updates itself via the Tauri updater. Its public key is embedded
in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`); the updater endpoint
is `releases/latest/download/latest.json`. For the workflow to produce signed
update artifacts and the `latest.json` manifest (via
`scripts/generate-latest-json.mjs`), add one repository secret:

- `TAURI_SIGNING_PRIVATE_KEY` — the minisign private key generated with
  `pnpm exec tauri signer generate`. The current key has no password, so no
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is needed; if you regenerate the key with
  a password, add that env var back to the release workflow.

This signature is independent of OS code signing, so it works even though the
installers are unsigned. Without these secrets the release still publishes, but
no `.sig`/`latest.json` is produced and auto-update stays dormant. Losing the
private key means existing installs can no longer verify updates — keep it safe.
