import { randomHex } from "./crypto.ts";

/**
 * WebAuthn challenges, in memory (one container): 5 minutes, single use, bound to their kind and, for
 * reauth and registration, to the account and session. At most 10000 at once; the oldest go first.
 */

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CHALLENGES = 10_000;

export type ChallengeKind = "login" | "reauth" | "register" | "signup" | "setup" | "reset";

export interface Challenge {
  kind: ChallengeKind;
  /** base64url challenge sent to the browser. */
  challenge: string;
  expiresAt: number;
  accountId?: number;
  sessionId?: string;
  /** Sign-up, setup and reset: who the passkey is made for. */
  username?: string;
  displayName?: string;
  webauthnUserId?: string;
}

export class ChallengeStore {
  private readonly items = new Map<string, Challenge>();

  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  /** Stores a challenge and returns its id. */
  add(challenge: Omit<Challenge, "expiresAt">): string {
    const id = randomHex(16);
    if (this.items.size >= MAX_CHALLENGES) {
      const oldest = this.items.keys().next().value;
      if (oldest !== undefined) this.items.delete(oldest);
    }
    this.items.set(id, { ...challenge, expiresAt: this.now() + CHALLENGE_TTL_MS });
    return id;
  }

  /**
   * Takes a challenge out (single use, also when the binding does not match, so a wrong guess burns it).
   * Null when unknown, expired, of another kind, or bound to another account or session.
   */
  take(
    id: string,
    kind: ChallengeKind,
    binding: { accountId?: number; sessionId?: string } = {},
  ): Challenge | null {
    const item = this.items.get(id);
    if (!item) return null;
    this.items.delete(id);
    if (item.expiresAt <= this.now() || item.kind !== kind) return null;
    if (item.accountId !== binding.accountId || item.sessionId !== binding.sessionId) return null;
    return item;
  }

  get size(): number {
    return this.items.size;
  }
}
