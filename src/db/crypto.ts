/**
 * AES-GCM encryption for storage credentials stored in D1.
 *
 * The encryption key comes from the CONFIG_KEY environment variable: either a
 * 64-char hex string or 44-char base64 string (both = 32 bytes). At rest,
 * credentials are stored as base64(iv || ciphertext || tag).
 *
 * If CONFIG_KEY is unset, credentials are stored in plaintext (with a warning
 * in admin UI). This keeps the project usable without a key for local dev,
 * but production MUST set CONFIG_KEY.
 */

const IV_LEN = 12;

export function hasConfigKey(configKey: string | undefined): boolean {
  return !!parseKey(configKey);
}

function parseKey(configKey: string | undefined): Uint8Array | null {
  const raw = (configKey ?? "").trim();
  if (!raw) return null;
  // hex (64 chars = 32 bytes)
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return hexToBytes(raw);
  }
  // base64 (44 chars incl. padding = 32 bytes)
  try {
    const bytes = base64ToBytes(raw);
    if (bytes.length === 32) return bytes;
  } catch {
    /* fall through */
  }
  throw new Error("CONFIG_KEY must be 32 bytes as hex (64 chars) or base64 (44 chars)");
}

export async function encryptString(plain: string, configKey: string | undefined): Promise<string> {
  const key = parseKey(configKey);
  if (!key) return "plain:" + plain; // plaintext marker when no key
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const pt = new TextEncoder().encode(plain);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, pt));
  // concat iv + ciphertext(+tag)
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return "enc:" + bytesToBase64(out);
}

export async function decryptString(stored: string, configKey: string | undefined): Promise<string> {
  if (stored.startsWith("plain:")) return stored.slice("plain:".length);
  if (!stored.startsWith("enc:")) return stored; // legacy/unencrypted
  const key = parseKey(configKey);
  if (!key) throw new Error("encrypted credential present but CONFIG_KEY not set");
  const buf = base64ToBytes(stored.slice("enc:".length));
  const iv = buf.subarray(0, IV_LEN);
  const ct = buf.subarray(IV_LEN);
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["decrypt"]);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ct));
  return new TextDecoder().decode(pt);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
