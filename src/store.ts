import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import type { CartItem } from "./parse";

/**
 * Local SQLite memory for the MCP (bun:sqlite, no server).
 *
 * Stores the user's reorder catalog (staples), named custom combinations
 * ("combos", e.g. a "pizza night" basket), the stateful working cart, and a
 * local copy of past orders so we can surface repeat purchases. Blinkit's own
 * /v5/carts is stateless, so the cart here is the source of truth.
 */

export interface Staple {
  key: string;
  query: string;
  brands?: string[];
  attrs?: string[];
  unit?: string;
  quantity: number;
  auto: boolean;
  product_id?: number;
}

export interface ComboItem {
  product_id: number;
  merchant_id: number;
  product_name?: string;
  display_name?: string;
  unit?: string;
  brand?: string;
  quantity: number;
  price?: number;
  mrp?: number;
  [k: string]: unknown;
}

export interface Combo {
  id: number;
  name: string;
  notes?: string;
  created_at: string;
  items: ComboItem[];
}

export interface OrderRecord {
  order_id?: string;
  cart_id?: string;
  total?: number;
  status?: string;
  placed_at?: string;
  product_names: string[];
  product_ids: number[];
}

export interface RepeatSuggestion {
  product_id: number;
  name?: string;
  order_count: number;
  last_ordered?: string;
}

const DIR = process.env.BLINKIT_HOME ?? join(homedir(), ".blinkit-mcp");
/** Override with BLINKIT_DB (e.g. ":memory:" or a temp file) for tests. */
const DB_FILE = process.env.BLINKIT_DB ?? join(DIR, "memory.sqlite");

let db: Database | null = null;

/** Lazily open + migrate the database. */
export function getDb(): Database {
  if (db) return db;
  if (DB_FILE !== ":memory:") mkdirSync(dirname(DB_FILE), { recursive: true, mode: 0o700 });
  const d = new Database(DB_FILE, { create: true });
  d.exec("PRAGMA journal_mode = WAL;");
  d.exec("PRAGMA foreign_keys = ON;");
  d.exec(`
    CREATE TABLE IF NOT EXISTS staples (
      key        TEXT PRIMARY KEY,
      query      TEXT NOT NULL,
      brands     TEXT,
      attrs      TEXT,
      unit       TEXT,
      quantity   INTEGER NOT NULL DEFAULT 1,
      auto       INTEGER NOT NULL DEFAULT 0,
      product_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS combos (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      notes      TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS combo_items (
      combo_id     INTEGER NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
      product_id   INTEGER NOT NULL,
      merchant_id  INTEGER,
      product_name TEXT,
      display_name TEXT,
      unit         TEXT,
      brand        TEXT,
      quantity     INTEGER NOT NULL DEFAULT 1,
      price        REAL,
      mrp          REAL,
      data         TEXT,
      PRIMARY KEY (combo_id, product_id)
    );
    CREATE TABLE IF NOT EXISTS cart_items (
      product_id INTEGER PRIMARY KEY,
      quantity   INTEGER NOT NULL DEFAULT 1,
      data       TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      order_id   TEXT PRIMARY KEY,
      cart_id    TEXT,
      total      REAL,
      status     TEXT,
      placed_at  TEXT,
      fetched_at TEXT
    );
    CREATE TABLE IF NOT EXISTS order_items (
      order_id   TEXT NOT NULL,
      product_id INTEGER NOT NULL,
      name       TEXT,
      PRIMARY KEY (order_id, product_id)
    );
  `);
  db = d;
  return d;
}

/* ------------------------------ Staples ------------------------------ */

function rowToStaple(r: any): Staple {
  return {
    key: r.key,
    query: r.query,
    brands: r.brands ? JSON.parse(r.brands) : undefined,
    attrs: r.attrs ? JSON.parse(r.attrs) : undefined,
    unit: r.unit ?? undefined,
    quantity: r.quantity,
    auto: Boolean(r.auto),
    product_id: r.product_id ?? undefined,
  };
}

export function listStaples(): Staple[] {
  return getDb().query("SELECT * FROM staples ORDER BY key").all().map(rowToStaple);
}

