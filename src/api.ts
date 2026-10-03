import { BlinkitError, ensureAuthKey, request, requireLogin } from "./client";
import { loadSession, updateSession } from "./session";
import {
  extractOrders,
  extractProducts,
  toCartItem,
  type CartItem,
  type OrderSummary,
  type Product,
} from "./parse";
import { recordOrders } from "./store";

/* ------------------------------- Auth/login ------------------------------- */

export async function sendOtp(phone: string) {
  await ensureAuthKey();
  return request<{
    success: boolean;
    sms_sent: boolean;
    message: string;
    message_id?: string;
  }>("/v2/accounts/", { method: "POST", form: { user_phone: phone }, authed: false });
}

export interface VerifyResult {
  ok: boolean;
  message: string;
  user_id?: number;
}

/**
 * Verify OTP. Blinkit returns `success:true` even for a WRONG code — the real
 * signal is `verified` / presence of `access_token`, so branch on that only.
 */
export async function verifyOtp(phone: string, code: string): Promise<VerifyResult> {
  await ensureAuthKey();
  const res = await request<any>("/v2/accounts/verify/phone/code/", {
    method: "POST",
    form: { user_phone: phone, verify_code: code },
    authed: false,
  });
  if (res?.verified && res?.access_token) {
    await updateSession({
      access_token: res.access_token,
      user_id: res?.user?.id,
      phone: res?.user?.phone ?? phone,
    });
    return { ok: true, message: res.message ?? "Login successful", user_id: res?.user?.id };
  }
  return { ok: false, message: res?.message ?? "Verification failed" };
}

export async function logout() {
  await updateSession({ access_token: undefined, user_id: undefined });
}

/* ------------------------------- Location ------------------------------- */

export interface AddressSuggestion {
  place_id: string;
  title: string;
  subtitle?: string;
  session_token?: string;
}

export async function checkServiceability(lat: number, lon: number) {
  await ensureAuthKey();
  return request<any>("/visibility", { query: { latitude: lat, longitude: lon }, authed: false });
}

export async function locationInfo(lat: number, lon: number) {
  await ensureAuthKey();
  return request<any>("/location/info", {
    query: { lat, lon, is_pin_moved: false },
    authed: false,
  });
}

/** Typeahead for delivery addresses. Returns place candidates (no coordinates). */
export async function searchAddress(
  query: string,
  near?: { lat: number; lon: number },
): Promise<AddressSuggestion[]> {
  await ensureAuthKey();
  const res = await request<any>("/location/autoSuggest", {
    query: {
      query,
      lat: near?.lat,
      lng: near?.lon,
      session_token: "",
    },
    authed: false,
  });
  const suggestions: any[] = res?.ui_data?.suggestions ?? [];
  return suggestions.map((s) => ({
    place_id: s?.meta?.place_id,
    title: s?.title?.text,
    subtitle: s?.subtitle?.text,
    session_token: s?.meta?.session_token,
  })).filter((s) => s.place_id && s.title);
}

/** Resolve a place_id from searchAddress into coordinates + a formatted address. */
export async function resolvePlace(s: AddressSuggestion) {
  await ensureAuthKey();
  return request<any>("/location/info", {
    query: {
      place_id: s.place_id,
      title: s.title,
      description: s.subtitle,
      is_pin_moved: false,
      session_token: s.session_token ?? "",
    },
    authed: false,
  });
}

export interface LocationResult {
  serviceable: boolean;
  address: any;
  city?: string;
  lat: number;
  lon: number;
  merchant_id: number | null;
  assortments: { id: number; tags: string[] }[];
}

/**
 * Resolve a lat/lon, confirm serviceability, pick the express dark store, and
 * persist it as the confirmed delivery location. This is the location guard's
 * gate: no catalog/cart/checkout call is allowed until this has succeeded.
 */
