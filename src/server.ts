#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

import { BlinkitError, requireLogin, requireLocation } from "./client";
import { loadSession, type Session } from "./session";
import {
  autosuggest,
  checkServiceability,
  findAndSetLocation,
  getAddresses,
  getHomeFeed,
  getRecommendations,
  logout,
  orderCount,
  orderHistory,
  prepareOrder,
  searchAddress,
  searchProducts,
  selectAddress,
  sendOtp,
  setLocation,
  verifyOtp,
} from "./api";
import { addItems, clearCart, removeItem, viewCart } from "./cart";
import { DEFAULT_STAPLES, DEFAULT_WEIGHTS, pickBest, resolveStaple } from "./staples";
import {
  listCombos,
  listStaples,
  saveCombo,
  upsertStaple,
  deleteStaple,
  deleteCombo,
  getCombo,
  getCartItems,
  getRepeatSuggestions,
  type ComboItem,
} from "./store";

export function buildServer(): McpServer {
  const server = new McpServer({ name: "bun-blinkit-mcp", version: "2.0.0" });

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Every tool goes through here so errors become clean MCP results. */
function register(
  name: string,
  description: string,
  schema: z.ZodRawShape,
  handler: (args: any, session: Session) => unknown | Promise<unknown>,
  opts: { guard?: boolean; login?: boolean } = {},
): void {
  const cb = async (args: any): Promise<ToolResult> => {
    try {
      const session = await loadSession();
      // Central location guard: no catalog/cart/checkout/order action without a
      // confirmed delivery location.
      if (opts.guard) requireLocation(session);
      if (opts.login) requireLogin(session);
      const result = await handler(args, session);
      const text =
        typeof result === "string"
          ? result
          : result === undefined
            ? "ok"
            : JSON.stringify(result, null, 2);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      const msg =
        err instanceof BlinkitError
          ? `${err.message}${err.body ? ` :: ${JSON.stringify(err.body)}` : ""}`
          : err instanceof Error
            ? err.message
            : String(err);
      return { isError: true, content: [{ type: "text", text: `Error: ${msg}` }] };
    }
  };
  (server.registerTool as any)(name, { description, inputSchema: schema }, cb);
}

/* --------------------------------- Auth --------------------------------- */

register(
  "check_login",
  "Show whether the user is logged in and which delivery location is currently confirmed.",
  {},
  async (_a, s) => ({
    logged_in: Boolean(s.access_token),
    user_id: s.user_id,
    phone: s.phone,
    location: s.location ?? null,
  }),
);

register(
  "send_otp",
  "Step 1 of login: send an OTP to a phone number. No browser involved.",
  { phone: z.string().describe("10-digit Indian mobile number, e.g. 9876543210") },
  ({ phone }) => sendOtp(phone),
);

register(
  "verify_otp",
  "Step 2 of login: verify the OTP and persist the access token. A wrong code returns ok:false even when Blinkit reports success.",
  { phone: z.string(), code: z.string().describe("OTP received via SMS") },
  ({ phone, code }) => verifyOtp(phone, code),
);

register("logout", "Clear the stored access token.", {}, () => logout());

/* ------------------------------- Location ------------------------------- */

register(
  "get_location",
  "Show the currently confirmed delivery location. Confirm this address with the user before searching or ordering.",
  {},
  async (_a, s) => s.location ?? { error: "No location set. Call set_location or find_location." },
);

register(
  "find_location",
  "Resolve a free-text address ('home', 'Koramangala', 'New Delhi Railway Station') to coordinates, confirm serviceability, and save it as the delivery location. Use this when the user names a place rather than coordinates.",
  { query: z.string(), set: z.boolean().default(true).describe("also save the top match as the location") },
  async ({ query, set }) => {
    const suggestions = await searchAddress(query);
    if (!set || !suggestions.length) return { suggestions };
    const result = await findAndSetLocation(query);
    return { result, suggestions };
  },
);

register(
  "set_location",
  "Set the delivery location from coordinates (lat/lon). Resolves serviceability, picks the serving dark store, and saves it. Must be done (and confirmed with the user) before any search/cart/checkout.",
  { lat: z.number(), lon: z.number() },
  ({ lat, lon }) => setLocation(lat, lon),
);

register(
  "check_serviceability",
  "Check whether Blinkit delivers to a lat/lon without changing the saved location.",
  { lat: z.number(), lon: z.number() },
  async ({ lat, lon }) => {
    const res = await checkServiceability(lat, lon);
    return { serviceable: Boolean(res?.serviceable), city: res?.cityName };
  },
);

/* ------------------------------- Catalog ------------------------------- */

register(
  "search",
  "Search products at the confirmed location. Returns products (id, name, brand, unit, price, mrp, inventory, eta) including the cart_item needed to add to cart.",
  { query: z.string(), page: z.number().int().min(0).default(0) },
  ({ query, page }) => searchProducts(query, page),
  { guard: true },
);

register(
  "autosuggest",
  "Typeahead search suggestions for a partial product query.",
  { query: z.string() },
  ({ query }) => autosuggest(query),
  { guard: true },
);

register(
  "home_feed",
  "Products surfaced on the home feed for the confirmed location.",
  {},
  () => getHomeFeed(),
  { guard: true },
);

register(
  "recommendations",
  "Products frequently bought with a given product id ('people also bought').",
  { product_id: z.coerce.number().int() },
  ({ product_id }) => getRecommendations(product_id),
  { guard: true },
);

register(
  "pick_best",
  "Search then auto-pick the best product using a multi-factor scorer (brand + attributes + availability + price) with cheaper-equivalent swap. Returns the chosen product, alternatives, and the reason.",
  {
    query: z.string(),
    brands: z.array(z.string()).optional().describe("preferred brands, best first"),
    attrs: z.array(z.string()).optional().describe("required attributes, e.g. ['full cream']"),
    max_price: z.number().optional(),
  },
  async ({ query, brands, attrs, max_price }) => {
    const results = await searchProducts(query);
    return pickBest(
      results,
      { brands, attrs, maxPrice: max_price },
      DEFAULT_WEIGHTS,
    );
  },
  { guard: true },
);

/* --------------------------------- Cart --------------------------------- */

const productShape = z
  .object({
    product_id: z.coerce.number().int(),
    merchant_id: z.coerce.number().int(),
    quantity: z.coerce.number().int().min(1).optional(),
    name: z.string().optional(),
    display_name: z.string().optional(),
    product_name: z.string().optional(),
    price: z.coerce.number().optional(),
    mrp: z.coerce.number().optional(),
    unit: z.string().optional(),
    inventory: z.coerce.number().optional(),
    group_id: z.coerce.number().optional(),
    merchant_type: z.string().optional(),
    eta_identifier: z.string().optional(),
    brand: z.string().optional(),
    cart_item: z.any().optional(),
  })
  .passthrough();

register(
  "add_to_cart",
  "Add one or more products to the working cart and reprice. Pass the product objects (or their cart_item) returned by search/pick_best.",
  { items: z.array(productShape).describe("products or cart_item objects from search/pick_best") },
  ({ items }) => addItems(items),
  { guard: true },
);

register(
  "remove_from_cart",
  "Remove a product from the working cart by id and reprice.",
  { product_id: z.coerce.number().int() },
  ({ product_id }) => removeItem(product_id),
  { guard: true },
);

register(
  "check_cart",
  "Show the working cart repriced (items, payable amount, delivery charge, free-delivery threshold, validations).",
  {},
  () => viewCart(),
  { guard: true },
);

register("clear_cart", "Empty the working cart.", {}, async () => {
  await clearCart();
  return { ok: true };
}, { guard: true });

/* --------------------------- Combos (SQLite) --------------------------- */

register(
  "save_combo",
  "Save a named custom combination of products (e.g. 'pizza night'). Either pass items, or set from_cart=true to snapshot the current working cart.",
  {
    name: z.string().describe("combo name, e.g. 'pizza night'"),
    items: z.array(productShape).optional(),
    from_cart: z.boolean().default(false),
    notes: z.string().optional(),
  },
  ({ name, items, from_cart, notes }) => {
    const source: ComboItem[] = from_cart
      ? (getCartItems() as unknown as ComboItem[])
      : (items ?? []).map((i: any) => ({ ...i, quantity: i.quantity ?? 1 }));
    if (!source.length) throw new BlinkitError("No items to save into the combo.", 400);
    return saveCombo(name, source, notes);
  },
  { guard: true },
);

register(
  "list_combos",
  "List saved custom combinations and their items.",
  {},
  () => listCombos(),
);

register(
  "add_combo_to_cart",
  "Replay a saved combo into the working cart and reprice.",
  { name: z.string() },
  async ({ name }) => {
    const combo = getCombo(name);
    if (!combo) throw new BlinkitError(`No combo named '${name}'.`, 404);
    return addItems(combo.items);
  },
  { guard: true },
);

register(
  "delete_combo",
  "Delete a saved combo by name.",
  { name: z.string() },
  ({ name }) => ({ deleted: deleteCombo(name) }),
);

/* ------------------------------- Staples ------------------------------- */

register(
  "quick_reorder",
  "Rebuild a basket from saved staples. With no keys, adds all auto-eligible staples; otherwise resolves the given staple keys. Returns what was chosen for each item plus the repriced cart.",
  { keys: z.array(z.string()).optional().describe("staple keys; omit for all auto staples") },
  async ({ keys }) => {
    const staples = listStaples();
    const targets = keys?.length
      ? staples.filter((s) => keys.includes(s.key))
      : staples.filter((s) => s.auto);
    const picks: any[] = [];
    const toAdd: any[] = [];
    for (const st of targets) {
      const product = await resolveStaple(st);
      if (product?.cart_item) {
        toAdd.push({ ...product.cart_item, quantity: st.quantity ?? 1 });
        picks.push({ key: st.key, chosen: product.name, price: product.price, qty: st.quantity ?? 1 });
      } else {
        picks.push({ key: st.key, chosen: null, note: "no available product found" });
      }
    }
    const cart = toAdd.length ? await addItems(toAdd) : await viewCart();
    return { picks, cart };
  },
  { guard: true },
);

register(
  "list_staples",
  "List the saved reorder catalog (staples) and their pick rules.",
  {},
  () => {
    const staples = listStaples();
    return { staples: staples.length ? staples : DEFAULT_STAPLES };
  },
);

register(
  "set_staple",
  "Add or update a staple in the reorder catalog.",
  {
    key: z.string(),
    query: z.string(),
    brands: z.array(z.string()).optional(),
    attrs: z.array(z.string()).optional(),
    unit: z.string().optional(),
    quantity: z.number().int().min(1).default(1),
    auto: z.boolean().default(false),
    product_id: z.number().int().optional(),
  },
  (args) => {
    upsertStaple(args);
    return { ok: true, staples: listStaples() };
  },
);

register(
  "delete_staple",
  "Remove a staple from the reorder catalog by key.",
  { key: z.string() },
  ({ key }) => ({ deleted: deleteStaple(key) }),
);

register(
  "get_repeat_suggestions",
  "Products bought in more than one past order (from local order history), as reorder candidates. Run get_order_history first to populate.",
  { limit: z.number().int().min(1).max(50).default(10) },
  ({ limit }) => getRepeatSuggestions(limit),
  { guard: true },
);

/* -------------------------- Addresses / checkout -------------------------- */

register(
  "get_addresses",
  "List saved delivery addresses (id, label, location). Requires login.",
  {},
  () => getAddresses(),
  { guard: true, login: true },
);

register(
  "select_address",
  "Choose a saved delivery address by id for checkout. Only valid before checkout.",
  { address_id: z.coerce.number().int() },
  ({ address_id }) => selectAddress(address_id),
  { guard: true, login: true },
);

register(
  "checkout",
  "Prepare (but do NOT pay for) an order: create a server cart from the working cart, bind the selected address, and validate it. Returns the payable amount and a reminder to pay manually in the Blinkit app. Payment is never automated.",
  { address_id: z.coerce.number().int().optional().describe("defaults to the previously selected address") },
  async ({ address_id }, s) => {
    const id = address_id ?? s.address_id;
    if (!id) throw new BlinkitError("No address selected. Call get_addresses then select_address.", 400);
    return prepareOrder(getCartItems(), id);
  },
  { guard: true, login: true },
);

/* --------------------------------- Orders --------------------------------- */

register(
  "get_order_history",
  "Fetch recent orders (totals, status, item names, reorder product ids), persist them locally, and return them. Requires login.",
  {},
  () => orderHistory(),
  { guard: true, login: true },
);

register(
  "get_order_count",
  "Lifetime order counts (delivered/live/cancelled). Requires login.",
  {},
  () => orderCount(),
  { guard: true, login: true },
);

  return server;
}

