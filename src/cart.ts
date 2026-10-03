import { computeCart, type CartView } from "./api";
import { toCartItem, type CartItem } from "./parse";
import {
  addCartItems,
  clearCartItems,
  getCartItems,
  removeCartItem,
} from "./store";

/**
 * The stateful working cart. Blinkit's /v5/carts is a stateless pricing endpoint,
 * so line items live in local SQLite and are repriced on every change.
 */

export interface CartResult extends CartView {
  lines: CartItem[];
}

async function reprice(lines: CartItem[]): Promise<CartResult> {
  if (!lines.length) {
    return {
      item_count: 0,
      requires_login: false,
      validations: [],
      lines: [],
    };
  }
  const view = await computeCart(lines);
  return { ...view, lines };
}

/** Add products (Product objects or raw cart_items) and reprice. */
export async function addItems(rawItems: any[]): Promise<CartResult> {
  const normalized: CartItem[] = rawItems.map((raw) =>
    toCartItem(raw.cart_item ?? raw, raw.quantity ?? raw.cart_item?.quantity ?? 1),
  );
  const lines = addCartItems(normalized);
  return reprice(lines);
}

export async function removeItem(productId: number): Promise<CartResult> {
  const lines = removeCartItem(productId);
  return reprice(lines);
}

export async function clearCart(): Promise<void> {
  clearCartItems();
}

export async function viewCart(): Promise<CartResult> {
  return reprice(getCartItems());
}
