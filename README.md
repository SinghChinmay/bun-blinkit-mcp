<p align="center">
  <img src="assets/logo.png" alt="Blinkit MCP Logo" width="120" height="120" style="border-radius:30px;">
</p>

<h1 align="center">Blinkit MCP</h1>

<p align="center">
  An unofficial <a href="https://modelcontextprotocol.io">Model Context Protocol</a> server that shops on Blinkit through its JSON API — no browser, no automated payments.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/runtime-Bun-black.svg" alt="Bun">
  <img src="https://img.shields.io/badge/transport-stdio%20%7C%20SSE-purple.svg" alt="stdio / SSE">
</p>

---

## What it is

`bun-blinkit-mcp` (display name **Blinkit MCP**) is an unofficial MCP server for
[blinkit.com](https://blinkit.com). It is **API-only**: it talks directly to Blinkit's
consumer-web JSON API over HTTPS.

There is **no Playwright, Chromium, or Firefox** and **no browser automation at
runtime**. Your assistant searches products, builds a cart, and prepares an order;
you complete the payment yourself in the Blinkit app or website.

## How it works

- **Cloudflare bypass without a browser.** Cloudflare blocks ordinary HTTP clients by
  TLS fingerprint, so every request is made with the [`impit`](https://www.npmjs.com/package/impit)
  package configured as `new Impit({ browser: "chrome" })`, which impersonates Chrome's
  TLS handshake. No browser binary is downloaded or launched.
- **Headless login.** Phone + OTP (`send_otp` → `verify_otp`). Blinkit returns
  `success: true` even for a wrong code, so the server treats `verified` /
  presence of an `access_token` as the real success signal.
- **Device bootstrap.** The `auth_key` call uses a fixed `req_key` constant
  (`c0e6868e-1180-400c-be51-f473479f1f0a`); a random UUID returns HTTP 400.
  Override with `BLINKIT_REQ_KEY` if Blinkit rotates it.
- **Local memory.** A SQLite database keeps staples, named combos, the working cart,
  and order history.

## Payments are intentionally NOT automated

The server can prepare and validate an order, but it will never pay for one. These
tools **do not exist** and are deliberately absent:

`proceed_to_pay`, `get_upi_ids`, `select_upi_id`, `pay_now`, and payment-method selection.

`checkout` only creates a server cart and binds a delivery address, then returns a
reminder to pay manually. (`bun run test/tools.ts` fails if any payment tool leaks
into the tool surface.)

## Requirements

- [Bun](https://bun.sh) (the `.mcpb` entrypoint installs it automatically if missing)
- Network access to `blinkit.com`
- A Blinkit account (for login, addresses, and orders)

## Install

### From source

```bash
git clone https://github.com/SinghChinmay/bun-blinkit-mcp.git
cd bun-blinkit-mcp
bun install
bun run main.ts
```

`bun run main.ts` starts the MCP server on stdio. Point your MCP client at it:

```json
{
  "mcpServers": {
    "blinkit": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/bun-blinkit-mcp/main.ts"]
    }
  }
}
```

To launch through the packaged entrypoint instead (the path used by the `.mcpb`
bundle), point at `start.sh`. It installs Bun if needed, runs
`bun install --frozen-lockfile`, keeps setup output on stderr, and then execs the
server:

```json
{
  "mcpServers": {
    "blinkit": {
      "command": "sh",
      "args": ["/absolute/path/to/bun-blinkit-mcp/start.sh"]
    }
  }
}
```

## Usage

The assistant must confirm a **delivery location** before it can search, build a
cart, or check out. A typical flow looks like this:

1. `set_location` (lat/lon) or `find_location` ("home", "Koramangala") — then confirm
   the returned address with the assistant.
2. `search` / `pick_best` / `recommendations` / `home_feed` to find products.
3. `add_to_cart` / `check_cart` / `remove_from_cart` / `clear_cart` to build the basket.
4. When ready: `send_otp` → `verify_otp` (if not logged in), then `get_addresses` →
   `select_address`.
5. `checkout` prepares and validates the order and returns the payable amount.
6. **You** open the Blinkit app or website and pay.

For repeat shopping there are named combos (`save_combo`, `add_combo_to_cart`, e.g.
"pizza night") and staples (`quick_reorder`) stored locally, plus
`get_repeat_suggestions` based on past orders.

Example requests to your assistant:

- "Set my location to home, then add 2 litres of milk and a loaf of brown bread."
- "Find the cheapest full-cream milk and add it to my cart."
- "Order my 'pizza night' combo and prepare checkout with my saved address."

## Commands

| Command | Purpose |
|---------|---------|
| `bun install` | Install dependencies. |
| `bun run main.ts` | Run the MCP server (stdio by default). |
| `bun run test/cli.ts` | Interactive CLI for manually exercising the full flow. |
| `bun run test/tools.ts` | List registered MCP tools; fails if a payment tool leaks. |
| `bun test` | Unit tests for the parsers, scorer, and SQLite store. |
| `bun run typecheck` (`bunx tsc --noEmit`) | Type-check the project. |
| `BLINKIT_HOME=/tmp/blinkit-e2e bun run test/smoke.ts` | Live end-to-end smoke: `set_location` → `search` → `add_to_cart` → reprice. No login, no order. |

## Configuration

Copy `.env.sample` to `.env` (Bun loads `.env` automatically) or export the variables.

| Variable | Default | Purpose |
|----------|---------|---------|
| `SERVE_HTTPS` | `false` | `true` serves SSE on `0.0.0.0:8000` instead of stdio. |
| `PORT` | `8000` | Port for the SSE transport. |
| `BLINKIT_HOME` | `~/.blinkit-mcp` | Directory for session + SQLite state. |
| `BLINKIT_DB` | `$BLINKIT_HOME/memory.sqlite` | SQLite database path (e.g. `:memory:` for tests). |
| `BLINKIT_REQ_KEY` | fixed constant | Override only if Blinkit rotates the `auth_key` `req_key`. |

### Transport

- **stdio** (default): the server speaks JSON-RPC on stdout. Because stdout is the
  protocol channel, all setup logging goes to stderr.
- **SSE**: set `SERVE_HTTPS=true` to serve on `0.0.0.0:8000` with endpoints
  `/sse` (event stream) and `/messages` (client → server POSTs).

## Tools

### Auth

| Tool | Description |
|------|-------------|
| `check_login` | Show login status and the confirmed delivery location. |
| `send_otp` | Send a login OTP to a phone number. |
| `verify_otp` | Verify the OTP and persist the access token. |
| `logout` | Clear the stored access token. |

### Location

| Tool | Description |
|------|-------------|
| `get_location` | Show the currently confirmed delivery location. |
| `find_location` | Resolve a free-text address and save it as the location. |
| `set_location` | Set the delivery location from coordinates. |
| `check_serviceability` | Check if Blinkit delivers to a lat/lon. |

### Catalog

| Tool | Description |
|------|-------------|
| `search` | Search products at the confirmed location. |
| `autosuggest` | Typeahead search suggestions. |
| `home_feed` | Products on the home feed for the location. |
| `recommendations` | Products frequently bought with a product id. |
| `pick_best` | Search and auto-pick the best product with the multi-factor scorer. |

### Cart

| Tool | Description |
|------|-------------|
| `add_to_cart` | Add products to the working cart and reprice. |
| `remove_from_cart` | Remove a product from the working cart. |
| `check_cart` | Show the working cart repriced. |
| `clear_cart` | Empty the working cart. |

### Combos & staples

| Tool | Description |
|------|-------------|
| `save_combo` | Save a named custom combination of products. |
| `list_combos` | List saved custom combinations. |
| `add_combo_to_cart` | Replay a saved combo into the working cart. |
| `delete_combo` | Delete a saved combo. |
| `quick_reorder` | Rebuild a basket from saved staples. |
| `list_staples` | List the saved reorder catalog. |
| `set_staple` | Add or update a staple. |
| `delete_staple` | Remove a staple. |
| `get_repeat_suggestions` | Products bought in multiple past orders. |

### Addresses & checkout

| Tool | Description |
|------|-------------|
| `get_addresses` | List saved delivery addresses (requires login). |
| `select_address` | Choose a saved delivery address for checkout. |
| `checkout` | Prepare and validate an order (never pays). |

### Orders

| Tool | Description |
|------|-------------|
| `get_order_history` | Fetch and persist recent orders. |
| `get_order_count` | Lifetime order counts. |

## Local data

Everything the server remembers lives under `~/.blinkit-mcp` (override with
`BLINKIT_HOME`):

- `session.json` — device id, `auth_key`, `access_token`, and the confirmed
  location. Written with `chmod 600`; treat it as a secret.
- `memory.sqlite` — staples, named combos, the stateful working cart, and persisted
  order history. Blinkit's `/v5/carts` endpoint is stateless, so the local cart is the
  source of truth and is repriced against Blinkit on every change.

Delete these files to reset local state.

## Development

- TypeScript + Bun, ESM, strict mode.
- HTTP happens only in `src/client.ts`, via `impit` with a Chrome TLS fingerprint.
- `src/parse.ts` extracts products and orders defensively from Blinkit's hashed,
  deeply nested server-driven-UI responses; `bun test` covers it along with the
  scorer (`src/staples.ts`) and the SQLite store (using `BLINKIT_DB=:memory:`).
- `test/smoke.ts` hits the live API and needs network access.

## Attribution & notes

- Endpoint research was informed by the MIT-licensed
  [`yniks/blinkit-mcp`](https://github.com/yniks/blinkit-mcp) project.
- This is an unofficial, reverse-engineered client with **no stability
  guarantees**. Blinkit changes its API and hashed response shapes without notice;
  header and version constants may need bumping.
- Repository: [`SinghChinmay/bun-blinkit-mcp`](https://github.com/SinghChinmay/bun-blinkit-mcp).
- Licensed under the [MIT License](LICENSE).

## Disclaimer

This project is an **experimental** proof of concept and is **not affiliated,
associated, authorized, endorsed by, or in any way officially connected with
Blinkit (Grofers India Private Limited)** or any of its subsidiaries or affiliates.
The official Blinkit website is [blinkit.com](https://blinkit.com). Use at your own
risk.
