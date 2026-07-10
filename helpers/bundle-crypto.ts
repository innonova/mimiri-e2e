import { webcrypto } from "crypto";

/**
 * Signing/verification for Mimiri update bundles, replicating the client's
 * scheme exactly (mimiri-client src/services/crypt-signature.ts and
 * scripts/make-bundle.js): RSASSA-PKCS1-v1_5 with SHA-256 over the UTF-8
 * bytes of `JSON.stringify({...bundle, signatures: undefined})`, keys
 * exchanged as single-line base64 SPKI DER (the PEM body without the
 * BEGIN/END lines — the client's pemToArrayBuffer accepts both forms).
 */

/**
 * Signing key name baked into published clients (VITE_UPDATE_NAME in
 * mimiri-client). Signatures are matched to keys by this name.
 */
export const UPDATE_KEY_NAME = "2024101797F6C918";

/**
 * The production update public key baked into published clients
 * (VITE_UPDATE_PUBLIC_KEY in mimiri-client, certs/2024101797F6C918.pub in
 * mimiri-client-electron). Used to verify bundles downloaded from the real
 * update host before they are accepted as test fixtures.
 */
export const PRODUCTION_UPDATE_PUBLIC_KEY =
  "MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEA0f7QLSUDDaojzYMctHmR6fdK5" +
  "OvjNtl0kwaf52dwRJwz04J8XY/+kDJN5RpS02GsyMTXKL6kG43qeZwDgrfr2KJ6/p/GRP" +
  "bgfoCWeVCp3qdFjZJaSzNHisjRbDzs0uTh09dWec3z+jIhfAo0e4r+b7sm0KCGD7hIyAI" +
  "SbS4Zx7xojQGwk5U9rrv0DZZq6y7p0OmGN/5JllFMJ/Fe9eMxy4l7/QENoCzuMG8tj++t" +
  "xfPfMSEW5KHXN7f2ZJjQooq1Z4MqlxnuuruEjJpz4aCHtj9RbdUsgbsgds9eJkMRcPLkV" +
  "7owiB3w+Xrx8uiptYFQnyBzm+gIiQSR2V9kAa6iN30RiV4vYokSlkpU2cCznFhc6CjJG4" +
  "qjwGmpnFb2e638todbEv2Bn3DUk3mYaNb3QxwSLH8SUqbQ4B47GIR1hE1OVnl7i9FqoFC" +
  "l/4lasASOjNf2ZjPH2ZHFIOTffb3UNDBcdkUv64/89O/7KXdpC4MoSp5srhmFJCYHIKY9" +
  "aNCpAgMBAAE=";

const ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

/** A file entry inside a bundle: a leaf with gzip+base64 content or a dir. */
export interface BundleFile {
  name: string;
  content?: string;
  files?: BundleFile[];
}

export interface Bundle {
  files: BundleFile[];
  version: string;
  description?: string;
  releaseDate: string;
  signatures?: { name: string; signature: string }[];
  [key: string]: unknown;
}

export interface UpdateKeyPair {
  privateKey: webcrypto.CryptoKey;
  /** Single-line base64 SPKI DER — the format MIMIRI_UPDATE_KEY expects. */
  publicKeyBase64: string;
}

/** Generates a fresh RSA-3072 signing key pair for one test run. */
export async function generateUpdateKeyPair(): Promise<UpdateKeyPair> {
  const { publicKey, privateKey } = await webcrypto.subtle.generateKey(
    {
      ...ALGORITHM,
      modulusLength: 3072,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["sign", "verify"],
  );
  const spki = await webcrypto.subtle.exportKey("spki", publicKey);
  return { privateKey, publicKeyBase64: Buffer.from(spki).toString("base64") };
}

/** The exact byte sequence the client signs/verifies for a bundle. */
function signedPayload(bundle: Bundle): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify({ ...bundle, signatures: undefined }),
  ) as Uint8Array<ArrayBuffer>;
}

/** Decodes single-line base64 into a WebCrypto-friendly buffer. */
function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

/** Signs `bundle` in place, replacing any existing signatures. */
export async function signBundle(
  bundle: Bundle,
  name: string,
  privateKey: webcrypto.CryptoKey,
): Promise<void> {
  delete bundle.signatures;
  const signature = await webcrypto.subtle.sign(
    ALGORITHM.name,
    privateKey,
    signedPayload(bundle),
  );
  bundle.signatures = [
    { name, signature: Buffer.from(signature).toString("base64") },
  ];
}

/**
 * Signs raw bytes (e.g. a Squirrel nupkg) the way the client's
 * CryptSignature.verifyRaw expects: RSASSA-PKCS1-v1_5/SHA-256 over the
 * bytes, base64-encoded signature.
 */
export async function signRaw(
  data: Uint8Array,
  privateKey: webcrypto.CryptoKey,
): Promise<string> {
  const signature = await webcrypto.subtle.sign(
    ALGORITHM.name,
    privateKey,
    new Uint8Array(data),
  );
  return Buffer.from(signature).toString("base64");
}

/** Counterpart of signRaw for self-checks, mirroring verifyRaw. */
export async function verifyRawSignature(
  signature: string,
  data: Uint8Array,
  publicKeyBase64: string,
): Promise<boolean> {
  const publicKey = await webcrypto.subtle.importKey(
    "spki",
    fromBase64(publicKeyBase64),
    ALGORITHM,
    false,
    ["verify"],
  );
  return webcrypto.subtle.verify(
    ALGORITHM.name,
    publicKey,
    fromBase64(signature),
    new Uint8Array(data),
  );
}

/**
 * Verifies the signature named `name` against a single-line base64 SPKI
 * public key, using the same payload construction as the client's
 * CryptSignature.verify.
 */
export async function verifyBundleSignature(
  bundle: Bundle,
  name: string,
  publicKeyBase64: string,
): Promise<boolean> {
  const signature = bundle.signatures?.find((s) => s.name === name);
  if (!signature) {
    return false;
  }
  const publicKey = await webcrypto.subtle.importKey(
    "spki",
    fromBase64(publicKeyBase64),
    ALGORITHM,
    false,
    ["verify"],
  );
  return webcrypto.subtle.verify(
    ALGORITHM.name,
    publicKey,
    fromBase64(signature.signature),
    signedPayload(bundle),
  );
}
