import { describe, expect, test } from "bun:test";

// Point the SQLite store at an in-memory DB before importing it.
process.env.BLINKIT_DB = ":memory:";
const store = await import("../src/store");

describe("staples", () => {
  test("upsert, list and delete", () => {
    store.upsertStaple({ key: "milk", query: "milk", attrs: ["full cream"], quantity: 2, auto: true });
    store.upsertStaple({ key: "milk", query: "amul milk", quantity: 1, auto: true });
    const milk = store.listStaples().find((s) => s.key === "milk");
    expect(milk?.query).toBe("amul milk");
    expect(milk?.quantity).toBe(1);
    store.deleteStaple("milk");
    expect(store.listStaples().find((s) => s.key === "milk")).toBeUndefined();
  });
});

describe("combos", () => {
  test("save, list, get and delete", () => {
    store.saveCombo(
      "pizza night",
      [
        { product_id: 1, merchant_id: 9, product_name: "Pizza Base", quantity: 2 },
        { product_id: 2, merchant_id: 9, product_name: "Cheese", quantity: 1 },
      ],
      "friday",
    );
    const combo = store.getCombo("pizza night");
    expect(combo?.items).toHaveLength(2);
    expect(combo?.items.find((i) => i.product_id === 1)?.quantity).toBe(2);
    expect(store.listCombos()).toHaveLength(1);
    expect(store.deleteCombo("pizza night")).toBe(true);
    expect(store.getCombo("pizza night")).toBeUndefined();
  });

  test("merges duplicate product_ids instead of failing", () => {
    store.saveCombo("dup", [
      { product_id: 7, merchant_id: 1, product_name: "X", quantity: 1 },
      { product_id: 7, merchant_id: 1, product_name: "X", quantity: 2 },
    ]);
    const combo = store.getCombo("dup");
    expect(combo?.items).toHaveLength(1);
    expect(combo?.items[0].quantity).toBe(3);
    store.deleteCombo("dup");
  });
});

describe("cart items", () => {
  test("add accumulates quantity, remove and clear", () => {
    store.clearCartItems();
    store.addCartItems([{ product_id: 10, merchant_id: 1, quantity: 1, product_name: "A" }]);
    const lines = store.addCartItems([{ product_id: 10, merchant_id: 1, quantity: 2, product_name: "A" }]);
    expect(lines).toHaveLength(1);
    expect(lines[0].quantity).toBe(3);
    expect(store.removeCartItem(10)).toHaveLength(0);
    store.clearCartItems();
  });
});

describe("order history / repeat suggestions", () => {
  test("detects products bought in multiple orders", () => {
    store.recordOrders([
      { order_id: "o1", placed_at: "2026-01-01", product_names: ["Milk"], product_ids: [5, 6] },
      { order_id: "o2", placed_at: "2026-02-01", product_names: ["Milk", "Bread"], product_ids: [5] },
    ]);
    const orders = store.listOrders(10);
    expect(orders.map((o) => o.order_id)).toEqual(["o2", "o1"]);
    const repeats = store.getRepeatSuggestions(10);
    expect(repeats.map((r) => r.product_id)).toContain(5);
    expect(repeats.find((r) => r.product_id === 5)?.order_count).toBe(2);
  });
});
