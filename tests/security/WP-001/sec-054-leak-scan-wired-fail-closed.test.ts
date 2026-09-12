/**
 * SEC-054 (security, layer L, rfp:T-15) — package: WP-001
 *
 * what_bug_this_catches (verbatim, story-test-map.csv): "A leak scan not
 * wired into the gate is a script nobody runs; a planted customer term is
 * the only proof it fires."
 *
 * Acceptance text: "the leak scan is wired into pnpm verify and fails on a
 * planted customer term under apps/; the scanner exits 1 when
 * LEAK_TERMS_FILE is unset or names a missing/empty file."
 *
 * Fixture note: this test-author session is not permitted to write under
 * apps/ (builder-owned), so the "planted term under apps/" half is proved in
 * two steps instead of one: (1) a structural check that the scanner's wired
 * default scan scope includes "apps" (04-tests-and-evals.md s4.2:
 * `tsx scripts/leak-scan.ts --paths apps packages infra`), and (2) a
 * behavioural check that invokes the *same* resolved scanner script directly
 * against a synthetic fixture directory (tests/fixtures/WP-001/planted-leak/)
 * with an invented term (never a real customer term, per the dispatch) via an
 * explicit path-scope override. Together they prove the acceptance clause
 * without this session touching a forbidden path.
 *
 * Script path and CLI-flag notes:
 * - 03-parallel-build-architecture.md s4.2 and harness-notes.claude.md name
 *   the leak scanner as "SeniorSocial-AI-Bts\scripts\leak-scan.ps1", but
 *   04-tests-and-evals.md s4.2's exact `verify:leak` composition instead
 *   runs `tsx scripts/leak-scan.ts`. This test resolves whatever script path
 *   package.json's own `verify:leak` script actually names — .ps1, .ts or
 *   .js — rather than assuming one, and runs it with the matching
 *   interpreter (see repo-helpers.runScriptFile). The .ps1-vs-.ts naming
 *   discrepancy is filed as a docket submission.
 * - Neither spec document states the exact CLI flag spelling a .ps1 scanner
 *   would use; PowerShell's own convention is a single-dash, capitalized
 *   parameter name (`-Paths`), not the Node/TS-style `--paths` 04 s4.2
 *   documents for the .ts variant. This test passes the flag spelling that
 *   matches the *resolved* script's own extension so a syntax mismatch never
 *   masquerades as a scanner defect.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  extractScriptFileToken,
  findRepoRoot,
  readRootPackageJson,
  runScriptFile,
} from "../../fixtures/WP-001/repo-helpers";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";

const root = findRepoRoot();
const pkg = readRootPackageJson(root);
const leakScript = pkg?.scripts?.["verify:leak"];
const scriptToken = extractScriptFileToken(leakScript);
const scriptAbsPath = scriptToken ? path.join(root, scriptToken) : null;
const scriptExists = scriptAbsPath ? fs.existsSync(scriptAbsPath) : false;
const isPs1 = scriptAbsPath ? path.extname(scriptAbsPath).toLowerCase() === ".ps1" : false;

// Built from the resolved repo root (not __dirname/import.meta.url) so this
// works whether the eventual project runs Vitest under CJS or ESM.
const FIXTURES_DIR = path.join(root, "tests", "fixtures", "WP-001");
const SYNTHETIC_TERMS_FILE = path.join(FIXTURES_DIR, "leak-terms.synthetic.txt");
const EMPTY_TERMS_FILE = path.join(FIXTURES_DIR, "leak-terms.empty.txt");
const PLANTED_LEAK_DIR = path.join(FIXTURES_DIR, "planted-leak");
const CLEAN_LEAK_DIR = path.join(FIXTURES_DIR, "clean-leak");
const MISSING_TERMS_FILE = path.join(FIXTURES_DIR, "leak-terms.does-not-exist.txt");
const scratchDirs: string[] = [];

afterEach(() => {
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  for (const dir of scratchDirs.splice(0)) {
    expect(path.resolve(dir).startsWith(tempRoot)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * `-Paths <dir>` for a PowerShell scanner, `--paths <dir>` otherwise — and,
 * empirically (run directly against the worktree's actual
 * scripts/leak-scan.ps1 while authoring this test), the *value* must be a
 * repo-root-relative path: an absolute Windows path silently produced
 * "PASS ... 0 hits" over an unrelated ~10-file scan instead of scanning the
 * given directory (or erroring), while the identical relative form correctly
 * detected the planted term. 04 s4.2's own default invocation
 * (`--paths apps packages infra`) is relative too, so this matches the
 * scanner's real contract rather than working around a bug in this test.
 * That a malformed/absolute --paths value fails *open* (silent 0-hit pass)
 * rather than erroring is recorded as a lesson in this session's C3 receipt
 * — it sits next to, but is not itself, this check's assigned acceptance
 * clause (LEAK_TERMS_FILE failing closed).
 */
