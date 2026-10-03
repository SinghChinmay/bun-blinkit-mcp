/**
 * Live end-to-end smoke test against the real Blinkit API (no browser, no login,
 * no order placed). Uses a throwaway BLINKIT_HOME. Run:
 *   BLINKIT_HOME=/tmp/opencode/blinkit-e2e bun run test/smoke.ts
 */
import { setLocation, searchProducts } from "../src/api";
import { addItems, viewCart } from "../src/cart";
import { requireLocation } from "../src/client";
import { loadSession } from "../src/session";

const lat = Number(process.env.SMOKE_LAT ?? 28.6412);
const lon = Number(process.env.SMOKE_LON ?? 77.2188);

console.log("1) set_location", lat, lon);
const loc = await setLocation(lat, lon);
console.log("   serviceable:", loc.serviceable, "| address:", loc.address?.address_line, "| merchant:", loc.merchant_id);
if (!loc.serviceable) throw new Error("location not serviceable");

const s = await loadSession();
requireLocation(s);
console.log("   guard OK — location confirmed");

console.log("2) search 'pizza'");
const results = await searchProducts("pizza");
console.log(`   ${results.length} products; top:`, results.slice(0, 3).map((p) => `${p.name} ₹${p.price}`));
if (!results.length) throw new Error("no search results");
const top = results.find((p) => p.cart_item) ?? results[0];
if (!top.cart_item) throw new Error("top product missing cart_item");

console.log("3) add_to_cart", top.name);
const added = await addItems([{ ...top.cart_item, quantity: 2 }]);
console.log("   cart lines:", added.lines.map((l) => `${l.product_name} x${l.quantity}`));
console.log("   payable:", added.payable_amount, "| requires_login:", added.requires_login);

console.log("4) check_cart");
const cart = await viewCart();
console.log("   item_count:", cart.item_count, "| payable:", cart.payable_amount);

console.log("\nSMOKE OK");
process.exit(0);
