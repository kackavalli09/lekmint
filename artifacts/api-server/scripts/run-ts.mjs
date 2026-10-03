// Bundle-and-run helper for one-off TypeScript scripts in this package
// (migrations, e2e tests). Usage: node scripts/run-ts.mjs <script.ts> [args...]
import { build as esbuild } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const artifactDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const entry = process.argv[2];
if (!entry) {
  console.error("Usage: node scripts/run-ts.mjs <script.ts> [args...]");
  process.exit(1);
}

const outDir = mkdtempSync(path.join(tmpdir(), "api-server-script-"));
const outFile = path.join(outDir, "script.mjs");
copyFileSync(path.join(artifactDir, "assets/wallet-icon.png"), path.join(outDir, "wallet-icon.png"));

await esbuild({
  entryPoints: [path.resolve(artifactDir, entry)],
  platform: "node",
  bundle: true,
  format: "esm",
  outfile: outFile,
  logLevel: "silent",
  external: ["pg-native"],
  banner: {
    js: "import { createRequire as __scriptCreateRequire } from 'node:module'; const require = __scriptCreateRequire(import.meta.url);",
  },
});

const child = spawn(process.execPath, ["--enable-source-maps", outFile, ...process.argv.slice(3)], {
  stdio: "inherit",
  cwd: artifactDir,
});
child.on("exit", (code) => process.exit(code ?? 1));
