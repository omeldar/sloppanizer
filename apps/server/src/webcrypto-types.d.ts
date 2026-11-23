// Types the vendored omeldar auth client (services/auth/omeldar-auth.ts, kept identical to omeldar/auth) expects
// from the DOM lib. Node has the same Web Crypto objects as globals; @types/node names them only under
// node:crypto's webcrypto, and types Response.json() as unknown where the DOM lib says any.
import type { webcrypto } from "node:crypto";

declare global {
  type JsonWebKey = webcrypto.JsonWebKey;
  interface CryptoKey extends webcrypto.CryptoKey {}
  interface Response {
    // oxlint-disable-next-line typescript/no-explicit-any -- the DOM lib's type, for the vendored client only
    json(): Promise<any>;
  }
}
