/**
 * CK-132 / CK-133 / CK-134 / CK-135 (unit, layer 0, rfp:T-15) — package: WP-001
 *
 * Post-merge maintenance regression. Originally written at attempt 4
 * (planning/handoffs/WP-001.attempt-4.lease-request.0146.json); CORRECTED at
 * attempt 5, dispatch 8, per planning/reviews/review-WP-001-4.md
 * (verdict REOPEN, reviewer 0161) remediations 2 and 3, and per this
 * dispatch's own item 7 root-cause investigation. Never from the builder's
 * (0148) diff or receipt.
 *
 * WHAT CHANGED FROM THE PRIOR PASS (all three changes below, not just one):
 *
 *   1. PROBE LOCATION MOVED, root cause of the sec-051 red (item 7). The
 *      previous pass built its scratch probe at `packages/zz-lint-probe-
 *      ta149/`, WITH a package.json — a path that matches pnpm-workspace.
 *      yaml's own `packages/*` glob, making it a real (if short-lived) pnpm
 *      workspace member. Running `pnpm exec eslint ...` against it (no
 *      `--frozen-lockfile`) let pnpm silently discover the new importer and
 *      rewrite the LANE's own committed pnpm-lock.yaml as a side effect --
 *      reproduced twice this dispatch, independent of whether the security
 *      suite runs in the same invocation or not (see this dispatch's
 *      test-8.json receipt for the measured before/after hashes). This is
 *      exactly the class of defect this dispatch's hard rules forbid ("No
 *      scratch workspace package inside the repo"). The probe now lives at
 *      `tests/fixtures/WP-001/zz-lint-probe-ta149/` -- inside this role's own
 *      write grant, several directories deep (still exercising the "reaches
 *      a NESTED, non-root-relative location" property the checks below
 *      test), and NOT under `apps/*` or `packages/*`, so pnpm never sees it
 *      as a workspace member. No package.json is created for it any more --
 *      nothing here needs one now that it is not a package. Verified this
 *      dispatch: `pnpm exec eslint` against a file at this new location
 *      leaves the lane's pnpm-lock.yaml byte-identical (sha256 unchanged).
 *   2. CK-134 REWRITTEN to assert WIRING, not exit code (remediation 2). The
 *      prior version ran `pnpm exec eslint --max-warnings 0 scripts eslint.
 *      config.mjs` directly and called that "the root scripts folder is
 *      gated" -- but root package.json's actual `verify:lint` script is
 *      `turbo run lint -- --max-warnings 0`, which runs each WORKSPACE
 *      PACKAGE's own `lint` script via Turbo; root `scripts/` and `eslint.
 *      config.mjs` sit outside every workspace package, so nothing in the
 *      real merge gate ever reached them. A manual invocation proves ESLint
 *      COULD lint those paths; it proves nothing about whether `pnpm verify`
 *      does. CK-134 below instead parses package.json's own verify:* scripts
 *      for a clause that actually invokes eslint against `scripts` and
 *      `eslint.config.mjs` with `--max-warnings 0`, requires that clause's
 *      stage be chained into the top-level `verify` script (reusing CK-097's
 *      already-asserted chain), and THEN runs that exact clause for real and
 *      asserts it exits 0 -- wiring and behaviour both, not one standing in
 *      for the other. Expected RED until the builder wires it: today no
 *      verify:* script contains such a clause at all.
 *   3. TYPED-STRICTNESS COVERAGE EXTENDED to .tsx, .mts and .cts (remediation
 *      3, this dispatch's item 4). Previously only a .ts floating promise was
 *      proven to still fail. CK-133 and CK-135 below now cover all four
 *      typed extensions the config's own `files: ['**\/*.{ts,tsx,mts,cts}']`
 *      pattern names, and explicitly confirm the untyped-rule disable applies
 *      to EXACTLY js/mjs/cjs -- no more, no less. This extension is GREEN
 *      both before and after the builder's repair, by design: type-aware
 *      rules were never disabled for these extensions, so there is nothing
 *      to repair here. It guards against a FUTURE over-broad disable, not a
 *      currently red-first defect -- stated plainly rather than manufacturing
 *      a red where none exists.
 *
 * The lease request's own reproduction (unchanged from attempt 4): `eslint
 * packages/contracts/scripts/generate-types.mjs` exits 1 with
 * `@typescript-eslint/await-thenable` "requires type information", because
 * (i) recommendedTypeChecked applies to every file and (ii) the plain-ESM
 * override that turns typed rules off for Node scripts only matched a
 * root-relative `scripts/**\/*.mjs`, missing any nested package's own scripts
 * folder.
 *
 * what_bug_this_catches (verbatim, all four checks in this file, unchanged):
 * "A root lint config that applies type-aware rules to untyped Node scripts
 * fails the first package that ships one, and a config that fixes it by
 * loosening typed rules silently drops the gate for product code."
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  findRepoRoot,
  gitInvocation,
  readRootPackageJson,
  splitAndChain,
} from "../../fixtures/WP-001/repo-helpers";

const root = findRepoRoot();

function currentBranch(): string {
  const git = gitInvocation(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = spawnSync(git.command, git.args, {
    cwd: git.cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return (branch.stdout ?? "").trim();
}

const branchAtStart = currentBranch();

// Namespaced with this test-author's registry id so this scratch fixture
// cannot collide with any concurrently-running session's own scratch
// fixtures in this shared worktree. Lives under this role's OWN fixtures
// grant, several directories deep -- NOT under apps/* or packages/*, so it is
// never a pnpm workspace member (see the header comment's item 1). The `.tmp`
// suffix is covered by the repository's existing ignore rule, preventing this
// concurrent fixture from appearing as another suite's new Git-status mark.
const PROBE_DIR_NAME = "zz-lint-probe-ta149.tmp";
const probeRoot = path.join(root, "tests", "fixtures", "WP-001", PROBE_DIR_NAME);
const probeRootRel = `tests/fixtures/WP-001/${PROBE_DIR_NAME}`;
const probeScriptRel = `${probeRootRel}/scripts/probe.mjs`;

const TYPED_EXTENSIONS = ["ts", "tsx", "mts", "cts"] as const;
const UNTYPED_EXTENSIONS = ["js", "mjs", "cjs"] as const;

interface EslintRunResult {
  status: number | null;
  combined: string;
  error: Error | undefined;
}

function runEslint(args: string[]): EslintRunResult {
  const result = spawnSync("pnpm", ["exec", "eslint", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
    shell: true,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return {
    status: result.status,
    combined: `${stdout}\n${stderr}`.trim(),
    error: result.error,
  };
}

function removeProbeDir(): void {
  if (fs.existsSync(probeRoot)) {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
}

beforeAll(() => {
  removeProbeDir(); // defensive: never build on top of a stale leftover
  fs.mkdirSync(path.join(probeRoot, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(probeRoot, "src"), { recursive: true });

  // (a) fixture: plain ESM, top-level await, uses process + console. Shaped
  // like the lease request's own reproduction (a nested location's scripts
  // folder). Uses a dynamic import() for its top-level await rather than the
  // bare identifier `Promise`, so this fixture cannot fail on an unrelated
  // no-undef gap in the scripts override's explicit globals list.
  fs.writeFileSync(
    path.join(probeRoot, "scripts", "probe.mjs"),
    [
      "console.log('probe pid', process.pid);",
      "const os = await import('node:os');",
      "console.log('probe platform', os.platform());",
      "process.exitCode = 0;",
      "",
    ].join("\n"),
    "utf8",
  );

  // (b) fixtures: a floating promise, once per typed extension the config's
  // own files[] pattern names (ts, tsx, mts, cts) -- proves the repair did
  // not also loosen the typed rule set for product code, for every typed
  // extension, not just .ts.
  const floatingPromiseBody = [
    "async function doWork(): Promise<void> {",
    "  return;",
    "}",
    "",
    "function run(): void {",
    "  doWork(); // floating promise -- never awaited, caught, or voided",
    "}",
    "",
    "run();",
    "",
  ].join("\n");
  // Distinct base name per extension (bad-ts.ts, bad-tsx.tsx, ...), not a
  // shared "bad.<ext>" for all four: with "declaration": true inherited from
  // tsconfig.base.json, "bad.ts" and "bad.tsx" sharing one basename in the
  // SAME project would both target a "bad.d.ts" declaration output, and
  // typescript-eslint's project service silently drops the colliding file
  // from the project rather than raising a declaration-emit error -- observed
  // directly this dispatch as "Parsing error: ... was not found by the
  // project service" on whichever of the two ran second (reproduced both
  // orders). Giving every extension its own basename removes the collision.
  for (const ext of TYPED_EXTENSIONS) {
    fs.writeFileSync(path.join(probeRoot, "src", `bad-${ext}.${ext}`), floatingPromiseBody, "utf8");
  }

  // Standalone tsconfig (no package.json needed -- this is not a pnpm
  // workspace member) so typescript-eslint's projectService discovers it for
  // every src/bad.* file. Path to tsconfig.base.json computed relative to
  // this fixture's actual depth so a future move of either file cannot
  // silently point this at the wrong config.
  const extendsRel = path
    .relative(probeRoot, path.join(root, "tsconfig.base.json"))
    .split(path.sep)
    .join("/");
  fs.writeFileSync(
    path.join(probeRoot, "tsconfig.json"),
    `${JSON.stringify(
      {
        extends: extendsRel,
        compilerOptions: { lib: ["ES2023"], types: ["node"], rootDir: "src" },
        include: ["src/**/*"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
});

