import {
  pbkdf2Sync,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";

/**
 * AES-256-GCM encryption for secrets at rest (e.g. the fund wallet xpub).
 * The key is derived from SESSION_SECRET + a random per-ciphertext salt via
 * PBKDF2 (100k iterations, SHA-256). Bundle format (base64 fields):
 *   salt:iv:authTag:ciphertext
 */

const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;

function getMasterSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is required for secret encryption");
  }
  return secret;
}

function deriveKey(salt: Buffer): Buffer {
  return pbkdf2Sync(getMasterSecret(), salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha256");
}

export function encryptSecret(plaintext: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [salt, iv, tag, ciphertext].map((b) => b.toString("base64")).join(":");
}

export function decryptSecret(bundle: string): string {
  const parts = bundle.split(":");
  if (parts.length !== 4) {
    throw new Error("Malformed ciphertext bundle");
  }
  const [salt, iv, tag, ciphertext] = parts.map((p) => Buffer.from(p, "base64"));
  const key = deriveKey(salt!);
  const decipher = createDecipheriv("aes-256-gcm", key, iv!, { authTagLength: 16 });
  decipher.setAuthTag(tag!);
  const plaintext = Buffer.concat([decipher.update(ciphertext!), decipher.final()]);
  return plaintext.toString("utf8");
}
