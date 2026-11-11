import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.ts";
import { createServer } from "./server.ts";

// stdout carries the protocol: log only to stderr.
const server = createServer(loadConfig());
await server.connect(new StdioServerTransport());
