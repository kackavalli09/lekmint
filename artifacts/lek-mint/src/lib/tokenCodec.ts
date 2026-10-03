import type { Proof } from "@workspace/api-client-react";

/**
 * Cashu token serialization (NUT-00).
 *
 * Encoding always emits V3 ("cashuA" + base64url JSON) — every wallet reads it.
 * Decoding accepts BOTH formats:
 *   V3: "cashuA" + base64url(JSON.stringify({ token: [{ mint, proofs }], unit, memo? }))
 *   V4: "cashuB" + base64url(CBOR({ m, u, d?, t: [{ i: bytes, p: [{ a, s, c: bytes }] }] }))
 * V4 is what modern external Cashu wallets produce; it is the same proofs in a
 * compact binary envelope, normalized here into the V3 shape.
 */

export interface TokenEntry {
  mint: string;
  proofs: Proof[];
}

export interface TokenV3 {
  token: TokenEntry[];
  unit: string;
  memo?: string;
}

const PREFIX_V3 = "cashuA";
const PREFIX_V4 = "cashuB";

function base64UrlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecodeBytes(encoded: string): Uint8Array {
  let b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlDecode(encoded: string): string {
  return new TextDecoder().decode(base64UrlDecodeBytes(encoded));
}

export function encodeToken(token: TokenV3): string {
  return PREFIX_V3 + base64UrlEncode(JSON.stringify(token));
}

export class TokenDecodeError extends Error {}

/** Sanity bounds for untrusted pasted tokens (largest real tokens are ~KBs). */
const MAX_TOKEN_CHARS = 1_000_000;
const MAX_PROOFS = 10_000;

export function decodeToken(raw: string): TokenV3 {
  const trimmed = raw.trim();
  if (trimmed.length > MAX_TOKEN_CHARS) {
    throw new TokenDecodeError("Token is too large to be a valid Cashu token");
  }
  if (trimmed.startsWith(PREFIX_V4)) {
    return decodeTokenV4(trimmed.slice(PREFIX_V4.length));
  }
  if (!trimmed.startsWith(PREFIX_V3)) {
    throw new TokenDecodeError(
      "Not a Cashu token (expected it to start with 'cashuA' or 'cashuB')",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(trimmed.slice(PREFIX_V3.length)));
  } catch {
    throw new TokenDecodeError("Token payload is not valid base64url JSON");
  }
  const token = parsed as TokenV3;
  if (!Array.isArray(token.token) || token.token.length === 0) {
    throw new TokenDecodeError("Token has no entries");
  }
  for (const entry of token.token) {
    if (typeof entry.mint !== "string" || !Array.isArray(entry.proofs)) {
      throw new TokenDecodeError("Malformed token entry");
    }
    for (const p of entry.proofs) {
      if (
        typeof p.id !== "string" ||
        typeof p.amount !== "number" ||
        typeof p.secret !== "string" ||
        typeof p.C !== "string"
      ) {
        throw new TokenDecodeError("Malformed proof in token");
      }
      // Carry the DLEQ blinding factor when present — it lets the mint match
      // this proof to the swap that issued it (escrowed appreciation claims).
      const dleq = (p as { dleq?: { r?: unknown } }).dleq;
      if (dleq && typeof dleq.r === "string" && /^[0-9a-fA-F]{64}$/.test(dleq.r)) {
        p.r = dleq.r.toLowerCase();
      }
    }
  }
  return token;
}

// ---------------------------------------------------------------------------
// Cashu V4 ("cashuB") decoding — CBOR envelope, normalized to the V3 shape.
// ---------------------------------------------------------------------------

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Minimal strict CBOR decoder covering everything a Cashu V4 token uses:
 * unsigned ints, byte strings, text strings, arrays, maps (text keys), and
 * the simple values false/true/null. Anything else (indefinite lengths,
 * floats, tags, negative ints) is rejected — malformed input can never
 * produce a token, only a clear decode error.
 */
function decodeCbor(bytes: Uint8Array): unknown {
  let pos = 0;

  function fail(msg: string): never {
    throw new TokenDecodeError(`Invalid V4 token: ${msg}`);
  }

  function readLength(info: number): number {
    if (info < 24) return info;
    let len = 0;
    let n: number;
    if (info === 24) n = 1;
    else if (info === 25) n = 2;
    else if (info === 26) n = 4;
    else if (info === 27) n = 8;
    else fail("unsupported (indefinite) length");
    if (pos + n > bytes.length) fail("truncated length");
    for (let i = 0; i < n; i++) {
      len = len * 256 + bytes[pos++]!;
    }
    if (!Number.isSafeInteger(len)) fail("length too large");
    return len;
  }

  function readItem(depth: number): unknown {
    if (depth > 16) fail("nesting too deep");
    if (pos >= bytes.length) fail("truncated");
    const initial = bytes[pos++]!;
    const major = initial >> 5;
    const info = initial & 0x1f;
    switch (major) {
      case 0: // unsigned int
        return readLength(info);
      case 2: { // byte string
        const len = readLength(info);
        if (pos + len > bytes.length) fail("truncated byte string");
        const out = bytes.slice(pos, pos + len);
        pos += len;
        return out;
      }
      case 3: { // text string
        const len = readLength(info);
        if (pos + len > bytes.length) fail("truncated text string");
        const out = new TextDecoder().decode(bytes.slice(pos, pos + len));
        pos += len;
        return out;
      }
      case 4: { // array
        const len = readLength(info);
        const arr: unknown[] = [];
        for (let i = 0; i < len; i++) arr.push(readItem(depth + 1));
        return arr;
      }
      case 5: { // map
        const len = readLength(info);
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < len; i++) {
          const key = readItem(depth + 1);
          if (typeof key !== "string") fail("non-text map key");
          obj[key] = readItem(depth + 1);
        }
        return obj;
      }
      case 6: // tag — read and ignore the tag number, decode the tagged item
        readLength(info);
        return readItem(depth + 1);
      case 7: // simple values
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        fail("unsupported simple/float value");
        break;
      default:
        fail(`unsupported CBOR major type ${major}`);
    }
  }

  const value = readItem(0);
  if (pos !== bytes.length) fail("trailing bytes after token");
  return value;
}

