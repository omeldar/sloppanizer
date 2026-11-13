import * as crypto from "node:crypto";
import { timingSafeEqual } from "node:crypto";

/**
 * argon2id password hashes as PHC strings (`$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`), so the
 * parameters can change later: a login with a hash made with other parameters is rehashed.
 */

export interface Argon2Params {
  /** KiB. */
  memory: number;
  passes: number;
  parallelism: number;
}

export const ARGON2_PARAMS: Argon2Params = { memory: 19_456, passes: 2, parallelism: 1 };
const TAG_BYTES = 32;
const SALT_BYTES = 16;
/** At most this many hashes run at once; a login flood waits instead of eating the memory. */
const MAX_PARALLEL = 4;

export class Argon2MissingError extends Error {}

/** The server refuses to start on a Node without crypto.argon2. */
export function assertArgon2(): void {
  if (typeof (crypto as { argon2?: unknown }).argon2 !== "function") {
    throw new Argon2MissingError(
      `This Node.js (${process.version}) has no crypto.argon2. Use Node 24.21 or newer.`,
    );
  }
}

/** A counting semaphore. */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  get running(): number {
    return this.active;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    // oxlint-disable-next-line no-await-in-loop -- waiting for a free slot is sequential by nature
    while (this.active >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

export const hashGate = new Semaphore(MAX_PARALLEL);

function derive(password: string, salt: Buffer, params: Argon2Params): Promise<Buffer> {
  return hashGate.run(
    () =>
      new Promise<Buffer>((resolve, reject) => {
        crypto.argon2(
          "argon2id",
          {
            message: Buffer.from(password, "utf8"),
            nonce: salt,
            parallelism: params.parallelism,
            tagLength: TAG_BYTES,
            memory: params.memory,
            passes: params.passes,
          },
          (error, key) => (error ? reject(error) : resolve(key)),
        );
      }),
  );
}

const b64 = (buffer: Buffer): string => buffer.toString("base64").replace(/=+$/, "");

export async function hashPassword(password: string, params: Argon2Params = ARGON2_PARAMS): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, params);
  const p = `m=${params.memory},t=${params.passes},p=${params.parallelism}`;
  return ["", "argon2id", "v=19", p, b64(salt), b64(hash)].join("$");
}

interface ParsedHash {
  params: Argon2Params;
  salt: Buffer;
  hash: Buffer;
}

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

function parse(phc: string): ParsedHash | null {
  const match = PHC.exec(phc);
  if (!match) return null;
  const [, m, t, p, salt, hash] = match as unknown as [string, string, string, string, string, string];
  return {
    params: { memory: Number(m), passes: Number(t), parallelism: Number(p) },
    salt: Buffer.from(salt, "base64"),
    hash: Buffer.from(hash, "base64"),
  };
}

export interface PasswordCheck {
  ok: boolean;
  /** The hash uses other parameters than today's: store a new one. */
  needsRehash: boolean;
}

export async function verifyPassword(
  password: string,
  phc: string,
  current: Argon2Params = ARGON2_PARAMS,
): Promise<PasswordCheck> {
  const parsed = parse(phc);
  if (!parsed) return { ok: false, needsRehash: false };
  const computed = await derive(password, parsed.salt, parsed.params);
  const ok = computed.length === parsed.hash.length && timingSafeEqual(computed, parsed.hash);
  const p = parsed.params;
  const needsRehash =
    ok &&
    (p.memory !== current.memory || p.passes !== current.passes || p.parallelism !== current.parallelism);
  return { ok, needsRehash };
}

/**
 * A hash of a random password, made once at start. Logins for unknown names (and accounts without a
 * password) are checked against it, so the answer time does not tell which names exist.
 */
export class DummyHash {
  private value: Promise<string> | null = null;

  get(): Promise<string> {
    this.value ??= hashPassword(crypto.randomBytes(24).toString("base64"));
    return this.value;
  }

  /** Runs a full verify that always fails. */
  async burn(password: string): Promise<void> {
    await verifyPassword(password, await this.get());
  }
}
