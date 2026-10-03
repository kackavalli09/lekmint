export type OperationMode = "active" | "standby" | "maintenance";

export function parseOperationMode(value: string | undefined): OperationMode {
  // Preserve existing installations. Recovery/package configurations explicitly
  // set standby; never rely on this default when restoring a database.
  if (value === undefined) return "active";
  if (value === "active" || value === "standby" || value === "maintenance") return value;
  throw new Error("MINT_OPERATION_MODE must be active, standby, or maintenance");
}

export const operationMode = parseOperationMode(process.env.MINT_OPERATION_MODE);
let initialized = false;
let draining = false;

export function markInitialized(): void {
  initialized = true;
}

export function markDraining(): void {
  draining = true;
}

export function isServingTransactions(): boolean {
  return operationMode === "active" && initialized && !draining;
}

export function isOperationalProbe(method: string, path: string): boolean {
  return (method === "GET" || method === "HEAD") &&
    /^\/(healthz|readyz)\/?$/i.test(path);
}

export function parseTrustProxy(value: string | undefined): number | string[] {
  if (value === undefined) return 1; // Existing Replit route has one proxy hop.
  if (/^(0|[1-9][0-9]?)$/.test(value)) return Number(value);
  const addresses = value.split(",").map((part) => part.trim());
  if (addresses.length === 0 || addresses.some((part) =>
    !part || /[\r\n]/.test(part) || part === "true" || part === "false")) {
    throw new Error("TRUST_PROXY must be a hop count or comma-separated trusted proxy addresses");
  }
  return addresses; // Express validates IP/CIDR entries when app.set is called.
}