/* --------------------------------- Boot --------------------------------- */

export function createServer(): McpServer {
  return buildServer();
}

async function serveStdio(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("bun-blinkit-mcp running on stdio");
}

async function serveSse(): Promise<void> {
  const { createServer: createHttpServer } = await import("node:http");
  const transports = new Map<string, SSEServerTransport>();
  const httpServer = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/sse") {
      // A fresh server instance per connection: an McpServer can only be
      // connected to a single transport.
      const transport = new SSEServerTransport("/messages", res);
      const server = buildServer();
      transports.set(transport.sessionId, transport);
      res.on("close", () => transports.delete(transport.sessionId));
      server.connect(transport).catch((err) => {
        console.error("SSE connect failed:", err);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/messages") {
      const transport = transports.get(url.searchParams.get("sessionId") ?? "");
      if (transport) {
        transport.handlePostMessage(req, res).catch((err) => {
          console.error("SSE message failed:", err);
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      } else {
        res.writeHead(404).end("Unknown session");
      }
      return;
    }
    res.writeHead(404).end("Not found");
  });
  const port = Number(process.env.PORT ?? 8000);
  httpServer.listen(port, "0.0.0.0", () =>
    console.error(`bun-blinkit-mcp SSE on http://0.0.0.0:${port}/sse`),
  );
}

/** Start the server using SSE when SERVE_HTTPS=true, otherwise stdio. */
export async function startServer(): Promise<void> {
  const serveSseFlag = (process.env.SERVE_HTTPS ?? "").toLowerCase() === "true";
  if (serveSseFlag) {
    await serveSse();
  } else {
    await serveStdio();
  }
}
