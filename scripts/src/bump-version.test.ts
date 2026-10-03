/**
 * bump-version.test.ts
 *
 * Tests for the version-bump script. Uses Node's built-in test runner
 * (available since Node 18) so no extra test-framework dependency is needed.
 *
 * Run: pnpm --filter @workspace/scripts run test:bump
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import {
  buildUpdates,
  commitUpdates,
  patchOpenApiYaml,
  patchPackageJson,
  semverRe,
  OPENAPI_VERSION_LINE_RE,
} from "./bump-version.js";

// ── tiny helpers ──────────────────────────────────────────────────────────────

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bump-version-test-"));
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/** Build a minimal workspace tree for integration tests. */
function makeWorkspace(
  root: string,
  opts: {
    rootVersion: string;
    artifacts?: Record<string, string>; // name → version
    libs?: Record<string, string>;
    openApiVersion?: string;
  }
): void {
  // root package.json
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "workspace", version: opts.rootVersion }, null, 2) +
      "\n"
  );

  // artifacts
  const artifactsDir = join(root, "artifacts");
  for (const [name, version] of Object.entries(opts.artifacts ?? {})) {
    const dir = join(artifactsDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        { name: `@workspace/${name}`, version, private: true },
        null,
        2
      ) + "\n"
    );
  }

  // lib packages
  const libDir = join(root, "lib");
  for (const [name, version] of Object.entries(opts.libs ?? {})) {
    const dir = join(libDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        { name: `@workspace/${name}`, version, private: true },
        null,
        2
      ) + "\n"
    );
  }

  // openapi.yaml
  if (opts.openApiVersion !== undefined) {
    const specDir = join(root, "lib", "api-spec");
    mkdirSync(specDir, { recursive: true });
    // Also write the lib/api-spec/package.json so it doesn't confuse the walker
    writeFileSync(
      join(specDir, "package.json"),
      JSON.stringify(
        { name: "@workspace/api-spec", version: opts.rootVersion, private: true },
        null,
        2
      ) + "\n"
    );
    const yaml = [
      "openapi: 3.1.0",
      "info:",
      `  version: ${opts.openApiVersion}`,
      "  title: Api",
    ].join("\n");
    writeFileSync(join(specDir, "openapi.yaml"), yaml);
  }
}

// ── unit: semver regex ────────────────────────────────────────────────────────

test("semverRe accepts valid semver strings", () => {
  const re = semverRe();
  // plain releases
  assert.ok(re.test("1.0.0"), "1.0.0");
  assert.ok(re.test("0.1.2"), "0.1.2");
  assert.ok(re.test("10.20.30"), "10.20.30");
  // prerelease — alphanumeric identifiers (may start with digit)
  assert.ok(re.test("1.2.3-beta.1"), "beta.1");
  assert.ok(re.test("1.2.3-alpha-1"), "alpha-1 (hyphen in identifier)");
  assert.ok(re.test("1.2.3-rc.1"), "rc.1");
  assert.ok(re.test("1.2.3-0"), "numeric prerelease 0 has no leading zero");
  assert.ok(re.test("1.2.3-x.7.z.92"), "multiple dot-separated identifiers");
  // build metadata
  assert.ok(re.test("1.2.3+build.42"), "build metadata");
  assert.ok(re.test("1.2.3-rc.1+sha.abc"), "prerelease + build metadata");
  assert.ok(re.test("1.2.3+001"), "purely-numeric build metadata (allowed)");
});

