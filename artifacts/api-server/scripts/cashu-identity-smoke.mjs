/**
 * Read-only smoke check for the externally visible Cashu mint identity.
 *
 * Safe for production: this script performs GET requests only.
 *
 * Run locally:
 *   API_BASE=http://127.0.0.1:8080/api node artifacts/api-server/scripts/cashu-identity-smoke.mjs
 *
 * Run after publishing:
 *   API_BASE=https://lekmint.cash/api node artifacts/api-server/scripts/cashu-identity-smoke.mjs
 */

const API_BASE = (process.env.API_BASE ?? "https://lekmint.cash/api").replace(/\/$/, "");
const EXPECTED_ICON_URL = "https://lekmint.cash/api/v1/icon-352e7e44.png";
const EXPECTED_CACHE_CONTROL = "public, max-age=31536000, immutable";
const MAX_ICON_BYTES = 16_384;

function assert(condition, label, detail) {
  if (!condition) {
    throw new Error(`${label}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  }
  console.log(`  PASS  ${label}`);
}

async function getJson(path) {
  const response = await fetch(`${API_BASE}${path}`);
  assert(response.ok, `GET ${path} returns success`, response.status);
  return response.json();
}

function readPngDimensions(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  assert(signature.every((byte, index) => bytes[index] === byte), "icon has a valid PNG signature");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const info = await getJson("/v1/info");
assert(info.name === "Lek Mint", "NUT-06 reports the Lek Mint name", info.name);
assert(info.icon_url === EXPECTED_ICON_URL, "NUT-06 reports the canonical HTTPS icon URL", info.icon_url);
const iconCheckUrl = API_BASE === "https://lekmint.cash/api"
  ? info.icon_url
  : `${API_BASE}/v1/icon-352e7e44.png`;

const [keys, keysets, iconResponse] = await Promise.all([
  getJson("/v1/keys"),
  getJson("/v1/keysets"),
  fetch(iconCheckUrl),
]);

assert(
  Array.isArray(keys.keysets) && keys.keysets.length > 0 &&
    keys.keysets.every((keyset) => keyset.unit === "lek"),
  "all NUT-01 keysets report unit lek",
);
assert(
  Array.isArray(keysets.keysets) && keysets.keysets.length > 0 &&
    keysets.keysets.every((keyset) => keyset.unit === "lek"),
  "all NUT-02 keysets report unit lek",
);
assert(iconResponse.ok, "canonical icon URL is publicly reachable", iconResponse.status);
assert(iconResponse.headers.get("content-type") === "image/png", "icon is served as image/png");
assert(
  iconResponse.headers.get("cache-control") === EXPECTED_CACHE_CONTROL,
  "icon has the immutable public cache policy",
  iconResponse.headers.get("cache-control"),
);

const iconBytes = new Uint8Array(await iconResponse.arrayBuffer());
assert(iconBytes.byteLength <= MAX_ICON_BYTES, "icon is no larger than 16 KiB", iconBytes.byteLength);
const dimensions = readPngDimensions(iconBytes);
assert(dimensions.width === 256 && dimensions.height === 256, "icon is square at 256×256", dimensions);

console.log(`\nCashu identity smoke check passed for ${API_BASE}.`);