afterAll(() => {
  // Safety net only: the dedicated cleanup test below already removes and
  // asserts this. A throw in an earlier test must not leave the scratch
  // fixture behind on disk.
  removeProbeDir();
});

describe("CK-132: an untyped nested-location Node script lints clean under the root config", () => {
  it(
    `pnpm exec eslint --max-warnings 0 ${probeScriptRel} exits 0`,
    () => {
      const { status, combined, error } = runEslint([
        "--max-warnings",
        "0",
        probeScriptRel,
      ]);
      expect(
        status,
        `expected exit 0 linting a plain-ESM nested-location script; got ${String(status)} ` +
          `(spawn error: ${error ? String(error) : "none"}). Output:\n${combined}\n\n` +
          "This is the lease request's own reproduction (eslint packages/contracts/" +
          'scripts/generate-types.mjs -> @typescript-eslint/await-thenable "requires ' +
          'type information"). Expected RED against the pre-repair config: the plain-' +
          "ESM override only matched a root-relative scripts/**/*.mjs and missed this " +
          "nested path, so recommendedTypeChecked's typed rules ran with no TS program.",
      ).toBe(0);
    },
    60_000,
  );
});

describe("CK-133: the same scratch fixture's TypeScript floating promise still fails, for every typed extension (strictness kept)", () => {
  it.each(TYPED_EXTENSIONS)(
    "pnpm exec eslint typed fixture .%s (via the probe root) still reports @typescript-eslint/no-floating-promises",
    (ext) => {
      const rel = `${probeRootRel}/src/bad-${ext}.${ext}`;
      const { status, combined, error } = runEslint([rel]);
      expect(
        status,
        `expected a non-zero exit linting src/bad-${ext}.${ext}'s floating promise; got ` +
          `${String(status)} (spawn error: ${error ? String(error) : "none"}). A config ` +
          "that fixes the untyped-script gap by loosening typed rules broadly, instead of " +
          `narrowly for js/mjs/cjs, would silently drop this gate for product code. ` +
          `Output:\n${combined}`,
      ).not.toBe(0);
      expect(
        combined,
        `expected "@typescript-eslint/no-floating-promises" in the eslint output for ` +
          `.${ext}; got:\n${combined}`,
      ).toContain("@typescript-eslint/no-floating-promises");
    },
    120_000,
  );
});

