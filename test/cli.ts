/**
 * Interactive CLI for manually exercising the API-only flow (no browser).
 * Run: bun run test/cli.ts
 */
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import {
  findAndSetLocation,
  getAddresses,
  logout,
  orderHistory,
  searchProducts,
  selectAddress,
  sendOtp,
  setLocation,
  verifyOtp,
} from "../src/api";
import { addItems, clearCart, removeItem, viewCart } from "../src/cart";
import { loadSession } from "../src/session";
import { getCartItems, getCombo, getRepeatSuggestions, listCombos, listStaples, saveCombo } from "../src/store";
import type { Product } from "../src/parse";

const rl = readline.createInterface({ input, output });
let lastResults: Product[] = [];
let lastAddressId: number | undefined;

async function repl(): Promise<void> {
  const s = await loadSession();
  console.log("bun-blinkit-mcp CLI (API-only). Type 'help' for commands.");
  console.log(
    `session: ${s.access_token ? "logged in" : "logged out"} | ` +
      `location: ${s.location ? `${s.location.label ?? ""} (${s.location.lat},${s.location.lon})` : "none"}`,
  );

  for (;;) {
    const raw = (await rl.question("blinkit> ")).trim();
    if (!raw) continue;
    const [cmd, ...args] = raw.split(/\s+/);
    try {
      switch (cmd) {
        case "quit":
        case "exit":
          rl.close();
          return;
        case "help":
          console.log(
            [
              "  login <phone> | otp <code> | logout",
              "  where | location <lat> <lon> | find <address...>",
              "  search <query...> | add <index> [qty] | remove <product_id> | cart | clear",
              "  history | addresses | select-address <id>",
              "  staples | combos | save <name> | use <name> | recent",
            ].join("\n"),
          );
          break;
        case "login": {
          const res = await sendOtp(args[0]);
          console.log(res);
          break;
        }
        case "otp": {
          const res = await verifyOtp(args[0] ?? "", args[1] ?? "");
          console.log(res);
          break;
        }
        case "logout":
          await logout();
          console.log("logged out");
          break;
        case "where": {
          const cur = await loadSession();
          console.log(cur.location ?? "no location set");
          break;
        }
        case "location":
          console.log(await setLocation(Number(args[0]), Number(args[1])));
          break;
        case "find":
          console.log(await findAndSetLocation(args.join(" ")));
          break;
        case "search": {
          lastResults = await searchProducts(args.join(" "));
          lastResults.forEach((p, i) => console.log(`[${i}] ${p.name} — ₹${p.price} (${p.unit}) id=${p.product_id}`));
          break;
        }
        case "add": {
          const p = lastResults[Number(args[0])];
          if (!p) throw new Error("No such index; run 'search' first.");
          console.log(await addItems([{ ...p, quantity: Number(args[1] ?? 1) }]));
          break;
        }
        case "remove":
          console.log(await removeItem(Number(args[0])));
          break;
        case "cart":
          console.log(await viewCart());
          break;
        case "clear":
          await clearCart();
          console.log("cleared");
          break;
        case "history":
          console.log(await orderHistory());
          break;
        case "addresses": {
          const list = await getAddresses();
          list.forEach((a) => console.log(`[${a.id}] ${a.label} - ${a.formatted}`));
          break;
        }
        case "select-address":
          lastAddressId = Number(args[0]);
          console.log(await selectAddress(lastAddressId));
          break;
        case "staples":
          console.log(listStaples());
          break;
        case "combos":
          console.log(listCombos());
          break;
        case "save":
          console.log(saveCombo(args.join(" "), getCartItems() as any));
          break;
        case "use": {
          const combo = getCombo(args.join(" "));
          if (!combo) throw new Error(`no combo '${args.join(" ")}'`);
          console.log(await addItems(combo.items));
          break;
        }
        case "recent":
          console.log(getRepeatSuggestions(10));
          break;
        default:
          console.log(`unknown command: ${cmd}`);
      }
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
    }
  }
}

repl().catch((err) => {
  console.error(err);
  process.exit(1);
});
