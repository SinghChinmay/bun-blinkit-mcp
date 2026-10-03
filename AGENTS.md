# AGENTS.md

`bun-blinkit-mcp` — unofficial, **API-only** MCP server for blinkit.com. TypeScript + Bun. Talks directly to Blinkit's consumer-web JSON API over HTTPS. **No browser/Playwright anywhere; do not reintroduce it.**

## Commands

- `bun install` — install deps.
- `bun run main.ts` — run the MCP server (stdio by default).
- `bun run test/cli.ts` — interactive CLI for the full flow.
- `bun run test/tools.ts` — list registered tools; exits 1 if a payment tool leaks.
- `bun test` — unit tests: `parse.ts`, `staples.ts` scorer, SQLite store (`BLINKIT_DB=:memory:`).
- `bun run typecheck` (`bunx tsc --noEmit`) — strict type-check.
- `BLINKIT_HOME=/tmp/blinkit-e2e bun run test/smoke.ts` — live e2e (`set_location` → `search` → `add_to_cart` → reprice); network required, no login/order.

No linter or formatter is configured.

## Critical: stdout is the MCP protocol channel

- With stdio transport, stray output corrupts JSON-RPC. **Never `console.log` in server code — use `console.error`.**
- New tool handlers must go through the `register()` helper in `src/server.ts` so error wrapping and the location/login guards apply.
- `start.sh` (the `.mcpb` entrypoint) redirects setup stdout to stderr, installs Bun if missing, runs `bun install --frozen-lockfile`, then `exec`s `bun run main.ts`.

## Adding a tool

1. Implement in `src/api.ts` / `src/cart.ts` / `src/store.ts`.
2. Register in `src/server.ts` via `register(name, description, schema, handler, { guard, login })`.
3. Keep the `tools` array in `manifest.json` in sync.

## Architecture

- `main.ts` → `startServer()` in `src/server.ts`.
- `src/client.ts` — all HTTP via `impit` (`new Impit({ browser: "chrome" })`, Chrome TLS fingerprint to pass Cloudflare), static headers, `auth_key` bootstrap (`REQ_KEY`), and the guards. Keystone of the browser-free runtime.
- `src/session.ts` — `~/.blinkit-mcp/session.json` (chmod 600): `device_id`, `session_uuid`, `auth_key`, `access_token`, `location`.
- `src/api.ts` — Blinkit endpoint wrappers.
- `src/parse.ts` — defensive tree-walking extraction of products/orders from hashed SDUI responses.
- `src/cart.ts` + `src/store.ts` — stateful local cart in SQLite (`bun:sqlite`). Blinkit `/v5/carts` is stateless, so the local cart is the source of truth, repriced on change.
- `src/staples.ts` — pure multi-factor scorer + staple resolution.

## Guards & invariants

- `requireLocation()` is central in `src/client.ts`; applied via `register(..., { guard: true })`. **Do not bypass it.** Auth and location-setup tools are exempt; no catalog/cart/checkout/order tool may run without a confirmed location.
- Never send `access_token: "null"`; the header is omitted when logged out (handled in `request()`).
- `verifyOtp` branches on `res.verified && res.access_token`, never on `success` — Blinkit returns `success: true` for a wrong OTP.
- Payments stay unautomated. Never add `proceed_to_pay`, `get_upi_ids`, `select_upi_id`, `pay_now`, or payment-method selection. `checkout` only creates a server cart, binds an address, and validates.
- All Blinkit HTTP goes through `impit`; do not swap in `fetch`.

## Env vars

- `SERVE_HTTPS=true` — serve SSE on `0.0.0.0:8000` (`/sse`, `/messages`) instead of stdio.
- `PORT` — SSE port (default `8000`).
- `BLINKIT_HOME` — state dir (default `~/.blinkit-mcp`).
- `BLINKIT_DB` — SQLite path (default `$BLINKIT_HOME/memory.sqlite`; `:memory:` in tests).
- `BLINKIT_REQ_KEY` — override the fixed `auth_key` `req_key` if Blinkit rotates it.

## Gotchas

- Versions must stay in sync across `package.json`, `manifest.json`, and `src/server.ts` (currently `2.0.0`).
- `src/parse.ts` must stay defensive: responses are hashed, deeply nested SDUI. Walk the tree; never assume widget positions or order.
- `test/` is excluded from `.mcpbignore` packaging.
- Repo remote is `SinghChinmay/bun-blinkit-mcp`. Endpoint research informed by the MIT-licensed `yniks/blinkit-mcp`.