function pathsOverrideArgs(absDir: string): string[] {
  const rel = path.relative(root, absDir).split(path.sep).join("/");
  return isPs1 ? ["-Paths", rel] : ["--paths", rel];
}

function baseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.LEAK_TERMS_FILE;
  return env;
}

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

describe("SEC-054: leak scan is wired into pnpm verify and fails closed", () => {
  it('"verify" chains "pnpm verify:leak"', () => {
    const verify = pkg?.scripts?.verify ?? "";
    expect(
      verify.includes("pnpm verify:leak"),
      `scripts.verify does not call "pnpm verify:leak": ${JSON.stringify(verify)}. ` +
        `A leak scan not wired into the gate is a script nobody runs.`,
    ).toBe(true);
  });

  it('verify:leak\'s default scan scope includes "apps" (04 s4.2: --paths apps packages infra)', () => {
    expect(leakScript, 'scripts["verify:leak"] is missing').toBeTruthy();
    // Accept both the Node/TS convention (--paths a b c) and the PowerShell
    // convention (-Paths a b c), case-insensitively, since 04 s4.2 only
    // documents the flag spelling for the .ts variant.
    expect(
      /-{1,2}paths\b[^\n]*\bapps\b/i.test(leakScript ?? ""),
      `scripts["verify:leak"] = ${JSON.stringify(leakScript)} does not scope its ` +
        `path argument to include "apps" — a leak scan that never looks under ` +
        `apps/ cannot catch a planted customer term there.`,
    ).toBe(true);
  });

  it("the referenced scanner script file exists on disk", () => {
    expect(scriptToken, 'could not extract a script file token from scripts["verify:leak"]').toBeTruthy();
    expect(
      scriptExists,
      `Resolved scanner path ${scriptAbsPath} does not exist. Expected red until ` +
        `WP-001 lands it.`,
    ).toBe(true);
  });

  it(
    "exits 1 (fails closed) against a synthetic planted term via an explicit path-scope override",
    () => {
      expect(scriptExists, "scanner script not present — cannot execute").toBe(true);
      const result = runScriptFile(
        scriptAbsPath as string,
        pathsOverrideArgs(PLANTED_LEAK_DIR),
        { ...baseEnv(), LEAK_TERMS_FILE: SYNTHETIC_TERMS_FILE },
        root,
      );
      expect(
        result.status,
        `Expected exit 1 on a planted synthetic term (zzyzxglarnok) under ` +
          `${PLANTED_LEAK_DIR}. Got status=${result.status}, error=${result.error}, ` +
          `stdout=${result.stdout.slice(0, 500)}, stderr=${result.stderr.slice(0, 500)}`,
      ).toBe(1);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain("planted.ts:6:");
      expect(output).toContain("zzyzxglarnok");
    },
    60_000,
  );

  it(
    "matches the same invented non-ASCII UTF-8 term in the list and target",
    () => {
      expect(scriptExists, "scanner script not present — cannot execute").toBe(true);
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "wp001-leak-utf8-"));
      scratchDirs.push(scratch);
      const terms = path.join(scratch, "terms.txt");
      const target = path.join(scratch, "target.ts");
      const probe = "café-probe-ñ";
      fs.writeFileSync(terms, `${probe}\n`, "utf8");
      fs.writeFileSync(target, `export const note = ${JSON.stringify(probe)};\n`, "utf8");
      const result = runScriptFile(
        scriptAbsPath as string,
        pathsOverrideArgs(target),
        { ...baseEnv(), LEAK_TERMS_FILE: terms },
        root,
      );
      expect(result.status, `Expected UTF-8 term match. stdout=${result.stdout}`).toBe(1);
      expect(result.stdout).toContain("target.ts:1:");
      expect(result.stdout).toContain(probe);
    },
    60_000,
  );

  it(
    "matches standalone multi-word names but not substrings inside longer alphanumeric tokens",
    () => {
      expect(scriptExists, "scanner script not present — cannot execute").toBe(true);
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "wp001-leak-boundaries-"));
      scratchDirs.push(scratch);
      const terms = path.join(scratch, "terms.txt");
      const target = path.join(scratch, "target.ts");
      fs.writeFileSync(terms, "art\n561\nQuasar Meadow\n", "utf8");
      fs.writeFileSync(target, "cartwheel artifact 123art456 SCHEMA_VALUE_561\n", "utf8");
      const clean = runScriptFile(
        scriptAbsPath as string,
        pathsOverrideArgs(target),
        { ...baseEnv(), LEAK_TERMS_FILE: terms },
        root,
      );
      expect(clean.status, `Expected substring-only text to pass. stdout=${clean.stdout}`).toBe(0);

      fs.writeFileSync(target, "Welcome to Quasar Meadow — synthetic center.\n", "utf8");
      const planted = runScriptFile(
        scriptAbsPath as string,
        pathsOverrideArgs(target),
        { ...baseEnv(), LEAK_TERMS_FILE: terms },
        root,
      );
      expect(planted.status, `Expected standalone multi-word name to fail. stdout=${planted.stdout}`).toBe(1);
      expect(planted.stdout).toContain("Quasar Meadow");
    },
    60_000,
  );

  it(
    "excludes generated TypeScript build metadata from the publication scan",
    () => {
      expect(scriptExists, "scanner script not present — cannot execute").toBe(true);
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "wp001-leak-generated-"));
      scratchDirs.push(scratch);
      fs.writeFileSync(path.join(scratch, "clean.ts"), "export const clean = true;\n", "utf8");
      fs.writeFileSync(path.join(scratch, "cache.tsbuildinfo"), "zzyzxglarnok\n", "utf8");
      const result = runScriptFile(
        scriptAbsPath as string,
        pathsOverrideArgs(scratch),
        { ...baseEnv(), LEAK_TERMS_FILE: SYNTHETIC_TERMS_FILE },
        root,
      );
      expect(result.status, `Expected generated metadata exclusion. stdout=${result.stdout}`).toBe(0);
    },
    60_000,
  );

  it(
    "fails closed when an enumerated target cannot be read",
    () => {
      expect(scriptAbsPath, "scanner script not present — cannot execute").toBeTruthy();
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "wp001-leak-locked-"));
      scratchDirs.push(scratch);
      const target = path.join(scratch, "locked.ts");
      fs.writeFileSync(target, "export const clean = true;\n", "utf8");
      const command = [
        `$stream = [System.IO.File]::Open(${psQuote(target)}, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)`,
        `try { & ${psQuote(scriptAbsPath as string)} -Paths ${psQuote(target)}; $scanCode = $LASTEXITCODE } finally { $stream.Dispose() }`,
        "exit $scanCode",
      ].join("; ");
      const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], {
        cwd: root,
        env: { ...baseEnv(), LEAK_TERMS_FILE: SYNTHETIC_TERMS_FILE },
        encoding: "utf8",
        timeout: 60_000,
        windowsHide: true,
      });
      expect(result.status, `Expected unreadable target to fail. stdout=${result.stdout}`).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain("cannot read scanned file");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("leak-scan: PASS");
    },
    60_000,
  );

  it(
    "exits 1 when an explicit scan scope contains zero scannable files",
    () => {
      expect(scriptExists, "scanner script not present — cannot execute").toBe(true);
      const missingScope = path.join(FIXTURES_DIR, "scan-scope-does-not-exist");
      expect(fs.existsSync(missingScope), "fixture setup error: missing scan scope unexpectedly exists").toBe(false);
      const result = runScriptFile(
        scriptAbsPath as string,
        pathsOverrideArgs(missingScope),
        { ...baseEnv(), LEAK_TERMS_FILE: SYNTHETIC_TERMS_FILE },
        root,
      );
      expect(result.status, `Expected exit 1 for an empty scope. stdout=${result.stdout}`).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain("no scannable files");
    },
    60_000,
  );

  it(
    "keeps excluded dependency trees outside the scan surface",
    () => {
      expect(scriptExists, "scanner script not present — cannot execute").toBe(true);
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "wp001-leak-exclusion-"));
      scratchDirs.push(scratch);
      fs.writeFileSync(path.join(scratch, "visible.ts"), "export const clean = true;\n", "utf8");
      const excluded = path.join(scratch, "node_modules", "synthetic-package");
      fs.mkdirSync(excluded, { recursive: true });
      fs.writeFileSync(path.join(excluded, "private.ts"), "zzyzxglarnok\n", "utf8");
      const result = runScriptFile(
        scriptAbsPath as string,
        pathsOverrideArgs(scratch),
        { ...baseEnv(), LEAK_TERMS_FILE: SYNTHETIC_TERMS_FILE },
        root,
      );
      expect(
        result.status,
        `Expected excluded node_modules content not to produce a hit. stdout=${result.stdout}`,
      ).toBe(0);
      expect(result.stdout).toContain("1 file(s); 0 hits");
    },
    60_000,
  );

  it(
    "does not follow a directory junction outside the requested scope",
    () => {
      expect(scriptExists, "scanner script not present — cannot execute").toBe(true);
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "wp001-leak-junction-scope-"));
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "wp001-leak-junction-target-"));
      scratchDirs.push(scratch, outside);
      fs.writeFileSync(path.join(scratch, "visible.ts"), "export const clean = true;\n", "utf8");
      fs.writeFileSync(path.join(outside, "private.ts"), "zzyzxglarnok\n", "utf8");
      fs.symlinkSync(outside, path.join(scratch, "linked-outside"), "junction");
      const result = runScriptFile(
        scriptAbsPath as string,
        pathsOverrideArgs(scratch),
        { ...baseEnv(), LEAK_TERMS_FILE: SYNTHETIC_TERMS_FILE },
        root,
      );
      expect(result.status, `Expected junction target to remain out of scope. stdout=${result.stdout}`).toBe(0);
      expect(result.stdout).toContain("1 file(s); 0 hits");
    },
    60_000,
  );

  it(
    "exits 0 on a clean synthetic fixture with no planted term (sanity control, not unconditionally red)",
    () => {
      expect(scriptExists, "scanner script not present — cannot execute").toBe(true);
      const result = runScriptFile(
        scriptAbsPath as string,
        pathsOverrideArgs(CLEAN_LEAK_DIR),
        { ...baseEnv(), LEAK_TERMS_FILE: SYNTHETIC_TERMS_FILE },
        root,
      );
      expect(
        result.status,
        `Expected exit 0 on a clean fixture with no planted term. Got ` +
          `status=${result.status}, stdout=${result.stdout.slice(0, 500)}, ` +
          `stderr=${result.stderr.slice(0, 500)}`,
      ).toBe(0);
    },
    60_000,
  );

  it(
    "exits 1 when LEAK_TERMS_FILE is unset (fail closed, never a pass for lack of input)",
    () => {
      expect(scriptExists, "scanner script not present — cannot execute").toBe(true);
      const result = runScriptFile(
        scriptAbsPath as string,
        pathsOverrideArgs(CLEAN_LEAK_DIR),
        baseEnv(), // LEAK_TERMS_FILE deliberately absent
        root,
      );
      expect(
        result.status,
        `Expected exit 1 when LEAK_TERMS_FILE is unset. Got status=${result.status}, ` +
          `stdout=${result.stdout.slice(0, 500)}, stderr=${result.stderr.slice(0, 500)}`,
      ).toBe(1);
    },
    60_000,
  );

  it(
    "exits 1 when LEAK_TERMS_FILE names a missing file",
    () => {
      expect(scriptExists, "scanner script not present — cannot execute").toBe(true);
      expect(fs.existsSync(MISSING_TERMS_FILE), "fixture setup error: the missing-file path unexpectedly exists").toBe(false);
      const result = runScriptFile(
        scriptAbsPath as string,
        pathsOverrideArgs(CLEAN_LEAK_DIR),
        { ...baseEnv(), LEAK_TERMS_FILE: MISSING_TERMS_FILE },
        root,
      );
      expect(
        result.status,
        `Expected exit 1 when LEAK_TERMS_FILE names a missing file. Got ` +
          `status=${result.status}, stdout=${result.stdout.slice(0, 500)}, ` +
          `stderr=${result.stderr.slice(0, 500)}`,
      ).toBe(1);
    },
    60_000,
  );

  it(
    "exits 1 when LEAK_TERMS_FILE names an empty file",
    () => {
      expect(scriptExists, "scanner script not present — cannot execute").toBe(true);
      const result = runScriptFile(
        scriptAbsPath as string,
        pathsOverrideArgs(CLEAN_LEAK_DIR),
        { ...baseEnv(), LEAK_TERMS_FILE: EMPTY_TERMS_FILE },
        root,
      );
      expect(
        result.status,
        `Expected exit 1 when LEAK_TERMS_FILE names an empty file. Got ` +
          `status=${result.status}, stdout=${result.stdout.slice(0, 500)}, ` +
          `stderr=${result.stderr.slice(0, 500)}`,
      ).toBe(1);
    },
    60_000,
  );
});
