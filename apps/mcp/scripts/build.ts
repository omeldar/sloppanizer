import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));
export const DEFAULT_OUTFILE = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/**
 * Bundles the MCP server and all its dependencies into one ESM file, so the release folder needs no
 * node_modules. The banner gives bundled CommonJS code a working require().
 */
export async function bundle(outfile = DEFAULT_OUTFILE): Promise<void> {
  await build({
    entryPoints: [ENTRY],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    legalComments: "none",
    logLevel: "warning",
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });
}

if (import.meta.main) await bundle(process.argv[2]);
