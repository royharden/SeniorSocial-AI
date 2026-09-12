/**
 * SEC-051-DISPOSITION / SEC-051-FROZEN-NOOP (security, layer L, rfp:T-15) —
 * package: WP-001
 *
 * Independent, attempt-2 extension of SEC-051 coverage (see
 * sec-051-postinstall-allowlist.test.ts for the original two assertions,
 * unchanged, kept as-is). This file is written from the specification —
 * 10-security.md line 235 ("an explicit `onlyBuiltDependencies` allowlist so
 * no transitive package runs a postinstall script"), 10-security.md's SEC-051
 * table row ("No postinstall script runs outside the `onlyBuiltDependencies`
 * allowlist"), 03-parallel-build-architecture.md s4.4's lockfile-diff-check
 * paragraph ("a merge that changes pnpm-lock.yaml without a corresponding
 * dependency change ... is a supply-chain surprise"), and pnpm 11's
 * documented build-script policy (every dependency that declares
 * preinstall/install/postinstall scripts must be explicitly listed in
 * `onlyBuiltDependencies` or `ignoredBuiltDependencies`, else a
 * `--frozen-lockfile` install exits 1 with ERR_PNPM_IGNORED_BUILDS) — never
 * from the builder's diff (this session does not read it; see the dispatch's
 * "attempt 2" note and known-hazards.md).
 *
 * what_bug_this_catches (updated per ADR-016, docs\decisions\ADR-016-sec-051-
 * control-is-allowbuilds.md — SEC-051's control on pnpm >= 11 is the
 * `allowBuilds` map, not `onlyBuiltDependencies`/`ignoredBuiltDependencies`,
 * which are non-authoritative mirrors): "A dependency with a preinstall/
 * install/postinstall script that has no explicit true/false entry in
 * pnpm-workspace.yaml's `allowBuilds` map fails a fresh frozen install in CI
 * and in the merge gauntlet, or worse, silently runs a script nobody
 * reviewed — and an empty (or absent) `onlyBuiltDependencies` list must
 * never be read as proof no such script can run, because `allowBuilds:
 * {X: true}` with no accompanying justification comment would run X's
 * script while that mirror list stayed empty."
 *
 * Reproduces exactly the class of bug the integrator hit
 * (planning\receipts\0147_..._WP-001.gauntlet-failed.json, 2026-09-10
 * 15:44:10Z): a fresh `pnpm install --offline --frozen-lockfile` on the
 * candidate exited 1 with "[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts:
 * esbuild@0.28.2" and the install additionally modified pnpm-workspace.yaml
 * on disk — a side effect a frozen, reviewed install must never have. The
 * original SEC-051 test passed only because node_modules already existed in
 * the builder's lane (so pnpm never recomputed a pending-builds list against
 * a truly fresh, empty node_modules) — it asserted the allowlist's *shape*
 * but never actually drove pnpm's own build-script gate the way CI does.
 *
 * --- Determinism sources, stated per the dispatch's requirement ---
 *
 * SOURCE A — "which installed packages declare a preinstall/install/
 * postinstall script": each installed package's own package.json, read
 * directly from node_modules\.pnpm\<pnpm-dir>\node_modules\<pkg>\package.json
 * (this workspace's .npmrc sets `node-linker=isolated`, confirmed live via
 * node_modules\.modules.yaml's `nodeLinker: "isolated"` /
 * `virtualStoreDir: ...\\node_modules\\.pnpm`). This is deterministic because
 * pnpm's isolated linker materializes exactly the packages pnpm-lock.yaml
 * resolves, under content-addressed folder names derived from name+version+
 * peer-resolution — re-running an install from the same lockfile on the same
 * platform reproduces the same set and the same package.json bytes; it is
 * not this test guessing, it is reading what pnpm itself put on disk from
 * the lockfile.
 *
 * SOURCE B — "which packages are dispositioned": pnpm-workspace.yaml's
 * `allowBuilds` map (ADR-016: the register pnpm >= 11 actually enforces —
 * every dependency with a lifecycle script needs an explicit `true`/`false`
 * entry there), read as raw text directly off disk (no YAML dependency; same
 * technique the original SEC-051 test uses for onlyBuiltDependencies alone).
 * `onlyBuiltDependencies` and `ignoredBuiltDependencies` are still read, but
 * only as non-authoritative mirrors reported for context — an empty or
 * absent `onlyBuiltDependencies` is never treated as evidence a package is
 * dispositioned; only a matching key in `allowBuilds` counts. Deterministic
 * because it is exactly the file pnpm itself reads to decide the policy.
 *
 * SOURCE C — "has anything outside the allowlist actually run or been left
 * pending": node_modules\.modules.yaml's `pendingBuilds` array (the file
 * has a `.yaml` extension but its content is JSON, confirmed live in this
 * worktree). `pendingBuilds` is pnpm's own computed record, written by pnpm
 * itself on every install, of build scripts it found declared but did NOT
 * run because they are not yet approved/ignored — it is exactly the
 * condition that produces ERR_PNPM_IGNORED_BUILDS, so a non-empty
 * `pendingBuilds` in the live worktree is direct, first-party evidence of
 * the same defect class the integrator hit, without this test needing to
 * re-run an install to observe it. Deterministic because pnpm recomputes it
 * from the lockfile + config, not from ambient state.
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  findRepoRoot,
  readPnpmWorkspaceYamlText,
  readRootPackageJson,
} from "../../fixtures/WP-001/repo-helpers";

const root = findRepoRoot();
const pkg = readRootPackageJson(root);
const workspaceYamlText = readPnpmWorkspaceYamlText(root);

/**
 * Extracts a YAML block-list or inline-array value under `<key>:` from raw
 * pnpm-workspace.yaml text. Generalized copy of the technique
 * sec-051-postinstall-allowlist.test.ts uses for onlyBuiltDependencies alone
 * — duplicated locally (not lifted into the shared fixture) so this
 * attempt-2 pass touches exactly one new file plus the catalog, per the
 * dispatch's "keep the existing assertions [byte-identical]" instruction.
 */
