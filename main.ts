#!/usr/bin/env bun
import { startServer } from "./src/server";

startServer().catch((err) => {
  // stderr only — stdout is the MCP JSON-RPC channel.
  console.error("Fatal:", err);
  process.exit(1);
});