export function upsertStaple(s: Staple): void {
  getDb()
    .query(
      `INSERT INTO staples (key, query, brands, attrs, unit, quantity, auto, product_id)
       VALUES ($key, $query, $brands, $attrs, $unit, $quantity, $auto, $product_id)
       ON CONFLICT(key) DO UPDATE SET
         query=excluded.query, brands=excluded.brands, attrs=excluded.attrs,
         unit=excluded.unit, quantity=excluded.quantity, auto=excluded.auto,
         product_id=excluded.product_id`,
    )
    .run({
      $key: s.key,
      $query: s.query,
      $brands: s.brands ? JSON.stringify(s.brands) : null,
      $attrs: s.attrs ? JSON.stringify(s.attrs) : null,
      $unit: s.unit ?? null,
      $quantity: s.quantity ?? 1,
      $auto: s.auto ? 1 : 0,
      $product_id: s.product_id ?? null,
    });
}

export function deleteStaple(key: string): boolean {
  return getDb().query("DELETE FROM staples WHERE key = ?").run(key).changes > 0;
}

/* ------------------------------- Combos ------------------------------- */

function comboItems(comboId: number): ComboItem[] {
  return getDb()
    .query("SELECT * FROM combo_items WHERE combo_id = ? ORDER BY product_id")
    .all(comboId)
    .map((r: any) => ({
      product_id: r.product_id,
      merchant_id: r.merchant_id,
      product_name: r.product_name ?? undefined,
      display_name: r.display_name ?? undefined,
      unit: r.unit ?? undefined,
      brand: r.brand ?? undefined,
      quantity: r.quantity,
      price: r.price ?? undefined,
      mrp: r.mrp ?? undefined,
    }));
}

export function saveCombo(name: string, items: ComboItem[], notes?: string): Combo {
  const d = getDb();
  const tx = d.transaction(() => {
    d.query(
      `INSERT INTO combos (name, notes, created_at) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET notes=excluded.notes`,
    ).run(name, notes ?? null, new Date().toISOString());
      const row = d.query("SELECT id FROM combos WHERE name = ?").get(name) as { id: number };
      d.query("DELETE FROM combo_items WHERE combo_id = ?").run(row.id);
      // Merge duplicate product_ids so the (combo_id, product_id) PK can't fail.
      const merged = new Map<number, ComboItem>();
      for (const it of items) {
        const prev = merged.get(it.product_id);
        if (prev) prev.quantity = (prev.quantity ?? 1) + (it.quantity ?? 1);
        else merged.set(it.product_id, { ...it, quantity: it.quantity ?? 1 });
      }
      const ins = d.query(
        `INSERT INTO combo_items
           (combo_id, product_id, merchant_id, product_name, display_name, unit, brand, quantity, price, mrp, data)
         VALUES ($c, $p, $m, $pn, $dn, $u, $b, $q, $pr, $mrp, $data)`,
      );
      for (const it of merged.values()) {
      ins.run({
        $c: row.id,
        $p: it.product_id,
        $m: it.merchant_id ?? null,
        $pn: it.product_name ?? null,
        $dn: it.display_name ?? null,
        $u: it.unit ?? null,
        $b: it.brand ?? null,
        $q: it.quantity ?? 1,
        $pr: it.price ?? null,
        $mrp: it.mrp ?? null,
        $data: JSON.stringify(it),
      });
    }
    return row.id;
  });
  const id = tx();
  return { id, name, notes, created_at: new Date().toISOString(), items: comboItems(id) };
}

export function listCombos(): Combo[] {
  return getDb()
    .query("SELECT * FROM combos ORDER BY name")
    .all()
    .map((r: any) => ({
      id: r.id,
      name: r.name,
      notes: r.notes ?? undefined,
      created_at: r.created_at,
      items: comboItems(r.id),
    }));
}

export function getCombo(name: string): Combo | undefined {
  const r = getDb().query("SELECT * FROM combos WHERE name = ?").get(name) as any;
  if (!r) return undefined;
  return {
    id: r.id,
    name: r.name,
    notes: r.notes ?? undefined,
    created_at: r.created_at,
    items: comboItems(r.id),
  };
}

export function deleteCombo(name: string): boolean {
  const res = getDb().query("DELETE FROM combos WHERE name = ?").run(name);
  return res.changes > 0;
}