export async function setLocation(lat: number, lon: number): Promise<LocationResult> {
  await ensureAuthKey();
  const [info, vis] = await Promise.all([locationInfo(lat, lon), checkServiceability(lat, lon)]);
  const merchants: any[] = vis?.merchants ?? [];
  const express = merchants.find((m) =>
    m?.additional_filters?.assortment_tags?.includes("express"),
  );
  const merchant = express ?? merchants[0];
  const serviceable = Boolean(vis?.serviceable && info?.is_serviceable);

  await updateSession({
    location: {
      lat,
      lon,
      label: info?.display_address?.address_line ?? info?.locality,
      city: vis?.cityName,
      merchant_id: merchant ? Number(merchant.id) : undefined,
      serviceable,
      confirmed_at: new Date().toISOString(),
    },
  });

  return {
    serviceable,
    address: info?.display_address ?? null,
    city: vis?.cityName,
    lat,
    lon,
    merchant_id: merchant ? Number(merchant.id) : null,
    assortments: merchants.map((m) => ({
      id: Number(m.id),
      tags: m?.additional_filters?.assortment_tags ?? [],
    })),
  };
}

/** Resolve a free-text address ("home", "Koramangala") to coordinates and set it. */
export async function findAndSetLocation(query: string): Promise<LocationResult & { matched?: AddressSuggestion }> {
  const s = await loadSession();
  const near = s.location ? { lat: s.location.lat, lon: s.location.lon } : undefined;
  const suggestions = await searchAddress(query, near);
  if (!suggestions.length) {
    throw new BlinkitError(`No address matches for "${query}"`, 404);
  }
  const top = suggestions[0];
  const place = await resolvePlace(top);
  const lat = Number(place?.coordinate?.lat);
  const lon = Number(place?.coordinate?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new BlinkitError(`Could not resolve coordinates for "${top.title}"`, 0, place);
  }
  const result = await setLocation(lat, lon);
  return { ...result, matched: top, address: place?.display_address ?? result.address };
}

/* ------------------------------- Catalog ------------------------------- */

export async function getHomeFeed(): Promise<Product[]> {
  await ensureAuthKey();
  const res = await request<any>("/feed/", { query: { template_version: 9 }, authed: false });
  return extractProducts(res);
}

export async function searchProducts(query: string, page = 0): Promise<Product[]> {
  await ensureAuthKey();
  const q: Record<string, any> = { q: query, search_type: "type_to_search" };
  if (page > 0) {
    q.offset = page * 12;
    q.limit = 12;
    q.page_index = page;
    q.actual_query = query;
    q.search_method = "basic";
  }
  const res = await request<any>("/v1/layout/search", {
    method: "POST",
    query: q,
    json: { applied_filters: null, sort: "", previous_search_query: query },
    authed: false,
  });
  return extractProducts(res);
}

export async function autosuggest(query: string): Promise<string[]> {
  await ensureAuthKey();
  const res = await request<any>("/v1/actions/auto_suggest", {
    method: "POST",
    json: { q: query, search_type: "type_to_search" },
    authed: false,
  });
  const out = new Set<string>();
  const walk = (n: any): void => {
    if (!n || typeof n !== "object") return;
    const v = n?.click_action?.update_search_query?.query;
    if (typeof v === "string") out.add(v);
    Object.values(n).forEach(walk);
  };
  walk(res);
  return [...out];
}

export async function getRecommendations(productId: number): Promise<Product[]> {
  await ensureAuthKey();
  const res = await request<any>(`/v1/actions/product_recommendations/${productId}`, {
    method: "POST",
    query: { page_type: "search_listing_page" },
    json: {
      product_id: String(productId),
      recommendation_type: "DEFAULT",
      send_cart_items: true,
    },
    authed: false,
  });
  return extractProducts(res);
}

/* ------------------------------- Cart ------------------------------- */

export interface CartView {
  item_count: number;
  payable_amount?: number;
  total_mrp?: number;
  delivery_charge?: number;
  free_delivery_mov?: number;
  requires_login: boolean;
  validations: { code?: string; message?: string }[];
  raw_bill?: any;
}

/**
 * Recompute the cart for a set of line items. Blinkit's cart is stateless: you
 * POST the full item list each time and get back the priced cart.
 */