function decodeTokenV4(payload: string): TokenV3 {
  let root: unknown;
  try {
    root = decodeCbor(base64UrlDecodeBytes(payload));
  } catch (err) {
    if (err instanceof TokenDecodeError) {
      if (err.message.includes("truncated")) {
        throw new TokenDecodeError(
          "This token appears to be cut off — part of it is missing. Go back to the sending wallet and copy the entire token string, then paste it again.",
        );
      }
      throw err;
    }
    throw new TokenDecodeError("Token payload is not valid base64url CBOR");
  }
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    throw new TokenDecodeError("Invalid V4 token: expected a map");
  }
  const t = root as { m?: unknown; u?: unknown; d?: unknown; t?: unknown };
  if (typeof t.m !== "string" || typeof t.u !== "string" || !Array.isArray(t.t) || t.t.length === 0) {
    throw new TokenDecodeError("Invalid V4 token: missing mint, unit, or entries");
  }
  const proofs: Proof[] = [];
  for (const entryRaw of t.t) {
    const entry = entryRaw as { i?: unknown; p?: unknown };
    if (!(entry.i instanceof Uint8Array) || !Array.isArray(entry.p) || entry.p.length === 0) {
      throw new TokenDecodeError("Invalid V4 token: malformed keyset entry");
    }
    if (entry.i.length !== 8) {
      throw new TokenDecodeError("Invalid V4 token: keyset id must be 8 bytes");
    }
    const keysetId = bytesToHex(entry.i);
    for (const proofRaw of entry.p) {
      const p = proofRaw as { a?: unknown; s?: unknown; c?: unknown; d?: unknown };
      if (
        typeof p.a !== "number" || !Number.isSafeInteger(p.a) || p.a <= 0 ||
        typeof p.s !== "string" ||
        !(p.c instanceof Uint8Array)
      ) {
        throw new TokenDecodeError("Invalid V4 token: malformed proof");
      }
      // NUT-12 DLEQ block ({ e, s, r } as 32-byte strings). The blinding
      // factor r lets the mint link this proof to the swap that issued it,
      // which is how escrowed appreciation follows the token to its receiver.
      let r: string | undefined;
      const d = p.d as { r?: unknown } | undefined;
      if (d && d.r instanceof Uint8Array && d.r.length === 32) {
        r = bytesToHex(d.r);
      }
      proofs.push({ id: keysetId, amount: p.a, secret: p.s, C: bytesToHex(p.c), ...(r ? { r } : {}) });
      if (proofs.length > MAX_PROOFS) {
        throw new TokenDecodeError("Invalid V4 token: too many proofs");
      }
    }
  }
  return {
    token: [{ mint: t.m, proofs }],
    unit: t.u,
    ...(typeof t.d === "string" && t.d ? { memo: t.d } : {}),
  };
}

export function tokenAmount(token: TokenV3): number {
  return token.token.reduce(
    (sum, entry) => sum + entry.proofs.reduce((s, p) => s + p.amount, 0),
    0,
  );
}