/* ------------------------------ Cart items ------------------------------ */

export function getCartItems(): CartItem[] {
  return getDb()
    .query("SELECT * FROM cart_items ORDER BY product_id")
    .all()
    .map((r: any) => ({ ...JSON.parse(r.data), quantity: r.quantity }) as CartItem);
}

export function addCartItems(items: CartItem[]): CartItem[] {
  const d = getDb();
  const tx = d.transaction(() => {
    for (const it of items) {
      const existing = d
        .query("SELECT quantity, data FROM cart_items WHERE product_id = ?")
        .get(it.product_id) as { quantity: number; data: string } | null;
      if (existing) {
        d.query("UPDATE cart_items SET quantity = ? WHERE product_id = ?").run(
          existing.quantity + (it.quantity ?? 1),
          it.product_id,
        );
      } else {
        d.query(
          "INSERT INTO cart_items (product_id, quantity, data) VALUES (?, ?, ?)",
        ).run(it.product_id, it.quantity ?? 1, JSON.stringify(it));
      }
    }
  });
  tx();
  return getCartItems();
}

export function removeCartItem(productId: number): CartItem[] {
  getDb().query("DELETE FROM cart_items WHERE product_id = ?").run(productId);
  return getCartItems();
}

export function clearCartItems(): void {
  getDb().query("DELETE FROM cart_items").run();
}

/* ------------------------------- Orders ------------------------------- */

export function recordOrders(records: OrderRecord[]): void {
  const d = getDb();
  const now = new Date().toISOString();
  const tx = d.transaction(() => {
    for (const o of records) {
      if (!o.order_id) continue;
      d.query(
        `INSERT INTO orders (order_id, cart_id, total, status, placed_at, fetched_at)
         VALUES ($id, $cart, $total, $status, $placed, $now)
         ON CONFLICT(order_id) DO UPDATE SET
           total=excluded.total, status=excluded.status,
           placed_at=excluded.placed_at, fetched_at=excluded.fetched_at`,
      ).run({
        $id: o.order_id,
        $cart: o.cart_id ?? null,
        $total: o.total ?? null,
        $status: o.status ?? null,
        $placed: o.placed_at ?? null,
        $now: now,
      });
      const aligned = o.product_names.length === o.product_ids.length;
      for (let i = 0; i < o.product_ids.length; i++) {
        d.query(
          `INSERT OR IGNORE INTO order_items (order_id, product_id, name) VALUES (?, ?, ?)`,
        ).run(o.order_id, o.product_ids[i], aligned ? o.product_names[i] : null);
      }
    }
  });
  tx();
}

export interface StoredOrder {
  order_id: string;
  cart_id?: string;
  total?: number;
  status?: string;
  placed_at?: string;
  fetched_at?: string;
  items: { product_id: number; name?: string }[];
}

export function listOrders(limit = 20): StoredOrder[] {
  const d = getDb();
  const rows = d
    .query("SELECT * FROM orders ORDER BY COALESCE(placed_at, fetched_at) DESC LIMIT ?")
    .all(limit) as any[];
  return rows.map((r) => ({
    order_id: r.order_id,
    cart_id: r.cart_id ?? undefined,
    total: r.total ?? undefined,
    status: r.status ?? undefined,
    placed_at: r.placed_at ?? undefined,
    fetched_at: r.fetched_at ?? undefined,
    items: (
      d.query("SELECT product_id, name FROM order_items WHERE order_id = ?").all(r.order_id) as any[]
    ).map((x) => ({ product_id: x.product_id, name: x.name ?? undefined })),
  }));
}

/** Products the user has bought in more than one order — candidates for reorder. */
export function getRepeatSuggestions(limit = 10): RepeatSuggestion[] {
  return getDb()
    .query(
      `SELECT oi.product_id AS product_id,
              oi.name AS name,
              COUNT(DISTINCT oi.order_id) AS order_count,
              MAX(o.placed_at) AS last_ordered
       FROM order_items oi
       JOIN orders o ON o.order_id = oi.order_id
       GROUP BY oi.product_id
       HAVING order_count > 1
       ORDER BY order_count DESC, last_ordered DESC
       LIMIT ?`,
    )
    .all(limit) as RepeatSuggestion[];
}