export async function computeCart(items: CartItem[]): Promise<CartView> {
  await ensureAuthKey();
  const res = await request<any>("/v5/carts", {
    method: "POST",
    json: { items, promo_codes: [""] },
  });
  const cart = res?.cart_data ?? {};
  const bill = cart?.bill_details ?? {};
  const validations: any[] = cart?.validations ?? [];
  return {
    item_count: bill?.total_items ?? items.length,
    payable_amount: bill?.payable_amount,
    total_mrp: bill?.total_mrp,
    delivery_charge: bill?.delivery_charge,
    free_delivery_mov: bill?.free_delivery_mov,
    requires_login: validations.some((v) => v?.code === "FORCE_LOGOUT_USER"),
    validations: validations.map((v) => ({ code: v?.code, message: v?.message })),
    raw_bill: bill,
  };
}

/* ------------------------------- Orders ------------------------------- */

export async function orderCount() {
  const s = await loadSession();
  requireLogin(s);
  await ensureAuthKey();
  const res = await request<any>("/v1/order_count");
  return res?.data?.[`user:${s.user_id}`]?.order_traits_realtime ?? res?.data ?? res;
}

/** Fetch recent orders, persist them locally, and return the parsed summaries. */
export async function orderHistory(): Promise<OrderSummary[]> {
  const s = await loadSession();
  requireLogin(s);
  await ensureAuthKey();
  const res = await request<any>("/v1/layout/order_history", { method: "POST" });
  const orders = extractOrders(res);
  recordOrders(
    orders.map((o) => ({
      order_id: o.order_id,
      cart_id: o.cart_id,
      total: o.total,
      status: o.status,
      placed_at: o.placed_at,
      product_names: o.product_names,
      product_ids: o.reorder_product_ids,
    })),
  );
  return orders;
}

/* -------------------------- Addresses / checkout -------------------------- */

export interface Address {
  id: number;
  label?: string;
  lat?: number;
  lon?: number;
  formatted?: string;
}

export async function getAddresses(): Promise<Address[]> {
  const s = await loadSession();
  requireLogin(s);
  await ensureAuthKey();
  const res = await request<any>("/v4/address", {
    query: { cur_lat: s.location?.lat, cur_lon: s.location?.lon },
  });
  const list: any[] = res?.addresses?.addresses_data ?? res?.addresses ?? [];
  return list.map((a) => ({
    id: a.id,
    label: a.label_id ?? a.label,
    lat: a.latitude,
    lon: a.longitude,
    formatted: a.formatted_address ?? a.address,
  }));
}

export async function selectAddress(addressId: number) {
  await updateSession({ address_id: addressId });
  return { ok: true, address_id: addressId };
}

/**
 * Prepare (but DO NOT pay for) an order: turn the working cart into a real
 * server cart, bind the delivery address, and validate it. Payment is
 * intentionally absent — the human completes it in the Blinkit app/site.
 */
export async function prepareOrder(
  items: CartItem[],
  addressId: number,
): Promise<{ cart_id: number; payable?: number; valid: boolean; next_step: string }> {
  const s = await loadSession();
  requireLogin(s);
  await ensureAuthKey();
  const created = await request<any>("/v5/carts", {
    method: "POST",
    json: { items, promo_codes: [""] },
  });
  const cartId = created?.cart_data?.id;
  if (!cartId) throw new BlinkitError("Failed to create server cart", 0, created);
  await request(`/v5/carts/${cartId}`, {
    method: "PATCH",
    json: { address_id: addressId },
  });
  const validated = await request<any>(`/v5/carts/${cartId}/validate`, {
    method: "POST",
    json: {},
  });
  const bill = validated?.cart_data?.bill_details ?? created?.cart_data?.bill_details ?? {};
  return {
    cart_id: cartId,
    payable: bill?.payable_amount,
    valid: (validated?.cart_data?.status_code ?? 0) === 0,
    next_step:
      "Order prepared and validated. Payment is NOT automated: open the Blinkit app/site to pay and place it.",
  };
}

/* ------------------------------- Cart ops ------------------------------- */

export { toCartItem, type CartItem, type Product, type OrderSummary };
