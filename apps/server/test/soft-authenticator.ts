import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";

/**
 * A software passkey authenticator for server tests: one P-256 key per credential, attestation "none",
 * user verification always done. It answers the options the server sends like a browser would
 * (RegistrationResponseJSON and AuthenticationResponseJSON), so the real WebAuthn checks run.
 */

// ---- minimal CBOR encoder (maps, unsigned and negative ints, byte and text strings) ----
type Cbor = number | string | Uint8Array | Map<number | string, Cbor> | Record<string, never>;

function head(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 256) return Buffer.from([(major << 5) | 24, value]);
  if (value < 65536) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(value, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(value, 1);
  return b;
}

export function cbor(value: Cbor): Buffer {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, v]) => [cbor(k), cbor(v as Cbor)])]);
}

const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const sha256 = (data: Uint8Array | string): Buffer => createHash("sha256").update(data).digest();

interface Credential {
  id: Buffer;
  privateKey: KeyObject;
  publicKey: KeyObject;
  rpId: string;
  userHandle: string;
  counter: number;
}

export interface SoftAuthenticatorOptions {
  origin: string;
  /** Pretend to sign for another origin or RP ID (abuse tests). */
  overrideOrigin?: string;
  overrideRpId?: string;
}

type Json = Record<string, unknown>;

export class SoftAuthenticator {
  readonly credentials: Credential[] = [];
  origin: string;
  overrideOrigin: string | undefined;
  overrideRpId: string | undefined;

  constructor(options: SoftAuthenticatorOptions) {
    this.origin = options.origin;
    this.overrideOrigin = options.overrideOrigin;
    this.overrideRpId = options.overrideRpId;
  }

  private clientData(type: string, challenge: string): Buffer {
    return Buffer.from(
      JSON.stringify({ type, challenge, origin: this.overrideOrigin ?? this.origin, crossOrigin: false }),
    );
  }

  /** Answers PublicKeyCredentialCreationOptionsJSON (navigator.credentials.create). */
  create(options: Json): Json {
    const rp = options.rp as { id: string };
    const user = options.user as { id: string };
    const rpId = this.overrideRpId ?? rp.id;
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const cose = cbor(
      new Map<number, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x, "base64url")],
        [-3, Buffer.from(jwk.y, "base64url")],
      ]),
    );
    const id = randomBytes(16);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(id.length);
    // Flags: user present, user verified, backup eligible + backed up (a synced passkey), attested data.
    const authData = Buffer.concat([
      sha256(rpId),
      Buffer.from([0x01 | 0x04 | 0x08 | 0x10 | 0x40]),
      Buffer.alloc(4),
      Buffer.alloc(16),
      length,
      id,
      cose,
    ]);
    const attestationObject = cbor(
      new Map<string, Cbor>([
        ["fmt", "none"],
        ["attStmt", {}],
        ["authData", authData],
      ]),
    );
    this.credentials.push({ id, privateKey, publicKey, rpId: rp.id, userHandle: user.id, counter: 0 });
    return {
      id: b64u(id),
      rawId: b64u(id),
      type: "public-key",
      response: {
        clientDataJSON: b64u(this.clientData("webauthn.create", options.challenge as string)),
        attestationObject: b64u(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /**
   * Answers PublicKeyCredentialRequestOptionsJSON (navigator.credentials.get) with the newest credential
   * (or the given one). `counter` forces the signature counter (rollback tests).
   */
  get(options: Json, pick?: { credential?: Credential; counter?: number }): Json {
    const credential = pick?.credential ?? this.credentials.at(-1);
    if (!credential) throw new Error("no credential");
    credential.counter = pick?.counter ?? credential.counter + 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(credential.counter);
    const rpId = this.overrideRpId ?? (options.rpId as string);
    const authData = Buffer.concat([sha256(rpId), Buffer.from([0x01 | 0x04 | 0x08 | 0x10]), counter]);
    const clientDataJSON = this.clientData("webauthn.get", options.challenge as string);
    const signature = sign(
      "sha256",
      Buffer.concat([authData, sha256(clientDataJSON)]),
      credential.privateKey,
    );
    return {
      id: b64u(credential.id),
      rawId: b64u(credential.id),
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: credential.userHandle,
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