function extractYamlListKey(text: string, key: string): string[] | null {
  const lines = text.split(/\r?\n/);
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const startIdx = lines.findIndex((l) => new RegExp(`^\\s*${escapedKey}\\s*:`).test(l));
  if (startIdx === -1) return null;
  const inline = lines[startIdx].match(new RegExp(`${escapedKey}\\s*:\\s*\\[(.*)\\]`));
  if (inline) {
    return inline[1]
      .split(",")
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
  }
  const out: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s*-\s*(.+)$/);
    if (!m) break;
    out.push(m[1].trim().replace(/^['"]|['"]$/g, ""));
  }
  return out;
}

/**
 * Reads the two non-authoritative mirror lists (ADR-016 s2) for inclusion in
 * failure messages ONLY — never used to decide pass/fail. Kept so a failing
 * assertion can show whether the mirrors happen to agree or disagree with
 * the authoritative `allowBuilds` map, without ever treating an empty or
 * absent `onlyBuiltDependencies` as proof of anything.
 */
function getMirrorListNames(): Set<string> {
  const fromPackageJsonOnly = (pkg?.pnpm?.["onlyBuiltDependencies"] as string[] | undefined) ?? [];
  const fromPackageJsonIgnored =
    (pkg?.pnpm?.["ignoredBuiltDependencies"] as string[] | undefined) ?? [];
  const fromYamlOnly = workspaceYamlText
    ? extractYamlListKey(workspaceYamlText, "onlyBuiltDependencies") ?? []
    : [];
  const fromYamlIgnored = workspaceYamlText
    ? extractYamlListKey(workspaceYamlText, "ignoredBuiltDependencies") ?? []
    : [];
  return new Set([
    ...fromPackageJsonOnly,
    ...fromPackageJsonIgnored,
    ...fromYamlOnly,
    ...fromYamlIgnored,
  ]);
}

interface AllowBuildsEntry {
  value: boolean;
  /** True if the SAME line also carries a trailing `#` comment with content. */
  hasJustification: boolean;
}

/**
 * Extracts pnpm-workspace.yaml's `allowBuilds:` map — SEC-051's actual
 * control per ADR-016 (docs\decisions\ADR-016-sec-051-control-is-
 * allowbuilds.md): pnpm >= 11 aborts a frozen install with
 * ERR_PNPM_IGNORED_BUILDS unless every lifecycle-script dependency has an
 * explicit `true`/`false` entry HERE, regardless of what
 * onlyBuiltDependencies/ignoredBuiltDependencies say. Each entry records its
 * boolean value and whether that same line also carries a trailing `#`
 * comment — the "one-line justification comment beside it" ADR-016 requires
 * for every `true` entry.
 */
function extractYamlAllowBuilds(text: string): Map<string, AllowBuildsEntry> {
  const out = new Map<string, AllowBuildsEntry>();
  const lines = text.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => /^\s*allowBuilds\s*:\s*(\{.*\})?\s*$/.test(l));
  if (startIdx === -1) return out;

  // Inline map form: allowBuilds: { esbuild: false }
  const inlineMatch = lines[startIdx].match(/allowBuilds\s*:\s*\{(.*)\}\s*$/);
  if (inlineMatch) {
    for (const pair of inlineMatch[1].split(",")) {
      const m = pair.match(/['"]?([\w@/.\-]+)['"]?\s*:\s*(true|false)/);
      if (m) out.set(m[1], { value: m[2] === "true", hasJustification: false });
    }
    return out;
  }

  // Block map form:
  //   allowBuilds:
  //     esbuild: false   # optional trailing comment
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*$/.test(line)) continue; // blank line: keep scanning
    const entryMatch = line.match(/^\s{2,}(['"]?[\w@/.\-]+['"]?)\s*:\s*(true|false)\b(.*)$/);
    if (entryMatch) {
      const name = entryMatch[1].replace(/^['"]|['"]$/g, "");
      const value = entryMatch[2] === "true";
      const hasJustification = /#\s*\S/.test(entryMatch[3] ?? "");
      out.set(name, { value, hasJustification });
      continue;
    }
    if (/^\s{2,}#/.test(line)) continue; // indented comment inside the block: keep scanning
    // A line with no (or top-level) indentation ends the block — either the
    // next top-level key (e.g. ignoredBuiltDependencies:) or a top-level
    // comment introducing it.
    break;
  }
  return out;
}

function getAllowBuildsMap(): Map<string, AllowBuildsEntry> {
  const fromYaml = workspaceYamlText ? extractYamlAllowBuilds(workspaceYamlText) : new Map();
  const merged = new Map<string, AllowBuildsEntry>(fromYaml);
  const fromPackageJson =
    (pkg?.pnpm?.["allowBuilds"] as Record<string, boolean> | undefined) ?? {};
  for (const [name, value] of Object.entries(fromPackageJson)) {
    if (!merged.has(name)) merged.set(name, { value: Boolean(value), hasJustification: false });
  }
  return merged;
}

interface InstalledPkg {
  name: string;
  version: string;
  scripts: Record<string, string>;
}

/**
 * Walks node_modules\.pnpm\*\node_modules\** (one level, plus one more for a
 * scoped `@scope` folder) reading each package's own package.json — SOURCE A
 * above. Returns null if node_modules\.pnpm does not exist (nothing
 * installed yet; the caller reports that as an informative red rather than
 * throwing).
 */
async function collectInstalledPackages(
  repoRoot: string,
  readPackageJson: (canonicalPath: string) => Promise<string> = (canonicalPath) =>
    fs.promises.readFile(canonicalPath, "utf8"),
): Promise<Map<string, InstalledPkg> | null> {
  const pnpmDir = path.join(repoRoot, "node_modules", ".pnpm");
  if (!fs.existsSync(pnpmDir)) return null;
  const out = new Map<string, InstalledPkg>();

  const directPackageName = (virtualStoreDirName: string): string | null => {
    // pnpm's ordinary virtual-store directory is
    // `<name>@<version>...`, with `/` encoded as `+` for scoped packages.
    // Long peer-qualified names are hashed; those deliberately fall back to
    // the small directory scan below rather than trying to reverse pnpm's
    // truncation/hash algorithm.
    const versionSeparator = virtualStoreDirName.indexOf("@", 1);
    if (versionSeparator < 1) return null;
    const encodedName = virtualStoreDirName.slice(0, versionSeparator);
    if (!encodedName.startsWith("@")) return encodedName;
    const scopeSeparator = encodedName.indexOf("+");
    if (scopeSeparator < 2 || scopeSeparator === encodedName.length - 1) return null;
    return `${encodedName.slice(0, scopeSeparator)}/${encodedName.slice(scopeSeparator + 1)}`;
  };

  const directCandidates: Array<{ nmDir: string; packageJsonPath: string }> = [];
  const fallbackNodeModulesDirs: string[] = [];
  for (const topDir of fs.readdirSync(pnpmDir, { withFileTypes: true })) {
    if ((!topDir.isDirectory() && !topDir.isSymbolicLink()) || topDir.name === "node_modules") {
      continue;
    }
    const nmDir = path.join(pnpmDir, topDir.name, "node_modules");
    const directName = directPackageName(topDir.name);
    if (directName) {
      directCandidates.push({
        nmDir,
        packageJsonPath: path.join(nmDir, ...directName.split("/"), "package.json"),
      });
    } else {
      fallbackNodeModulesDirs.push(nmDir);
    }
  }

  // Resolve all ordinary virtual-store entries concurrently. On OneDrive,
  // serial realpath + read calls dominate the test budget even though every
  // package is independent. Resolution happens before reads so multiple
  // junctions to the same package.json collapse to one canonical read.
  const directResolved = await Promise.all(
    directCandidates.map(async ({ packageJsonPath }) => {
      try {
        return await fs.promises.realpath(packageJsonPath);
      } catch (error) {
        throw new Error(
          `Failed to resolve installed package manifest ${packageJsonPath}: ${String(error)}`,
        );
      }
    }),
  );

  const fallbackPackageJsonPaths: string[] = [];
  for (const nmDir of fallbackNodeModulesDirs) {
    // Only hashed/truncated or otherwise nonstandard virtual-store names reach
    // this fallback. Canonical-path deduplication below makes it safe to
    // inspect pnpm's dependency symlinks/junctions too: aliases are resolved
    // to the same manifest and read once.
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(nmDir, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Failed to inspect pnpm virtual-store directory ${nmDir}: ${String(error)}`);
    }
    for (const entry of entries) {
      if ((!entry.isDirectory() && !entry.isSymbolicLink()) || entry.name === ".bin") continue;
      const entryPath = path.join(nmDir, entry.name);
      if (entry.name.startsWith("@")) {
        let subEntries: fs.Dirent[];
        try {
          subEntries = fs.readdirSync(entryPath, { withFileTypes: true });
        } catch (error) {
          throw new Error(`Failed to inspect installed package scope ${entryPath}: ${String(error)}`);
        }
        for (const sub of subEntries) {
          if (sub.isDirectory() || sub.isSymbolicLink()) {
            fallbackPackageJsonPaths.push(path.join(entryPath, sub.name, "package.json"));
          }
        }
      } else {
        fallbackPackageJsonPaths.push(path.join(entryPath, "package.json"));
      }
    }
  }

  const fallbackResolved = await Promise.all(
    fallbackPackageJsonPaths.map(async (packageJsonPath) => {
      try {
        return await fs.promises.realpath(packageJsonPath);
      } catch (error) {
        throw new Error(
          `Failed to resolve installed package manifest ${packageJsonPath}: ${String(error)}`,
        );
      }
    }),
  );
  const canonicalPaths = new Set<string>();
  for (const canonicalPath of directResolved) canonicalPaths.add(canonicalPath);
  for (const canonicalPath of fallbackResolved) canonicalPaths.add(canonicalPath);

  const packageJsonDocuments = await Promise.all(
    [...canonicalPaths].map(async (canonicalPath) => {
      let document: string;
      try {
        document = await readPackageJson(canonicalPath);
      } catch (error) {
        throw new Error(
          `Failed to read installed package manifest ${canonicalPath}: ${String(error)}`,
        );
      }

      try {
        return JSON.parse(document) as unknown;
      } catch (error) {
        throw new Error(
          `Failed to parse installed package manifest ${canonicalPath}: ${String(error)}`,
        );
      }
    }),
  );
  for (const parsed of packageJsonDocuments) {
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("name" in parsed) ||
      typeof parsed.name !== "string" ||
      parsed.name.length === 0 ||
      !("version" in parsed) ||
      typeof parsed.version !== "string" ||
      parsed.version.length === 0
    ) {
      throw new Error("Installed package manifest is missing a non-empty name or version");
    }
    if (
      "scripts" in parsed &&
      (typeof parsed.scripts !== "object" || parsed.scripts === null || Array.isArray(parsed.scripts))
    ) {
      throw new Error(`Installed package manifest ${parsed.name}@${parsed.version} has invalid scripts`);
    }

    const scripts = Object.fromEntries(
      Object.entries(("scripts" in parsed ? parsed.scripts : {}) as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const key = `${parsed.name}@${parsed.version}`;
    if (!out.has(key)) {
      out.set(key, { name: parsed.name, version: parsed.version, scripts });
    }
  }
  return out;
}

const LIFECYCLE_SCRIPT_KEYS = ["preinstall", "install", "postinstall"] as const;

function findUndispositionedPackages(
  installed: Map<string, InstalledPkg>,
  allowBuilds: Map<string, AllowBuildsEntry>,
  mirrorNames: Set<string>,
): string[] {
  const undispositioned: string[] = [];
  for (const { name, version, scripts } of installed.values()) {
    const hasLifecycleScript = LIFECYCLE_SCRIPT_KEYS.some((k) => scripts[k]);
    if (!hasLifecycleScript) continue;
    if (!allowBuilds.has(name)) {
      undispositioned.push(
        `${name}@${version} (${LIFECYCLE_SCRIPT_KEYS.filter((k) => scripts[k]).join("/")})` +
          `${mirrorNames.has(name) ? " [present in onlyBuilt/ignoredBuiltDependencies mirror, but that is not authoritative]" : ""}`,
      );
    }
  }
  return undispositioned;
}

describe("SEC-051-DISPOSITION inventory traversal", () => {
  it("inspects every distinct package/version across scoped, hashed and duplicate-link pnpm layouts", async () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wp001-lifecycle-inventory-"));
    const virtualStore = path.join(fixtureRoot, "node_modules", ".pnpm");
    const duplicateLink = path.join(
      virtualStore,
      "duplicate@1.0.0_peer@1.0.0",
      "node_modules",
      "duplicate",
    );
    const duplicateVirtualStoreLink = path.join(
      virtualStore,
      "duplicate@1.0.0_linked@1.0.0",
    );
    const writePackage = (
      virtualDir: string,
      packageName: string,
      version: string,
      scripts: Record<string, string> = {},
    ) => {
      const packageDir = path.join(
        virtualStore,
        virtualDir,
        "node_modules",
        ...packageName.split("/"),
      );
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({ name: packageName, version, scripts }),
      );
      return packageDir;
    };

    try {
      const duplicateTarget = writePackage("duplicate@1.0.0", "duplicate", "1.0.0");
      writePackage("duplicate@2.0.0", "duplicate", "2.0.0");
      writePackage("@scope+ordinary@3.0.0", "@scope/ordinary", "3.0.0");
      writePackage("@scope+truncated_hash", "@scope/truncated-package", "4.0.0");
      writePackage("planted@9.9.9", "planted", "9.9.9", { postinstall: "node planted.js" });

      fs.mkdirSync(path.dirname(duplicateLink), { recursive: true });
      fs.symlinkSync(duplicateTarget, duplicateLink, "junction");
      fs.symlinkSync(
        path.join(virtualStore, "duplicate@1.0.0"),
        duplicateVirtualStoreLink,
        "junction",
      );

      const readCounts = new Map<string, number>();
      const installed = await collectInstalledPackages(fixtureRoot, async (canonicalPath) => {
        readCounts.set(canonicalPath, (readCounts.get(canonicalPath) ?? 0) + 1);
        return fs.promises.readFile(canonicalPath, "utf8");
      });
      expect([...installed!.keys()].sort()).toEqual([
        "@scope/ordinary@3.0.0",
        "@scope/truncated-package@4.0.0",
        "duplicate@1.0.0",
        "duplicate@2.0.0",
        "planted@9.9.9",
      ]);
      expect([...readCounts.values()]).toEqual([1, 1, 1, 1, 1]);
      expect(findUndispositionedPackages(installed!, new Map(), new Set())).toEqual([
        "planted@9.9.9 (postinstall)",
      ]);
    } finally {
      try {
        fs.unlinkSync(duplicateLink);
      } catch {
        // The link may not have been created if fixture setup failed.
      }
      try {
        fs.unlinkSync(duplicateVirtualStoreLink);
      } catch {
        // The link may not have been created if fixture setup failed.
      }
      fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("fails closed when an installed package manifest is malformed or unreadable", async () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wp001-lifecycle-invalid-"));
    const packageJsonPath = path.join(
      fixtureRoot,
      "node_modules",
      ".pnpm",
      "invalid@1.0.0",
      "node_modules",
      "invalid",
      "package.json",
    );
    fs.mkdirSync(path.dirname(packageJsonPath), { recursive: true });

    try {
      fs.writeFileSync(packageJsonPath, "{ definitely not JSON");
      await expect(collectInstalledPackages(fixtureRoot)).rejects.toThrow(
        /Failed to parse installed package manifest/,
      );

      fs.writeFileSync(packageJsonPath, JSON.stringify({ name: "invalid", version: "1.0.0" }));
      await expect(
        collectInstalledPackages(fixtureRoot, async () => {
          throw new Error("simulated access denial");
        }),
      ).rejects.toThrow(/Failed to read installed package manifest.*simulated access denial/);

      fs.rmSync(packageJsonPath);
      await expect(collectInstalledPackages(fixtureRoot)).rejects.toThrow(
        /Failed to resolve installed package manifest/,
      );
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

describe("SEC-051-DISPOSITION: every installed package with a preinstall/install/postinstall script is dispositioned, and nothing outside the allowlist is pending", () => {
  it("every currently-installed package that declares a lifecycle script has an explicit true/false entry in pnpm-workspace.yaml's allowBuilds map", async () => {
    const installed = await collectInstalledPackages(root);
    expect(
      installed,
      `node_modules\\.pnpm not found under ${root}. Expected red until an install ` +
        `has been run at least once in this worktree — this check reads pnpm's own ` +
        `materialized packages (SOURCE A), not the lockfile's package list, because ` +
        `the lockfile alone does not record which packages declare lifecycle scripts.`,
    ).not.toBeNull();
    if (!installed) return;

    // ADR-016: allowBuilds is the SEC-051 control pnpm >= 11 enforces.
    // onlyBuiltDependencies/ignoredBuiltDependencies are non-authoritative
    // mirrors, surfaced below for context ONLY — an empty or absent
    // onlyBuiltDependencies is never treated as proof of disposition.
    const allowBuilds = getAllowBuildsMap();
    const mirrorNames = getMirrorListNames();
    const undispositioned = findUndispositionedPackages(installed, allowBuilds, mirrorNames);

    expect(
      undispositioned,
      `${undispositioned.length} installed package(s) declare a preinstall/install/` +
        `postinstall script but have no explicit true/false entry in pnpm-workspace.yaml's ` +
        `allowBuilds map: ${undispositioned.join(", ")}. Per ADR-016 (docs\\decisions\\` +
        `ADR-016-sec-051-control-is-allowbuilds.md), allowBuilds is the SEC-051 register ` +
        `pnpm >= 11 actually enforces; onlyBuiltDependencies/ignoredBuiltDependencies are ` +
        `non-authoritative mirrors and an empty or absent onlyBuiltDependencies is never ` +
        `proof of disposition. This is exactly the class of bug from planning/receipts/` +
        `0147_..._WP-001.gauntlet-failed.json (ERR_PNPM_IGNORED_BUILDS: esbuild@0.28.2) — ` +
        `every one of these must get an explicit \`true\` (reviewed and needed, with a ` +
        `one-line justification comment) or \`false\` (reviewed and safe to skip) entry in ` +
        `allowBuilds; widening the allowlist to include a package whose script was never ` +
        `reviewed is not a fix.`,
    ).toEqual([]);
  });

  it("no allowBuilds entry set to true is missing its one-line justification comment", () => {
    // Declaration-level check, independent of which packages happen to be
    // installed right now: ADR-016 requires every allowBuilds:true entry —
    // present or future — to carry a trailing justification comment a
    // reviewer can see. This is also the check that specifically catches
    // the empty-onlyBuiltDependencies-plus-allowBuilds:{X:true} bypass class
    // ADR-016 names: an empty (or absent) onlyBuiltDependencies mirror list
    // must never be read as evidence that no true entry — justified or not
    // — exists in allowBuilds.
    const allowBuilds = getAllowBuildsMap();
    const unjustified: string[] = [];
    for (const [name, entry] of allowBuilds) {
      if (entry.value === true && !entry.hasJustification) unjustified.push(name);
    }
    expect(
      unjustified,
      `${unjustified.length} allowBuilds entr${unjustified.length === 1 ? "y is" : "ies are"} ` +
        `set to true with no one-line justification comment beside it: ` +
        `${unjustified.join(", ")}. Per ADR-016, every allowBuilds:true entry lets that ` +
        `package run arbitrary code on every install; it must carry a trailing "# reason" ` +
        `comment on the same line for a reviewer to see. onlyBuiltDependencies/` +
        `ignoredBuiltDependencies being empty is not evidence either way.`,
    ).toEqual([]);
  });

  it("node_modules/.modules.yaml records no pending (undispositioned) builds", () => {
    const modulesYamlPath = path.join(root, "node_modules", ".modules.yaml");
    expect(
      fs.existsSync(modulesYamlPath),
      `${modulesYamlPath} not found. Expected red until an install has been run at ` +
        `least once in this worktree.`,
    ).toBe(true);
    if (!fs.existsSync(modulesYamlPath)) return;

    let doc: { pendingBuilds?: unknown };
    try {
      // Despite the .yaml extension, pnpm writes this file as JSON
      // (confirmed live in this worktree) — SOURCE C above.
      doc = JSON.parse(fs.readFileSync(modulesYamlPath, "utf8"));
    } catch (e) {
      throw new Error(`Failed to parse ${modulesYamlPath} as JSON: ${String(e)}`);
    }
    const pending = Array.isArray(doc.pendingBuilds) ? doc.pendingBuilds : [];
    expect(
      pending,
      `node_modules/.modules.yaml#pendingBuilds is non-empty: ${JSON.stringify(pending)}. ` +
        `pnpm itself computed this list of build scripts it found declared but did not ` +
        `run because they are not yet dispositioned — this is pnpm's own first-party ` +
        `record of the exact defect class that produced ERR_PNPM_IGNORED_BUILDS on the ` +
        `integrator's fresh install. Add each entry to onlyBuiltDependencies or ` +
        `ignoredBuiltDependencies in pnpm-workspace.yaml, then reinstall.`,
    ).toEqual([]);
  });
});

describe("SEC-051-FROZEN-NOOP: a fresh frozen install succeeds and modifies no tracked file", () => {
  // Heavier than the rest of this suite: spawns a real `pnpm install
  // --offline --frozen-lockfile` in a scratch copy of the workspace's
  // install-relevant files (package.json, pnpm-lock.yaml, pnpm-workspace.yaml,
  // .npmrc, and every workspace member's package.json). Kept under
  // tests/security/WP-001 (not tests/integration/WP-001) because the
  // attempt-2 lease's write_grants name only tests/security/WP-001/ and
  // tests/fixtures/WP-001/ — the launch note's "or tests/integration/WP-001
  // if too heavy" alternative is not an authorized write surface for this
  // session, so this stays here with a generous per-test timeout instead.
  // A scratch copy (not the live worktree) is used deliberately: the builder
  // (0148, attempt 2) is editing this same shared worktree concurrently, and
  // running `pnpm install` in place could race its edits or leave the shared
  // node_modules mid-mutation.
  const scratchDirs: string[] = [];

  afterAll(() => {
    for (const dir of scratchDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // best-effort cleanup; a leftover temp dir is not a test failure
      }
    }
  });

  const TRACKED_FILES = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"];

  function listWorkspaceMemberPackageJsons(repoRoot: string): string[] {
    // pnpm-workspace.yaml's `packages:` globs for this project are exactly
    // "apps/*" and "packages/*" (read as literal directory scans here, not
    // a glob engine, since only these two literal prefixes are in the spec
    // — a store-only helper, not product code).
    const out: string[] = [];
    for (const group of ["apps", "packages"]) {
      const groupDir = path.join(repoRoot, group);
      if (!fs.existsSync(groupDir)) continue;
      for (const entry of fs.readdirSync(groupDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const rel = path.join(group, entry.name, "package.json");
        if (fs.existsSync(path.join(repoRoot, rel))) out.push(rel);
      }
    }
    return out;
  }

  it(
    "pnpm install --offline --frozen-lockfile exits 0 and leaves package.json, pnpm-lock.yaml, pnpm-workspace.yaml and .npmrc byte-identical",
    () => {
      const requiredFiles = [...TRACKED_FILES, ...listWorkspaceMemberPackageJsons(root)];
      const missing = requiredFiles.filter((f) => !fs.existsSync(path.join(root, f)));
      expect(
        missing,
        `Cannot assemble a scratch install: missing ${missing.join(", ")} under ${root}.`,
      ).toEqual([]);
      if (missing.length > 0) return;

      const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "wp001-frozen-install-"));
      scratchDirs.push(scratchDir);

      const beforeContents = new Map<string, Buffer>();
      for (const rel of requiredFiles) {
        const srcAbs = path.join(root, rel);
        const dstAbs = path.join(scratchDir, rel);
        fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
        const content = fs.readFileSync(srcAbs);
        fs.writeFileSync(dstAbs, content);
        beforeContents.set(rel, content);
      }

      const result = spawnSync("pnpm", ["install", "--offline", "--frozen-lockfile"], {
        cwd: scratchDir,
        encoding: "utf8",
        timeout: 120_000,
        windowsHide: true,
        shell: true,
      });

      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";
      const combined = `${stdout}\n${stderr}`.trim();

      expect(
        result.status,
        `pnpm install --offline --frozen-lockfile exited ${result.status} ` +
          `(spawn error: ${result.error ? String(result.error) : "none"}). ` +
          `Output:\n${combined.slice(-4000)}\n\n` +
          `Expected red if any lifecycle script found on a fresh install is not ` +
          `dispositioned in onlyBuiltDependencies/ignoredBuiltDependencies (matches ` +
          `SEC-051-DISPOSITION above and the integrator's ERR_PNPM_IGNORED_BUILDS finding).`,
      ).toBe(0);

      const modified: string[] = [];
      for (const rel of requiredFiles) {
        const dstAbs = path.join(scratchDir, rel);
        const after = fs.existsSync(dstAbs) ? fs.readFileSync(dstAbs) : null;
        const before = beforeContents.get(rel)!;
        if (after === null || !after.equals(before)) modified.push(rel);
      }

      expect(
        modified,
        `A fresh frozen install modified tracked file(s): ${modified.join(", ")}. ` +
          `This reproduces the exact side effect the integrator observed ` +
          `(planning/receipts/0147_..._WP-001.gauntlet-failed.json: ` +
          `"working_tree_status": " M SeniorSocial-AI-Bts/pnpm-workspace.yaml"). ` +
          `A --frozen-lockfile install that was reviewed and merged must be ` +
          `reproducible byte-for-byte, not a second silent resolution.`,
      ).toEqual([]);
    },
    150_000,
  );
});
