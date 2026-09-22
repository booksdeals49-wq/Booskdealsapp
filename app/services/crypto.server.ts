// Field-level encryption (AES-256-GCM) for sensitive credentials stored at
// rest — specifically AdAccountConnection.accessToken and .extraJson (see
// app/routes/app.ad-spend.tsx), which hold merchants' Meta/Google/TikTok/
// Snapchat ad account tokens. Server-only (uses Node's crypto module) —
// never import this from a route component.
//
// Requires TOKEN_ENCRYPTION_KEY in the environment: a 64-character hex
// string (32 random bytes). Generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// and set it in .env locally and in your production host's env vars (see
// .env.example). Without it, encrypting/decrypting a NEW value throws —
// deliberately fail-loud rather than silently falling back to storing
// plaintext.
import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
// Prefix lets decryptSecret tell freshly-encrypted values apart from rows
// written before this feature existed (plain old plaintext) — see
// decryptSecret's backward-compatibility note below.
const ENC_PREFIX = "enc:v1:";

function getKey(): Buffer {
  const hex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is missing or invalid — it must be a 64-character " +
        "hex string (32 bytes). Generate one with: " +
        `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" ` +
        "and set it as an environment variable (.env locally, your host's " +
        "variables in production). See .env.example.",
    );
  }
  return Buffer.from(hex, "hex");
}

/** Encrypt a plaintext credential (e.g. an ad platform access token) for storage. */
export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12); // 96-bit IV, standard for GCM
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

/**
 * Decrypt a value stored via encryptSecret.
 *
 * Backward compatibility: a value written before this feature existed has
 * no "enc:v1:" prefix — that's assumed to be legacy plaintext and returned
 * unchanged (no crash, no data loss). It gets upgraded to encrypted
 * automatically the next time that connection is saved (see
 * app.ad-spend.tsx's action, which only re-encrypts fields the merchant
 * actually resubmits).
 *
 * If the key is wrong/rotated or the stored value is corrupted, this fails
 * safe (returns "") rather than throwing — a bad decrypt shouldn't crash
 * the whole Ad Spend page; worst case, that one connection just needs to
 * be reconnected.
 */
export function decryptSecret(stored: string | null | undefined): string {
  if (!stored) return "";
  if (!stored.startsWith(ENC_PREFIX)) return stored; // legacy plaintext

  const parts = stored.slice(ENC_PREFIX.length).split(":");
  if (parts.length !== 3) return ""; // malformed — fail safe
  const [ivHex, authTagHex, ciphertextHex] = parts;

  try {
    const key = getKey();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextHex, "hex")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch {
    return "";
  }
}

/** Encrypt every value in a flat string-keyed object (used for extraJson). */
export function encryptJson(obj: Record<string, string>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, encryptSecret(v)])),
  );
}

/**
 * Decrypt a JSON-encoded object of secrets (used for extraJson). Handles
 * legacy rows that were stored as plain JSON with plaintext values, since
 * decryptSecret passes through anything without the enc:v1: prefix
 * unchanged. Never throws — a missing key or corrupted JSON just yields {}
 * so the Ad Spend page still renders (that connection's saved fields show
 * blank and need to be re-entered).
 */
export function decryptJson(stored: string | null | undefined): Record<string, string> {
  if (!stored) return {};
  try {
    const parsed = JSON.parse(stored) as Record<string, string>;
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, decryptSecret(v)]));
  } catch {
    return {};
  }
}
