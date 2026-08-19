import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/* ============================================================
   Credentials at rest — AES-256-GCM on node:crypto, no deps.

   For third-party credentials the app has to REPLAY on every
   request (unlike passwords and recovery codes, which are
   scrypt-hashed one-way in @/lib/auth and @/lib/totp).

   Ciphertext lives in the database; the key never does:

     CSBG_SECRET_KEY   32-byte key as 64 hex chars (ops-managed)
     data/secret.key   generated on first use, mode 0600 (default)

   So a database dump or a backup tarball carries no usable
   credential on its own. Losing the key is not corruption:
   decryptSecret() returns null, the settings page reports the
   credential as unreadable, and staff re-enter it.
   ============================================================ */

const KEY_FILE = path.join(process.cwd(), "data", "secret.key");
const SCHEME = "gcm";
const HEX_32_BYTES = /^[0-9a-f]{64}$/i;

/** The 32-byte key: environment first, else the generated key file. */
function secretKey(): Buffer {
  const fromEnv = (process.env.CSBG_SECRET_KEY ?? "").trim();
  if (fromEnv) {
    if (!HEX_32_BYTES.test(fromEnv)) {
      throw new Error("CSBG_SECRET_KEY must be 64 hex characters (a 32-byte key).");
    }
    return Buffer.from(fromEnv, "hex");
  }
  if (fs.existsSync(KEY_FILE)) {
    const hex = fs.readFileSync(KEY_FILE, "utf8").trim();
    if (HEX_32_BYTES.test(hex)) return Buffer.from(hex, "hex");
    // unreadable key file: nothing encrypted with it can be recovered anyway,
    // so replace it rather than wedging every save behind a manual fix
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  fs.writeFileSync(KEY_FILE, key.toString("hex"), { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(KEY_FILE, 0o600); // also tighten a pre-existing looser file
  return key;
}

/** Encrypt a credential for storage: `gcm$<iv>$<tag>$<ciphertext>`, all hex. */
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [SCHEME, iv.toString("hex"), cipher.getAuthTag().toString("hex"), ciphertext.toString("hex")].join("$");
}

/** Decrypt a stored credential, or null when this key can't read it — a rotated
    or lost key, or a tampered row. Callers ask for the credential again rather
    than crashing; a malformed CSBG_SECRET_KEY still throws, because that is a
    server misconfiguration and not a lost secret. */
export function decryptSecret(stored: string): string | null {
  const [scheme, ivHex, tagHex, ciphertextHex] = (stored ?? "").split("$");
  if (scheme !== SCHEME || !ivHex || !tagHex || !ciphertextHex) return null;
  const key = secretKey();
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextHex, "hex")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}
