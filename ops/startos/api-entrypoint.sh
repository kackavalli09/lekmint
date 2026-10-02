#!/bin/sh
set +x
set -eu
case "${MINT_OPERATION_MODE:-standby}" in
  active|standby|maintenance) ;;
  *) echo "Invalid operation mode" >&2; exit 1 ;;
esac
export MINT_OPERATION_MODE="${MINT_OPERATION_MODE:-standby}"
# Node reads mounted files without trimming: SESSION_SECRET bytes must match.
# File paths, not credentials, are passed in process arguments.
exec node --input-type=module -e '
import fs from "node:fs";
import { spawn } from "node:child_process";
for (const name of ["DATABASE_URL", "SESSION_SECRET", "ADMIN_API_KEY"]) {
  const path = process.env[name + "_FILE"];
  if (!path || process.env[name]) throw new Error("Use protected " + name + "_FILE, not environment credentials");
  const st = fs.lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077)) throw new Error("Credential file permissions invalid");
  process.env[name] = fs.readFileSync(path, "utf8");
  if (!process.env[name]) throw new Error("Credential file must contain exact original value");
}
const child = spawn(process.execPath, ["--enable-source-maps", "/app/dist/index.mjs"], { stdio: "inherit", env: process.env });
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
child.on("error", () => { console.error("API process could not start"); process.exit(1); });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
'