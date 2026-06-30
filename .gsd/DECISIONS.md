# Decisions

## 2026-06-28: Minimal local-first foundation

- Use Node.js built-ins plus small parsing and validation libraries; no web
  application framework.
- Use SQLite behind a repository port instead of requiring an external database.
- Represent money as signed integer minor units, with inflow positive and outflow
  negative.
- Require an explicit account for imports; account resolution must not depend on
  an LLM or a filename heuristic.
- Expose a versioned `/v1` HTTP contract with cursor pagination and one error
  envelope.
- Keep MCP read-only. Writes occur through explicit CLI or HTTP operations.
- Treat providers, LLM features, notifications, and desktop packaging as optional
  adapters rather than core dependencies.

## 2026-06-28: Tauri desktop shell

- Keep business logic in the TypeScript application service; the Rust layer owns
  only native window and child-process lifecycle.
- Bundle a platform-native Node runtime and a single-file backend for standalone
  desktop releases.
- Use a random loopback port and per-launch token for desktop API access.
- Store desktop data in the operating system application data directory.
