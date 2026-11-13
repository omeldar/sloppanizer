/**
 * Passkeys in the browser. The server sends WebAuthn options as JSON (binary fields in base64url) and
 * wants the browser's answer as JSON again; these helpers convert both ways.
 */

type Json = Record<string, unknown>;

export function base64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64url(buffer: ArrayBuffer | ArrayBufferView): string {
  const bytes =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const credentialList = (list: unknown) =>
  Array.isArray(list)
    ? list.map((item: Json) => ({ ...item, id: base64urlToBytes(String(item.id)) }))
    : undefined;

/** PublicKeyCredentialCreationOptionsJSON -> what navigator.credentials.create wants. */
export function creationOptions(json: Json): PublicKeyCredentialCreationOptions {
  const user = json.user as Json;
  return {
    ...json,
    challenge: base64urlToBytes(String(json.challenge)),
    user: { ...user, id: base64urlToBytes(String(user.id)) },
    excludeCredentials: credentialList(json.excludeCredentials),
  } as unknown as PublicKeyCredentialCreationOptions;
}

/** PublicKeyCredentialRequestOptionsJSON -> what navigator.credentials.get wants. */
export function requestOptions(json: Json): PublicKeyCredentialRequestOptions {
  return {
    ...json,
    challenge: base64urlToBytes(String(json.challenge)),
    allowCredentials: credentialList(json.allowCredentials),
  } as unknown as PublicKeyCredentialRequestOptions;
}

const encodeOptional = (value: ArrayBuffer | null | undefined) =>
  value ? bytesToBase64url(value) : undefined;

/** The browser's credential as RegistrationResponseJSON or AuthenticationResponseJSON. */
export function credentialToJson(credential: PublicKeyCredential): Json {
  const response = credential.response;
  const body: Json = { clientDataJSON: bytesToBase64url(response.clientDataJSON) };
  if ("attestationObject" in response) {
    const attestation = response as AuthenticatorAttestationResponse;
    body.attestationObject = bytesToBase64url(attestation.attestationObject);
    body.transports = attestation.getTransports?.() ?? [];
  } else {
    const assertion = response as AuthenticatorAssertionResponse;
    body.authenticatorData = bytesToBase64url(assertion.authenticatorData);
    body.signature = bytesToBase64url(assertion.signature);
    body.userHandle = encodeOptional(assertion.userHandle);
  }
  return {
    id: credential.id,
    rawId: bytesToBase64url(credential.rawId),
    type: credential.type,
    response: body,
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
  };
}

export const passkeysSupported = () =>
  typeof window !== "undefined" &&
  typeof window.PublicKeyCredential === "function" &&
  !!navigator.credentials;

/** Makes a new passkey; null when the person cancels. */
export async function createPasskey(options: Json): Promise<Json | null> {
  try {
    const credential = await navigator.credentials.create({ publicKey: creationOptions(options) });
    return credential ? credentialToJson(credential as PublicKeyCredential) : null;
  } catch (error) {
    if (isCancel(error)) return null;
    throw new Error(passkeyErrorText(error), { cause: error });
  }
}

/**
 * Signs in with a passkey; null when the person cancels. `conditional` lets the browser offer passkeys
 * in the username field's autofill instead of opening a dialog.
 */
export async function getPasskey(
  options: Json,
  { conditional = false, signal }: { conditional?: boolean; signal?: AbortSignal } = {},
): Promise<Json | null> {
  try {
    const credential = await navigator.credentials.get({
      publicKey: requestOptions(options),
      ...(conditional ? { mediation: "conditional" as CredentialMediationRequirement } : {}),
      signal,
    });
    return credential ? credentialToJson(credential as PublicKeyCredential) : null;
  } catch (error) {
    if (isCancel(error)) return null;
    throw new Error(passkeyErrorText(error), { cause: error });
  }
}

/** True when the browser can offer passkeys in the username autofill. */
export async function conditionalMediationAvailable(): Promise<boolean> {
  if (!passkeysSupported()) return false;
  const check = (
    PublicKeyCredential as unknown as { isConditionalMediationAvailable?: () => Promise<boolean> }
  ).isConditionalMediationAvailable;
  return check ? check.call(PublicKeyCredential).catch(() => false) : false;
}

function isCancel(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "AbortError");
}

function passkeyErrorText(error: unknown): string {
  if (error instanceof DOMException && error.name === "InvalidStateError") {
    return "This device already has a passkey for this account.";
  }
  if (error instanceof DOMException && error.name === "SecurityError") {
    return "The browser refused the passkey for this address.";
  }
  return "The passkey did not work. Try again, or use your password and code.";
}