test("semverRe rejects invalid semver strings", () => {
  const re = semverRe();
  // too few parts
  assert.ok(!re.test("1.0"), "only two parts");
  assert.ok(!re.test("1"), "single number");
  // leading zeros in numeric segments (spec §2)
  assert.ok(!re.test("01.2.3"), "leading zero in major");
  assert.ok(!re.test("1.02.3"), "leading zero in minor");
  assert.ok(!re.test("1.2.03"), "leading zero in patch");
  // leading zeros in purely-numeric prerelease identifiers
  assert.ok(!re.test("1.2.3-01"), "leading zero in numeric prerelease id");
  // underscores not allowed in identifiers
  assert.ok(!re.test("1.2.3-alpha_1"), "underscore in prerelease");
  // v-prefix not allowed
  assert.ok(!re.test("v1.2.3"), "v-prefix");
  // garbage
  assert.ok(!re.test("bad-version"), "non-numeric");
  assert.ok(!re.test(""), "empty string");
  assert.ok(!re.test("1.2.3.4"), "four parts");
});

// ── unit: patchPackageJson ────────────────────────────────────────────────────

test("patchPackageJson replaces version and preserves other fields", () => {
  const original = JSON.stringify(
    { name: "@workspace/foo", version: "1.0.0", private: true },
    null,
    2
  );
  const { next, prevVersion } = patchPackageJson(
    "/fake/package.json",
    original,
    "2.0.0"
  );
  const parsed = JSON.parse(next);
  assert.equal(prevVersion, "1.0.0");
  assert.equal(parsed.version, "2.0.0");
  assert.equal(parsed.name, "@workspace/foo");
  assert.equal(parsed.private, true);
});

test("patchPackageJson adds trailing newline", () => {
  const original = JSON.stringify({ name: "x", version: "1.0.0" }, null, 2);
  const { next } = patchPackageJson("/fake/package.json", original, "2.0.0");
  assert.ok(next.endsWith("\n"));
});

// ── unit: patchOpenApiYaml ────────────────────────────────────────────────────

test("patchOpenApiYaml replaces info.version", () => {
  const yaml = [
    "openapi: 3.1.0",
    "info:",
    "  version: 1.0.0",
    "  title: Api",
  ].join("\n");
  const { next, prevVersion } = patchOpenApiYaml("/fake/openapi.yaml", yaml, "2.3.4");
  assert.equal(prevVersion, "1.0.0");
  assert.ok(next.includes("  version: 2.3.4"));
  assert.ok(!next.includes("  version: 1.0.0"));
});

test("patchOpenApiYaml preserves content around the version line", () => {
  const yaml = [
    "openapi: 3.1.0",
    "info:",
    "  version: 1.1.0",
    "  title: My API",
    "  description: Something",
  ].join("\n");
  const { next } = patchOpenApiYaml("/fake/openapi.yaml", yaml, "9.9.9");
  assert.ok(next.includes("openapi: 3.1.0"));
  assert.ok(next.includes("  title: My API"));
  assert.ok(next.includes("  description: Something"));
});

test("OPENAPI_VERSION_LINE_RE is exported and matches correctly", () => {
  const line = "  version: 1.2.3";
  const m = OPENAPI_VERSION_LINE_RE.exec(line);
  assert.ok(m, "regex should match");
  assert.equal(m![2], "1.2.3");
});

test("patchOpenApiYaml targets info.version even when another version: key precedes info:", () => {
  // A hypothetical extension that puts a version: key before info:
  const yaml = [
    "openapi: 3.1.0",
    "x-custom-section:",
    "  version: 0.0.0",   // ← root-level decoy before info: — must NOT be replaced
    "info:",
    "  version: 1.1.0",   // ← real target
    "  title: Api",
  ].join("\n");

  const { next, prevVersion } = patchOpenApiYaml("/fake/openapi.yaml", yaml, "2.0.0");

  assert.equal(prevVersion, "1.1.0", "prevVersion should be the info.version value");
  // The decoy must be unchanged
  assert.ok(next.includes("  version: 0.0.0"), "root-level decoy version must be untouched");
  // info.version must be updated
  assert.ok(
    next.includes("  version: 2.0.0") && !next.includes("  version: 1.1.0"),
    "info.version should be updated"
  );
});

