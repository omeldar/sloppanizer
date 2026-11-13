import type { Clock } from "../../clock.ts";
import type { Config } from "../../config.ts";
import { createLimiters, type Limiters } from "../../http/rate-limit.ts";
import { accessKey } from "./access-token.ts";
import { ChallengeStore } from "./challenges.ts";
import { loadDataKey } from "./crypto.ts";
import { DummyHash } from "./password.ts";

/** Everything the auth routes and the security hook share. One per app. */
export interface AuthServices {
  config: Config;
  /** Signs access tokens. */
  accessKey: Buffer;
  /** Encrypts authenticator secrets. */
  dataKey: Buffer;
  limiters: Limiters;
  challenges: ChallengeStore;
  dummyHash: DummyHash;
}

export function createAuthServices(config: Config, secret: string, clock: Clock): AuthServices {
  return {
    config,
    accessKey: accessKey(secret),
    dataKey: loadDataKey(config.dataDir, config.dataKey),
    limiters: createLimiters(clock),
    challenges: new ChallengeStore(() => clock().getTime()),
    dummyHash: new DummyHash(),
  };
}
