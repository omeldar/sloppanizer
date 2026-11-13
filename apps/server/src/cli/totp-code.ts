import { TotpSecret } from "@organizer/shared";
import { totpCode } from "../services/auth/totp.ts";

/** Prints the current authenticator code of a secret (development and tests). Refuses in production. */
export function main(argv: string[], env: NodeJS.ProcessEnv = process.env, now = Date.now()): number {
  if (env.NODE_ENV === "production") {
    console.error("totp-code is for development only; it refuses to run with NODE_ENV=production.");
    return 2;
  }
  const secret = TotpSecret.safeParse(argv[0]);
  if (argv.length !== 1 || !secret.success) {
    console.error("Usage: node src/cli/totp-code.ts <32 base32 characters>");
    return 2;
  }
  console.log(totpCode(secret.data, now));
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
