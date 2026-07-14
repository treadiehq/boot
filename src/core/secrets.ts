import crypto from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./files";
import { stateDir } from "./identity";
import {
  fileReadError,
  isFileNotFoundError,
  quoteUserValue,
} from "./userErrors";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

/** Encrypted payload as stored in the synced map (all fields base64). */
export const encryptedBlobSchema = z.object({
  v: z.literal(1),
  alg: z.literal(ALGORITHM),
  iv: z.string(),
  tag: z.string(),
  data: z.string(),
});

export type EncryptedBlob = z.infer<typeof encryptedBlobSchema>;

/** Machine-local key file. Never synced — it is what makes the map safe to sync. */
export function secretKeyPath(): string {
  return path.join(stateDir(), "secret.key");
}

export function keyExists(): boolean {
  return existsSync(secretKeyPath());
}

export function generateKey(): Buffer {
  return crypto.randomBytes(KEY_BYTES);
}

function decodeKey(raw: string): Buffer {
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `The Boot secret key has an invalid format (expected ${KEY_BYTES} bytes, found ${key.length}). Import a valid key, then retry.`,
    );
  }
  return key;
}

/**
 * Read the machine's secret key. Throws a friendly, actionable error when it is
 * missing — that's the signal to copy the key over from another machine (the key
 * is intentionally never part of the synced map).
 */
export async function loadKey(): Promise<Buffer> {
  let raw: string;
  try {
    raw = await fs.readFile(secretKeyPath(), "utf8");
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw fileReadError("Boot secret key", secretKeyPath(), error);
    }
    throw new Error(
      `No Boot secret key was found at ${quoteUserValue(secretKeyPath(), 500)}. Create one with \`boot env init\`, or import one with \`boot env key import\`.`,
    );
  }
  return decodeKey(raw);
}

/** Create and persist a key if absent; returns it either way. */
export async function loadOrCreateKey(): Promise<{ key: Buffer; created: boolean }> {
  if (keyExists()) return { key: await loadKey(), created: false };
  const key = generateKey();
  await writeFileAtomic(secretKeyPath(), `${key.toString("base64")}\n`, { mode: 0o600 });
  return { key, created: true };
}

export async function exportKeyBase64(): Promise<string> {
  return (await loadKey()).toString("base64");
}

export async function importKeyBase64(base64: string, force = false): Promise<void> {
  const key = decodeKey(base64); // validates length
  if (keyExists() && !force) {
    throw new Error(
      `A secret key already exists at ${secretKeyPath()}. Re-run with --force to overwrite it.`,
    );
  }
  await writeFileAtomic(secretKeyPath(), `${key.toString("base64")}\n`, { mode: 0o600 });
}

export function encrypt(plaintext: string, key: Buffer): EncryptedBlob {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: ALGORITHM,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: data.toString("base64"),
  };
}

/* ------------------------------------------------------------------ *
 * Passphrase-wrapped key storage                                      *
 *                                                                     *
 * Wrap the 32-byte secret key with a passphrase-derived key so it can *
 * ride the synced map safely. Transferring secrets between machines   *
 * then means sharing a short passphrase out-of-band instead of a      *
 * 44-char base64 key — the wrapped blob alone is useless.             *
 * ------------------------------------------------------------------ */

const SCRYPT_N = 1 << 15; // 32768 — interactive-fast, brute-force-expensive.
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SALT_BYTES = 16;

/** A secret key encrypted under a passphrase, as stored in the map keyring. */
export const wrappedKeySchema = z.object({
  v: z.literal(1),
  kdf: z.literal("scrypt"),
  n: z.literal(SCRYPT_N),
  r: z.literal(SCRYPT_R),
  p: z.literal(SCRYPT_P),
  salt: z.string(),
  iv: z.string(),
  tag: z.string(),
  data: z.string(),
});

export type WrappedKey = z.infer<typeof wrappedKeySchema>;

function deriveWrapKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase.normalize("NFKC"), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    // scrypt needs a higher memory ceiling than the default for N=32768.
    maxmem: 128 * SCRYPT_N * SCRYPT_R * 2,
  });
}

/** Encrypt `key` under `passphrase` for storage in the synced map. */
export function wrapKey(key: Buffer, passphrase: string): WrappedKey {
  if (!passphrase) throw new Error("A passphrase is required to wrap the key.");
  const salt = crypto.randomBytes(SALT_BYTES);
  const wrapKeyBuf = deriveWrapKey(passphrase, salt);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, wrapKeyBuf, iv);
  const data = Buffer.concat([cipher.update(key), cipher.final()]);
  return {
    v: 1,
    kdf: "scrypt",
    n: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

/** Decrypt a wrapped key with its passphrase. Throws on a wrong passphrase. */
export function unwrapKey(blob: WrappedKey, passphrase: string): Buffer {
  const salt = Buffer.from(blob.salt, "base64");
  const wrapKeyBuf = crypto.scryptSync(passphrase.normalize("NFKC"), salt, SCRYPT_KEYLEN, {
    N: blob.n,
    r: blob.r,
    p: blob.p,
    maxmem: 128 * blob.n * blob.r * 2,
  });
  const decipher = crypto.createDecipheriv(ALGORITHM, wrapKeyBuf, Buffer.from(blob.iv, "base64"));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  let out: Buffer;
  try {
    out = Buffer.concat([decipher.update(Buffer.from(blob.data, "base64")), decipher.final()]);
  } catch {
    throw new Error(
      "Could not unlock the shared key. The passphrase is wrong or the saved key data is damaged.",
    );
  }
  if (out.length !== KEY_BYTES) {
    throw new Error(
      `The unlocked key has an invalid format (expected ${KEY_BYTES} bytes, found ${out.length}).`,
    );
  }
  return out;
}

/** Install a base64 key buffer as this machine's secret key. */
export async function installKey(key: Buffer, force = false): Promise<void> {
  await importKeyBase64(key.toString("base64"), force);
}

export function decrypt(blob: EncryptedBlob, key: Buffer): string {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(blob.iv, "base64"));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  try {
    const out = Buffer.concat([
      decipher.update(Buffer.from(blob.data, "base64")),
      decipher.final(),
    ]);
    return out.toString("utf8");
  } catch {
    // GCM auth failure: wrong key or the ciphertext was modified.
    throw new Error(
      "Could not decrypt the saved environment values. The key does not match, or the saved data is damaged. " +
        `Import the matching key at ${quoteUserValue(secretKeyPath(), 500)}, then retry.`,
    );
  }
}
