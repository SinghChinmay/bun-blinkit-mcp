/**
 * Startup smoke check: connect an in-memory MCP client and list the registered
 * tools. Fails loudly if the server cannot boot or register its tool surface.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server";

const server = createServer();
const client = new Client({ name: "blinkit-tools-check", version: "1.0.0" });
const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

await server.connect(serverTransport);
await client.connect(clientTransport);

const { tools } = await client.listTools();
console.log(`Registered ${tools.length} tools:`);
for (const t of tools.sort((a, b) => a.name.localeCompare(b.name))) {
  console.log(`- ${t.name}: ${t.description ?? ""}`);
}

const forbidden = ["proceed_to_pay", "get_upi_ids", "select_upi_id", "pay_now", "select_payment_method"];
const leaked = tools.filter((t) => forbidden.includes(t.name));
if (leaked.length) {
  console.error(`FAIL: payment tools must not be exposed: ${leaked.map((t) => t.name).join(", ")}`);
  process.exit(1);
}

await client.close();
await server.close();