describe("CK-134: root and nested package scripts are wired into the pnpm verify lint gate", () => {
  /**
   * A verify:* (or the top-level "verify") script clause "gates root
   * scripts" when, within one `&&`-delimited clause of that script's own
   * command string, all three hold: (a) it invokes `eslint`; (b) `scripts`
   * appears as its own whitespace/quote-bounded argument (a lint TARGET, not
   * merely a substring of some unrelated path like "scripts/openapi-drift.
   * mjs"); (c) `eslint.config.mjs` appears literally; and (d) a `--max-
   * warnings 0` (or `=0`) flag appears in the same clause. This is
   * deliberately a literal, clause-scoped string match, not an attempt to
   * execute every wrapper script to discover what it would run -- the exact
   * technique CK-136/CK-137 already use for this same package.json, and the
   * same technique this project's OWN verify:* stages use themselves (e.g.
   * verify:unit's "... -- vitest run tests/unit" tail is matched the same
   * way by CK-137).
   */
  function clauseGatesRootScripts(clause: string): boolean {
    if (!/\beslint\b/.test(clause)) return false;
    const hasScriptsTarget = /(^|[\s"'])scripts(?=[\s"']|$)/.test(clause);
    const hasNestedPackageScripts = /packages\/\*\/scripts\//.test(clause);
    const hasConfigTarget = /\beslint\.config\.mjs\b/.test(clause);
    const hasMaxWarningsZero = /--max-warnings[=\s]+0\b/.test(clause);
    return hasScriptsTarget && hasNestedPackageScripts && hasConfigTarget && hasMaxWarningsZero;
  }

  interface Match {
    stage: string;
    clause: string;
  }

  function findGateClauses(scripts: Record<string, unknown>): Match[] {
    const found: Match[] = [];
    for (const [key, cmd] of Object.entries(scripts)) {
      if (typeof cmd !== "string") continue;
      if (key !== "verify" && !key.startsWith("verify:")) continue;
      for (const clause of cmd.split("&&").map((c) => c.trim())) {
        if (clauseGatesRootScripts(clause)) found.push({ stage: key, clause });
      }
    }
    return found;
  }

  const pkg = readRootPackageJson(root);
  const scripts = pkg?.scripts ?? {};
  const matches = findGateClauses(scripts);

  it("a verify clause lints root scripts, nested package scripts, and eslint.config.mjs with zero warnings", () => {
    expect(
      matches.length,
      `No verify:* (or top-level verify) script contains a clause that invokes eslint ` +
        `with "scripts", "packages/*/scripts/**", and "eslint.config.mjs" as targets ` +
        `and "--max-warnings 0". ` +
        `Observed verify:* scripts: ${JSON.stringify(
          Object.fromEntries(
            Object.entries(scripts).filter(([k]) => k === "verify" || k.startsWith("verify:")),
          ),
        )}. root package.json's "verify:lint" is currently "${String(
          scripts["verify:lint"],
        )}" -- turbo run lint only invokes each WORKSPACE PACKAGE's own "lint" script, and ` +
        `root scripts/ and eslint.config.mjs sit outside every workspace package, so no ` +
        `verify:* stage reaches them today. A manual "pnpm exec eslint scripts eslint.` +
        `config.mjs" run by hand is not a merge-gate assertion (review-WP-001-4.md finding b).`,
    ).toBeGreaterThan(0);
  });

  it("that gating stage is (or is chained into) the top-level \"verify\" script", () => {
    expect(matches.length).toBeGreaterThan(0);
    const verify = scripts.verify ?? "";
    const verifyTokens = splitAndChain(verify).map((t) => t.replace(/^pnpm run\s+/, "pnpm "));
    const wired = matches.some(
      ({ stage }) => stage === "verify" || stage === "verify:lint" || verifyTokens.includes(`pnpm ${stage}`),
    );
    expect(
      wired,
      `Found a script clause that gates root scripts (stage(s): ${matches
        .map((m) => m.stage)
        .join(", ")}), but it is neither "verify" nor "verify:lint" (both unconditionally ` +
        `part of the top-level chain, per CK-097) nor chained into "verify" as its own ` +
        `stage. Full observed verify chain: ${JSON.stringify(verifyTokens)}. A stage that ` +
        `exists but is not reachable from "pnpm verify" is exactly as useless as one that ` +
        `was never written.`,
    ).toBe(true);
  });

  it(
    "the wired clause, run for real, actually exits 0 against the current repo (wiring AND behaviour, not one standing in for the other)",
    () => {
      expect(matches.length).toBeGreaterThan(0);
      const { clause } = matches[0];
      const spawnCmd = /^pnpm\b/i.test(clause) ? clause : `pnpm exec ${clause}`;
      const result = spawnSync(spawnCmd, {
        cwd: root,
        encoding: "utf8",
        timeout: 60_000,
        windowsHide: true,
        shell: true,
      });
      const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
      expect(
        result.status,
        `The wired gate clause ("${clause}") exited ${String(result.status)} instead of 0 ` +
          `(spawn error: ${result.error ? String(result.error) : "none"}). Output:\n${combined}`,
      ).toBe(0);
    },
    60_000,
  );

  it(
    "the actual verify:lint gate rejects a planted syntax error in a nested package script",
    () => {
      const gateProbeRoot = path.join(root, "packages", "zz-lint-gate-probe-int184.tmp");
      const gateProbeScript = path.join(gateProbeRoot, "scripts", "broken.mjs");
      try {
        fs.rmSync(gateProbeRoot, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(gateProbeScript), { recursive: true });
        fs.writeFileSync(gateProbeScript, "const = ;\n", "utf8");
        const result = spawnSync("pnpm", ["verify:lint"], {
          cwd: root,
          encoding: "utf8",
          timeout: 90_000,
          windowsHide: true,
          shell: true,
        });
        const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
        expect(result.status, `verify:lint unexpectedly accepted ${gateProbeScript}`).not.toBe(0);
        expect(combined).toContain("broken.mjs");
      } finally {
        fs.rmSync(gateProbeRoot, { recursive: true, force: true });
      }
    },
    90_000,
  );
});

describe("CK-135: the resolved flat config structurally disables type-aware rules for EXACTLY js/mjs/cjs, keeps them an error for ts/tsx/mts/cts, and reaches nested locations", () => {
  /** Extracts the extension(s) a single glob pattern's final segment targets. */
  function patternExtensions(pattern: string): string[] {
    const brace = /\{([^}]*)\}\s*$/.exec(pattern);
    if (brace) return brace[1].split(",").map((s) => s.trim());
    const single = /\.(\w+)$/.exec(pattern);
    return single ? [single[1]] : [];
  }

  it(
    "a config block's files[] covers .js, .mjs and .cjs together, with the type-aware rule off there and still an error for .ts/.tsx/.mts/.cts",
    async () => {
      const configPath = path.join(root, "eslint.config.mjs");
      const mod = (await import(pathToFileURL(configPath).href)) as {
        default: unknown;
      };
      expect(
        Array.isArray(mod.default),
        "eslint.config.mjs's default export is not an array",
      ).toBe(true);
      const arr = mod.default as Array<{ files?: unknown[] }>;

      const coveringBlock = arr.find((block) => {
        const files = Array.isArray(block.files) ? (block.files as string[]) : [];
        const exts = new Set(files.flatMap((f) => patternExtensions(f)));
        return exts.has("js") && exts.has("mjs") && exts.has("cjs");
      });
      expect(
        coveringBlock,
        "no config block's files[] covers js, mjs AND cjs together. Full config " +
          `files[] arrays observed: ${JSON.stringify(arr.map((b) => b.files ?? null))}`,
      ).toBeTruthy();

      // Behavioural confirmation via ESLint's own resolver: a type-aware rule
      // must be OFF for EXACTLY js/mjs/cjs samples and still an error for
      // every typed extension the config's own files[] pattern names.
      const { ESLint } = await import("eslint");
      const eslint = new ESLint({ cwd: root });
      const sentinelRule = "@typescript-eslint/no-floating-promises";
      for (const ext of UNTYPED_EXTENSIONS) {
        const sample = `zz-structural-sample.${ext}`;
        const cfg = await eslint.calculateConfigForFile(sample);
        const raw = cfg.rules?.[sentinelRule];
        const level = Array.isArray(raw) ? raw[0] : raw;
        expect(
          level === "off" || level === 0,
          `${sentinelRule} is not off for ${sample}; resolved level: ${JSON.stringify(level)}`,
        ).toBe(true);
      }
      for (const ext of TYPED_EXTENSIONS) {
        const sample = `zz-structural-sample.${ext}`;
        const cfg = await eslint.calculateConfigForFile(sample);
        const raw = cfg.rules?.[sentinelRule];
        const level = Array.isArray(raw) ? raw[0] : raw;
        expect(
          level === "error" || level === 2,
          `${sentinelRule} is not still an error for .${ext} (a typed extension the ` +
            `config's own files[] pattern names); resolved level: ${JSON.stringify(level)}. ` +
            `Disabling type-aware rules must apply to EXACTLY js/mjs/cjs, never widening ` +
            `to a typed extension.`,
        ).toBe(true);
      }
    },
    60_000,
  );

  it(
    "a scripts override pattern is not root-relative (starts with **/) and reaches a nested location's scripts folder",
    async () => {
      const configPath = path.join(root, "eslint.config.mjs");
      const mod = (await import(pathToFileURL(configPath).href)) as {
        default: unknown;
      };
      const arr = mod.default as Array<{ files?: unknown[] }>;
      const nonRootRelativeScriptsPattern = arr
        .flatMap((block) => (Array.isArray(block.files) ? (block.files as string[]) : []))
        .find((pattern) => pattern.startsWith("**/") && pattern.includes("scripts"));
      expect(
        nonRootRelativeScriptsPattern,
        'no files[] pattern starts with "**/" and mentions "scripts". A root-relative ' +
          'pattern like "scripts/**/*.mjs" only matches the repo-root scripts/ folder ' +
          "and misses packages/<pkg>/scripts/*.mjs, which is the exact gap the lease " +
          "request reproduced. Full config files[] arrays observed: " +
          `${JSON.stringify(arr.map((b) => b.files ?? null))}`,
      ).toBeTruthy();

      // Behavioural confirmation: a NESTED location's scripts file must get
      // the scripts override's own rule change (no-console: off), which it
      // would not if the override pattern were root-relative only. This is a
      // virtual path passed only to calculateConfigForFile -- no file is
      // created on disk, so this assertion carries none of the workspace-
      // membership risk this file's header comment describes for the
      // PHYSICAL probe fixture above.
      const { ESLint } = await import("eslint");
      const eslint = new ESLint({ cwd: root });
      const nestedCfg = await eslint.calculateConfigForFile(
        "packages/zz-structural-nested/scripts/probe.mjs",
      );
      const raw = nestedCfg.rules?.["no-console"];
      const noConsoleLevel = Array.isArray(raw) ? raw[0] : raw;
      expect(
        noConsoleLevel === "off" || noConsoleLevel === 0,
        "no-console is not off for a nested location's scripts file " +
          "(packages/zz-structural-nested/scripts/probe.mjs); resolved level: " +
          `${JSON.stringify(noConsoleLevel)}. This means the scripts override does not ` +
          "reach nested locations, i.e. it is still root-relative.",
      ).toBe(true);
    },
    60_000,
  );
});

describe("CK-140: eslint fails against the ORIGINAL merged config (02cca56b) for a nested-location .mjs script, and passes against the lane's current config (remediation 5)", () => {
  // The review wants red measured against the merged config AT 02cca56b, not
  // the already-repaired lane HEAD -- this dispatch's own re-reading of the
  // live worktree config (which CK-132/CK-135 above already exercise) is not
  // independent evidence of what the ORIGINAL bug looked like. Historical
  // content is read read-only via `git show <sha>:<path>` (no checkout, ever)
  // into a scratch file OUTSIDE the repository (os.tmpdir()); the lane's own
  // HEAD is never touched or checked out.
  //
  // The historical file's two bare-specifier imports (`@eslint/js`,
  // `typescript-eslint`) are rewritten to absolute file:// URLs resolved via
  // `import.meta.resolve` against THIS lane's own install before the scratch
  // copy is executed -- Node's ESM resolver walks up from the IMPORTING
  // file's own location looking for node_modules, and a file under
  // os.tmpdir() has no such ancestor, so the raw bare specifiers would fail
  // to resolve at all once genuinely outside the repository. Rewriting the
  // two import lines to the exact absolute paths this lane already has
  // installed does not change the config's behaviour in any way that this
  // check cares about (the rest of the file, including the buggy `files`
  // pattern under test, is copied byte-for-byte) -- no node_modules copy, no
  // lane mutation, and the lane's own eslint.config.mjs is read for the
  // candidate half but never written to.
  const BASE_SHA = "02cca56b13c9f22bf1c12e51ce9bd2d1a97bf193";
  const BASE_GIT_PATH = "SeniorSocial-AI-Bts/eslint.config.mjs";

  it(
    "base (02cca56b) config errors with a type-information requirement on a nested .mjs; the lane's current config passes the same file",
    () => {
      const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "wp001-ck140-"));
      try {
        const git = gitInvocation(root, ["show", `${BASE_SHA}:${BASE_GIT_PATH}`]);
        const showResult = spawnSync(git.command, git.args, {
          cwd: git.cwd,
          encoding: "utf8",
          windowsHide: true,
        });
        expect(
          showResult.status,
          `git show ${BASE_SHA}:${BASE_GIT_PATH} failed (status ${String(showResult.status)}): ` +
            `${showResult.stderr ?? ""}`,
        ).toBe(0);
        let baseConfigText = showResult.stdout ?? "";
        expect(
          baseConfigText.length,
          "git show returned empty content for the historical eslint.config.mjs",
        ).toBeGreaterThan(0);

        // Sanity: the historical file must actually carry the buggy,
        // root-relative-only pattern this check is meant to catch -- if a
        // future rebase changes what 02cca56b resolves to, fail loudly
        // instead of silently testing the wrong thing.
        expect(
          baseConfigText.includes("'scripts/**/*.mjs'") &&
            !baseConfigText.includes("'**/scripts/**/*.mjs'"),
          `historical eslint.config.mjs at ${BASE_SHA} does not contain the expected ` +
            `root-relative-only "scripts/**/*.mjs" pattern (or already carries the fixed ` +
            `"**/scripts/**/*.mjs" pattern). Content:\n${baseConfigText}`,
        ).toBe(true);

        const jsUrl = import.meta.resolve("@eslint/js");
        const tseslintUrl = import.meta.resolve("typescript-eslint");
        const beforeReplace = baseConfigText;
        baseConfigText = baseConfigText
          .replace("import js from '@eslint/js';", `import js from '${jsUrl}';`)
          .replace("import tseslint from 'typescript-eslint';", `import tseslint from '${tseslintUrl}';`);
        expect(
          baseConfigText,
          "neither bare-specifier import line was found to rewrite in the historical config " +
            "-- the file's shape changed in a way this check did not anticipate",
        ).not.toBe(beforeReplace);

        const baseConfigPath = path.join(scratchDir, "base.eslint.config.mjs");
        fs.writeFileSync(baseConfigPath, baseConfigText, "utf8");

        const nestedScriptRel = path.join("nested", "packages", "foo", "scripts", "probe.mjs");
        fs.mkdirSync(path.join(scratchDir, "nested", "packages", "foo", "scripts"), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(scratchDir, nestedScriptRel),
          [
            "console.log('probe pid', process.pid);",
            "const os = await import('node:os');",
            "console.log('probe platform', os.platform());",
            "process.exitCode = 0;",
            "",
          ].join("\n"),
          "utf8",
        );

        const eslintCli = path.join(root, "node_modules", "eslint", "bin", "eslint.js");

        function runEslintInScratch(configPath: string): { status: number | null; combined: string } {
          const result = spawnSync(
            process.execPath,
            [eslintCli, "--no-config-lookup", "--config", configPath, nestedScriptRel],
            { cwd: scratchDir, encoding: "utf8", timeout: 60_000, windowsHide: true },
          );
          return {
            status: result.status,
            combined: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim(),
          };
        }

        const baseRun = runEslintInScratch(baseConfigPath);
        expect(
          baseRun.status,
          `expected a nonzero exit running the ORIGINAL (02cca56b) config against a ` +
            `nested-location .mjs script; got exit ${String(baseRun.status)}. Output:\n${baseRun.combined}`,
        ).not.toBe(0);
        expect(
          baseRun.combined,
          `expected the historical config's failure to name the type-information ` +
            `requirement (the lease request's own reproduction shape); got:\n${baseRun.combined}`,
        ).toMatch(/requires type information|@typescript-eslint\/await-thenable/);

        const candidateRun = runEslintInScratch(path.join(root, "eslint.config.mjs"));
        expect(
          candidateRun.status,
          `expected exit 0 running the LANE's CURRENT config against the same nested-location ` +
            `.mjs script; got exit ${String(candidateRun.status)}. Output:\n${candidateRun.combined}`,
        ).toBe(0);
      } finally {
        fs.rmSync(scratchDir, { recursive: true, force: true, maxRetries: 3 });
      }
    },
    60_000,
  );

  it("the current branch is unchanged (the historical config was read without checkout)", () => {
    expect(branchAtStart).not.toBe("HEAD");
    expect(currentBranch()).toBe(branchAtStart);
  });
});

describe("cleanup", () => {
  it("removes the scratch probe fixture and confirms it no longer exists", () => {
    removeProbeDir();
    expect(
      fs.existsSync(probeRoot),
      `scratch probe fixture ${probeRoot} still exists after cleanup`,
    ).toBe(false);
  });
});