test("patchOpenApiYaml ignores nested version: keys inside info: sub-objects", () => {
  // info.contact.version is nested deeper than info: direct children
  const yaml = [
    "openapi: 3.1.0",
    "info:",
    "  title: Api",
    "  contact:",
    "    name: support",
    "    version: 9.9.9",   // ← nested decoy inside info.contact — must NOT be replaced
    "  version: 1.1.0",     // ← real target (info.version, direct child)
  ].join("\n");

  const { next, prevVersion } = patchOpenApiYaml("/fake/openapi.yaml", yaml, "2.0.0");

  assert.equal(prevVersion, "1.1.0", "prevVersion should be info.version, not the nested one");
  // The nested decoy must be unchanged
  assert.ok(next.includes("    version: 9.9.9"), "nested decoy must be untouched");
  // The real info.version must be updated
  assert.ok(next.includes("  version: 2.0.0"), "info.version should be updated");
  assert.ok(!next.includes("  version: 1.1.0"), "old info.version should be gone");
});

// ── integration: buildUpdates ─────────────────────────────────────────────────

test("buildUpdates includes all release-version packages and openapi.yaml", () => {
  const root = tempDir();
  try {
    makeWorkspace(root, {
      rootVersion: "1.1.0",
      artifacts: {
        "api-server": "1.1.0",
        "admin-dashboard": "1.1.0",
        "lek-mint": "1.1.0",
      },
      openApiVersion: "1.1.0",
    });

    const { updates, skipped } = buildUpdates(root, "2.0.0");
    // root + 3 artifacts + 1 lib/api-spec + openapi.yaml = 6
    assert.equal(updates.length, 6);
    assert.equal(skipped.length, 0);

    for (const u of updates) {
      assert.equal(u.prevVersion, "1.1.0");
    }
  } finally {
    cleanup(root);
  }
});

test("buildUpdates skips packages whose version differs from root", () => {
  const root = tempDir();
  try {
    makeWorkspace(root, {
      rootVersion: "1.1.0",
      artifacts: {
        "api-server": "1.1.0",
        "mockup-sandbox": "2.0.0", // design artifact — different version
      },
      libs: {
        db: "0.0.0", // internal lib — different version
      },
      openApiVersion: "1.1.0",
    });

    const { updates, skipped } = buildUpdates(root, "1.2.0");

    const updatedLabels = updates.map((u) =>
      u.path.replace(root + "/", "")
    );
    assert.ok(
      updatedLabels.some((l) => l.includes("api-server")),
      "api-server should be updated"
    );
    assert.ok(
      !updatedLabels.some((l) => l.includes("mockup-sandbox")),
      "mockup-sandbox should be skipped"
    );

    const skippedPaths = skipped.map((s) => s.path.replace(root + "/", ""));
    assert.ok(
      skippedPaths.some((p) => p.includes("mockup-sandbox")),
      "mockup-sandbox should appear in skipped"
    );
    assert.ok(
      skippedPaths.some((p) => p.includes("lib/db")),
      "lib/db should appear in skipped"
    );
  } finally {
    cleanup(root);
  }
});

test("buildUpdates skips openapi.yaml when its version differs from root", () => {
  const root = tempDir();
  try {
    makeWorkspace(root, {
      rootVersion: "1.1.0",
      artifacts: { "api-server": "1.1.0" },
      openApiVersion: "0.9.0", // drifted
    });

    const { updates, skipped } = buildUpdates(root, "1.2.0");

    const updatedLabels = updates.map((u) => u.label);
    assert.ok(
      !updatedLabels.includes("lib/api-spec/openapi.yaml"),
      "drifted openapi.yaml should be skipped"
    );
    assert.ok(
      skipped.some((s) => s.path.includes("openapi.yaml")),
      "drifted openapi.yaml should appear in skipped"
    );
  } finally {
    cleanup(root);
  }
});

// ── integration: commitUpdates atomicity & rollback ───────────────────────────

