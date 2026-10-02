#!/usr/bin/env node
/**
 * bump-version.ts
 *
 * Atomically updates every workspace package.json whose version matches the
 * current root version, plus the info.version field in the OpenAPI spec.
 *
 * "Atomic" here means: all files are read and their new content is computed
 * in memory first; writes only start after every file has been validated.
 * If any write fails the script immediately restores every already-written
 * file from its in-memory original and exits non-zero.
 *
 * Usage:
 *   pnpm version:bump <new-version>
 *   pnpm version:bump 1.2.3
 */

import {
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

// ── semver ────────────────────────────────────────────────────────────────────
//
// Canonical regex from https://semver.org/#is-there-a-suggested-regexp-to-check-a-semver-string
// (with anchors).  Key constraints it enforces that a naïve regex would miss:
//   • No leading zeros in numeric identifiers (01.2.3 is invalid)
//   • No leading zeros in numeric prerelease segments (1.2.3-01 is invalid)
//   • Prerelease identifiers that are purely numeric must not have leading zeros
//   • Identifiers may only contain [0-9A-Za-z-]; no underscores
//
// ── types ─────────────────────────────────────────────────────────────────────

export interface FileUpdate {
  /** Absolute path to the file */
  path: string;
  /** Human-readable label for output */
  label: string;
  /** Original content (used for rollback) */
  original: string;
  /** Content to write */
  next: string;
  /** Version that was present before the bump */
  prevVersion: string;
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns the canonical SemVer regex from https://semver.org/#is-there-a-suggested-regexp-to-check-a-semver-string
 *
 * Key guarantees:
 *  - Major/minor/patch must not have leading zeros (rejects 01.2.3)
 *  - Purely-numeric prerelease identifiers must not have leading zeros (rejects 1.2.3-01)
 *  - Identifiers are [0-9A-Za-z-] only — no underscores
 *  - Build metadata is [0-9A-Za-z-]+ dot-separated
 */
export function semverRe(): RegExp {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
}

export function die(msg: string): never {
  console.error(`\n✗ bump-version: ${msg}\n`);
  process.exit(1);
}

/** Read a file, dying loudly if it cannot be read. */
export function readFile(filePath: string): string {
  try {
    return readFileSync(filePath, "utf-8");
  } catch (err) {
    die(`Cannot read ${filePath}: ${(err as Error).message}`);
  }
}

/**
 * Write content to a file atomically via a temp-file + rename strategy:
 *  1. Write to `<path>.bump-tmp`
 *  2. Rename to `<path>` (rename is atomic on POSIX within the same filesystem)
 *
 * This guarantees the target is either fully replaced or untouched — a crash
 * or ENOSPC during the write leaves the original intact and the tmp file
 * behind (which is cleaned up on the next attempt).
 *
 * Throws (does not call die) so callers can handle the error and rollback.
 */
export function writeFile(filePath: string, content: string): void {
  const tmp = `${filePath}.bump-tmp`;
  try {
    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, filePath);
  } catch (err) {
    // Best-effort cleanup of the temp file; ignore errors from unlink.
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err; // re-throw so commitUpdates can rollback
  }
}

/** Parse JSON, dying loudly if it fails. */
export function parseJson(
  filePath: string,
  content: string
): Record<string, unknown> {
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch (err) {
    die(`Cannot parse ${filePath}: ${(err as Error).message}`);
  }
}

/**
 * Produce updated content for a package.json, preserving all other fields and
 * the trailing newline that editors / git hooks expect.
 */
export function patchPackageJson(
  filePath: string,
  content: string,
  newVersion: string
): { next: string; prevVersion: string } {
  const data = parseJson(filePath, content);
  const prevVersion = String(data.version ?? "(none)");
  data.version = newVersion;
  return { next: JSON.stringify(data, null, 2) + "\n", prevVersion };
}

/**
 * Pattern that matches a YAML `version:` line with its surrounding whitespace
 * captured so we can reconstruct the line exactly.
 * Group 1: leading whitespace + "version: "
 * Group 2: the version value (no surrounding quotes)
 * Group 3: any trailing whitespace / line ending
 */
export const OPENAPI_VERSION_LINE_RE = /^(\s*version:\s*)(\S+)([ \t]*)$/;

/**
 * Produce updated content for an OpenAPI YAML file.
 *
 * Structural location strategy — avoids the "first version: anywhere" hazard:
 *  1. Split content into lines.
 *  2. Find the root-level `info:` key (no leading spaces, first occurrence).
 *  3. Scan forward from there; collect lines that belong to the `info:` block
 *     (i.e. lines that are blank or indented relative to `info:`).
 *  4. Within that range, find the first `version:` line and replace it.
 *
 * This approach is insensitive to the order of top-level keys, so a document
 * where `paths` (or any other section) appears before `info:` will still
 * correctly update only `info.version`.
 */
export function patchOpenApiYaml(
  filePath: string,
  content: string,
  newVersion: string
): { next: string; prevVersion: string } {
  const lines = content.split("\n");

  // Step 1: locate the `info:` root-level key
  const infoLineIdx = lines.findIndex((l) => /^info\s*:/.test(l));
  if (infoLineIdx === -1) {
    die(
      `Cannot find root-level "info:" key in ${filePath}. ` +
        `Is this a valid OpenAPI document?`
    );
  }

  // Step 2: determine the indentation of a child key under `info:`.
  // Peek at the first non-blank line after `info:` to learn the block indent.
  let blockIndent = 2; // default
  for (let i = infoLineIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") continue;
    const m = /^(\s+)\S/.exec(l);
    if (m) {
      blockIndent = m[1].length;
    }
    break;
  }

  // Step 3: scan forward within the info block for `version:`
  // The block ends when we hit a non-blank line indented less than blockIndent
  // (i.e. a new root-level or shallower key).
  // We only match `version:` at EXACTLY blockIndent spaces — not at any deeper
  // nesting — so that keys like `info.contact.version` (indented more than
  // blockIndent) are ignored and only the direct `info.version` child is found.
  let versionLineIdx = -1;
  for (let i = infoLineIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") continue; // blank lines are fine inside a block
    const indent = l.match(/^(\s*)/)?.[1]?.length ?? 0;
    if (indent < blockIndent) break; // left the info block
    // Only consider direct children of info: (exactly blockIndent spaces)
    if (indent === blockIndent && OPENAPI_VERSION_LINE_RE.test(l)) {
      versionLineIdx = i;
      break;
    }
  }

  if (versionLineIdx === -1) {
    die(
      `Cannot find "version:" inside the "info:" block in ${filePath}. ` +
        `Ensure info.version is present in the OpenAPI document.`
    );
  }

  const original = lines[versionLineIdx];
  const m = OPENAPI_VERSION_LINE_RE.exec(original)!;
  const prevVersion = m[2];
  lines[versionLineIdx] = `${m[1]}${newVersion}${m[3]}`;

  return { next: lines.join("\n"), prevVersion };
}

// ── discovery ─────────────────────────────────────────────────────────────────

const EXCLUDED_DIRS = new Set(["node_modules", ".git", ".local", "dist"]);

/**
 * Walk `dir` and collect paths of all package.json files, excluding any
 * directory listed in EXCLUDED_DIRS.
 */
export function findPackageJsonFiles(dir: string): string[] {
  const results: string[] = [];

  function walk(current: string): void {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      const full = join(current, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (entry === "package.json") {
        results.push(full);
      }
    }
  }

  walk(dir);
  return results.sort();
}

// ── core logic ─────────────────────────────────────────────────────────────────

/**
 * Build the complete list of FileUpdate objects for a version bump.
 *
 * Only package.json files whose current version matches `rootVersion` are
 * included (the "release set"). Files with a different version — such as
 * internal libraries pinned at 0.0.0 or design sandboxes at their own
 * version — are skipped and logged.
 *
 * The OpenAPI spec is always included when its current version matches
 * rootVersion.
 *
 * @param workspaceRoot  Absolute path to the monorepo root
 * @param newVersion     Target semver string
 * @returns              List of updates to apply (none written yet)
 */
export function buildUpdates(
  workspaceRoot: string,
  newVersion: string
): { updates: FileUpdate[]; skipped: Array<{ path: string; version: string }> } {
  // --- read root package.json to learn the current release version ---
  const rootPkgPath = resolve(workspaceRoot, "package.json");
  const rootContent = readFile(rootPkgPath);
  const rootData = parseJson(rootPkgPath, rootContent);
  const rootVersion = String(rootData.version ?? "");

  if (!rootVersion) {
    die(`Root package.json has no version field.`);
  }

  const updates: FileUpdate[] = [];
  const skipped: Array<{ path: string; version: string }> = [];

  // --- collect all workspace package.json files ---
  const allPkgFiles = findPackageJsonFiles(workspaceRoot);

  for (const pkgPath of allPkgFiles) {
    const content = readFile(pkgPath);
    const data = parseJson(pkgPath, content);
    const currentVersion = String(data.version ?? "");

    // Skip packages without a version field — they are not versioned manifests
    if (!currentVersion || currentVersion === "(none)") continue;

    if (currentVersion !== rootVersion) {
      skipped.push({ path: pkgPath, version: currentVersion });
      continue;
    }

    const { next, prevVersion } = patchPackageJson(pkgPath, content, newVersion);
    const label = pkgPath.replace(workspaceRoot + "/", "");
    updates.push({ path: pkgPath, label, original: content, next, prevVersion });
  }

  // --- OpenAPI spec ---
  const openApiPath = resolve(workspaceRoot, "lib/api-spec/openapi.yaml");
  const openApiContent = readFile(openApiPath);
  const { next: openApiNext, prevVersion: openApiPrev } = patchOpenApiYaml(
    openApiPath,
    openApiContent,
    newVersion
  );

  if (openApiPrev !== rootVersion) {
    skipped.push({ path: openApiPath, version: openApiPrev });
  } else {
    updates.push({
      path: openApiPath,
      label: "lib/api-spec/openapi.yaml",
      original: openApiContent,
      next: openApiNext,
      prevVersion: openApiPrev,
    });
  }

  return { updates, skipped };
}

/**
 * Write all updates atomically: commit every file, rolling back already-written
 * files if any write fails.
 *
 * Per-file atomicity is provided by `writeFile` (temp-file + rename): if the
 * write to a `.bump-tmp` file fails (e.g. ENOSPC), the target is untouched and
 * the temp file is cleaned up.  The current target is therefore always either
 * fully replaced or untouched — never partially written.
 *
 * If a failure occurs mid-way through the list, every file that has already
 * been successfully renamed is restored from its in-memory `original`.
 *
 * Throws an Error (never calls die/process.exit) so callers — including tests —
 * can handle or assert on the failure.  The main entry point catches and calls
 * die() to print the message and exit.
 */
export function commitUpdates(updates: FileUpdate[]): void {
  const written: FileUpdate[] = [];

  for (const update of updates) {
    try {
      writeFile(update.path, update.next);
      written.push(update);
    } catch (err) {
      // The current target's original is already safe (temp+rename above).
      // Rollback every file that was successfully renamed before this one.
      const rollbackErrors: string[] = [];
      for (const w of written) {
        try {
          writeFile(w.path, w.original);
        } catch (rbErr) {
          rollbackErrors.push(`  - ${w.path}: ${(rbErr as Error).message}`);
        }
      }

      let msg =
        `Failed to write ${update.path}: ${(err as Error).message}\n` +
        `Rolled back ${written.length} already-written file(s) to their original content.`;
      if (rollbackErrors.length) {
        msg += `\n\nRollback also failed for:\n${rollbackErrors.join("\n")}`;
        msg +=
          `\n\nThese files may be in an inconsistent state — restore them from version control.`;
      }
      throw new Error(msg);
    }
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

// Only run when executed directly (not when imported by tests)
if (process.argv[1] && !process.argv[1].endsWith(".test.ts")) {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const newVersion = args[0];

  if (!newVersion) {
    die(
      "No version supplied.\n" +
        "Usage: pnpm version:bump <new-version>\n" +
        "  e.g.  pnpm version:bump 1.2.3"
    );
  }

  if (!semverRe().test(newVersion)) {
    die(
      `"${newVersion}" is not a valid semver string ` +
        `(expected e.g. 1.2.3 or 1.2.3-beta.1).`
    );
  }

  const workspaceRoot = resolve(import.meta.dirname, "../..");

  // Phase 1: read all files and compute new content — no writes yet
  const { updates, skipped } = buildUpdates(workspaceRoot, newVersion);

  if (updates.length === 0) {
    die(
      `No files matched the current root version. ` +
        `Is root package.json already at ${newVersion}?`
    );
  }

  // Phase 2: write all files atomically
  try {
    commitUpdates(updates);
  } catch (err) {
    die((err as Error).message);
  }

  // Report
  console.log(`\nBumping version → ${newVersion}\n`);
  for (const u of updates) {
    console.log(`  ✓  ${u.label.padEnd(40)} ${u.prevVersion} → ${newVersion}`);
  }

  if (skipped.length > 0) {
    console.log(
      `\n  (skipped — version differs from root, not part of release set)`
    );
    for (const s of skipped) {
      const rel = s.path.replace(workspaceRoot + "/", "");
      console.log(`       ${rel.padEnd(40)} ${s.version}`);
    }
  }

  console.log(`\nAll release files updated to ${newVersion}. ✓\n`);
}