test("commitUpdates writes all files on success", () => {
  const root = tempDir();
  try {
    makeWorkspace(root, {
      rootVersion: "1.0.0",
      artifacts: { "api-server": "1.0.0" },
      openApiVersion: "1.0.0",
    });

    const { updates } = buildUpdates(root, "1.1.0");
    assert.ok(updates.length > 0);

    commitUpdates(updates);

    // Verify every file was updated
    for (const u of updates) {
      const written = readFileSync(u.path, "utf-8");
      assert.equal(
        written,
        u.next,
        `${u.label} should contain the new content`
      );
    }
  } finally {
    cleanup(root);
  }
});

test("commitUpdates rolls back already-written files when a write fails", () => {
  const root = tempDir();
  try {
    makeWorkspace(root, {
      rootVersion: "1.0.0",
      artifacts: {
        "api-server": "1.0.0",
        "admin-dashboard": "1.0.0",
      },
      openApiVersion: "1.0.0",
    });

    const { updates } = buildUpdates(root, "1.1.0");
    assert.ok(updates.length >= 2, "need at least 2 updates to test rollback");

    // Save originals before any writes
    const originals = new Map(updates.map((u) => [u.path, u.original]));

    // Patch the second update to have an invalid (non-existent directory) path
    // so the write will fail after the first write has already succeeded.
    const patchedUpdates = updates.map((u, i) => {
      if (i === 1) {
        return {
          ...u,
          path: join(root, "nonexistent-dir", "package.json"),
        };
      }
      return u;
    });

    // commitUpdates should throw (not process.exit) and roll back the first file
    assert.throws(
      () => commitUpdates(patchedUpdates),
      (err: unknown) => {
        assert.ok(err instanceof Error, "should throw an Error");
        assert.ok(
          err.message.includes("Rolled back"),
          "error message should mention rollback"
        );
        return true;
      }
    );

    // The first file must have been restored to its original content
    const firstPath = updates[0].path;
    const afterFailure = readFileSync(firstPath, "utf-8");
    assert.equal(
      afterFailure,
      originals.get(firstPath),
      "first file should be rolled back to its original content"
    );

    // None of the files should be at the new version
    for (const u of updates) {
      const content = readFileSync(u.path, "utf-8");
      assert.notEqual(
        content,
        u.next,
        `${u.label} should not have the new version after rollback`
      );
    }
  } finally {
    cleanup(root);
  }
});

// ── integration: full pipeline ────────────────────────────────────────────────

test("full pipeline: buildUpdates → commitUpdates produces correct versions", () => {
  const root = tempDir();
  try {
    makeWorkspace(root, {
      rootVersion: "1.1.0",
      artifacts: {
        "api-server": "1.1.0",
        "admin-dashboard": "1.1.0",
        "lek-mint": "1.1.0",
      },
      openApiVersion: "1.1.0",
    });

    const { updates } = buildUpdates(root, "1.2.0");
    commitUpdates(updates);

    const { updates: verify } = buildUpdates(root, "1.3.0");
    for (const u of verify) {
      assert.equal(
        u.prevVersion,
        "1.2.0",
        `${u.label} should now be at 1.2.0`
      );
    }
  } finally {
    cleanup(root);
  }
});

test("full pipeline: coverage — all target files exist in a real workspace", () => {
  // This test runs against the actual workspace to confirm the real targets
  // are discovered and have matching versions.
  const workspaceRoot = resolve(import.meta.dirname, "../..");

  const { updates } = buildUpdates(workspaceRoot, "9999.0.0-dry-run");

  const labels = updates.map((u) => u.label);

  // Core release artifacts must always be present
  const required = [
    "package.json",
    "artifacts/api-server/package.json",
    "artifacts/admin-dashboard/package.json",
    "artifacts/lek-mint/package.json",
    "lib/api-spec/openapi.yaml",
  ];

  for (const req of required) {
    assert.ok(
      labels.some((l) => l.endsWith(req)),
      `Expected "${req}" in updates but only found: ${labels.join(", ")}`
    );
  }

  // No writes happen — this is just a dry run
});
