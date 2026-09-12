/**
 * CK-138 / CK-139 (unit, layer 0, rfp:T-15) — package: WP-001
 *
 * Maintenance regression, attempt 5, SECOND PASS (dispatch 8: planning/reviews/
 * review-WP-001-4.md, verdict REOPEN, reviewer 0161; remediation 1). Written
 * from the review's remediation text and 03-parallel-build-architecture.md /
 * 04-tests-and-evals.md's description of `pnpm verify` as the merge gate —
 * never from the builder's turbo.json diff, which does not exist yet at
 * freeze time (builder 0148 has not been dispatched this attempt).
 *
 * WHAT CHANGED FROM DISPATCH 7's CK-138 (both corrections come from the
 * review, not this author's own re-reading):
 *
 *   1. Dispatch 7's CK-138 demanded that BOTH the "lint" task (re:
 *      eslint.config.mjs) AND the "typecheck" task (re: tsconfig.base.json)
 *      carry their own task-level `inputs` array. O1 independently verified
 *      turbo.json at 19:33Z that `globalDependencies` already lists
 *      "tsconfig.base.json" (confirmed again this dispatch — see turbo.json
 *      read below), so tsconfig.base.json is ALREADY part of every task's
 *      cache key, typecheck included, by the existing design. Demanding a
 *      task-level duplicate on top of that fights the design rather than
 *      testing it. CK-138 is restated below as the single property the
 *      review actually names: "the lint task's cache key must depend on
 *      eslint.config.mjs", satisfied by EITHER a globalDependencies entry OR
 *      a lint-task-level `inputs` entry. The typecheck/tsconfig.base.json
 *      half is dropped as a live assertion — it is already true by the
 *      existing globalDependencies design and re-asserting it under the
 *      corrected accept-either-mechanism rule would just be a duplicate,
 *      already-green regression guard the review did not ask for.
 *   2. Dispatch 7 recorded the behavioural probe (CK-139) as NOT ENCODABLE,
 *      reasoning that a scratch copy needs a working node_modules to run
 *      Turbo standalone and this worktree's node_modules is 495 MB. That
 *      reasoning missed `turbo`'s own `--cwd` flag: turbo does not need the
 *      TARGET workspace to have any node_modules of its own — `--cwd` only
 *      changes which workspace turbo resolves package/task graphs against;
 *      the turbo BINARY itself still resolves from this lane's own install
 *      (node_modules/.bin/turbo.CMD on this platform), so a minimal, ~5-file
 *      scratch workspace built directly under os.tmpdir() is sufficient.
 *      CK-139 is added below using exactly that method. No node_modules copy,
 *      no lane mutation.
 *
 * what_bug_this_catches (verbatim, unchanged from dispatch 7): "A gate task
 * whose cache key ignores the root config replays a green result for a
 * config change that could have broken every package, which is a merge gate
 * reporting success for work it did not do."
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findRepoRoot, gitInvocation } from "../../fixtures/WP-001/repo-helpers";

const root = findRepoRoot();
const turboJsonPath = path.join(root, "turbo.json");
const raw = fs.existsSync(turboJsonPath) ? fs.readFileSync(turboJsonPath, "utf8") : null;
const turboConfig: {
  globalDependencies?: string[];
  tasks?: Record<string, { inputs?: string[] } | undefined>;
} = raw ? JSON.parse(raw) : {};

/**
 * True when `inputs` (a task's own `inputs` array, concatenated with
 * turbo.json's top-level `globalDependencies` — either location makes the
 * file part of the task's cache key) names `fileBasename` at the repo root.
 * Accepts the root-relative forms Turbo recognises: a bare filename, a
 * `//`-prefixed root-relative path, and a `$TURBO_ROOT$/`-prefixed path.
 * Deliberately does NOT accept a bare glob like "*.mjs" as satisfying this
 * check for a specific file — the acceptance criterion is that the root
 * config file is named, not that some broader pattern happens to catch it.
 */
function inputsNameRootFile(inputs: string[] | undefined, fileBasename: string): boolean {
  if (!inputs || inputs.length === 0) return false;
  const acceptable = new Set([
    fileBasename,
    `//${fileBasename}`,
    `$TURBO_ROOT$/${fileBasename}`,
  ]);
  return inputs.some((entry) => acceptable.has(entry));
}

describe("CK-138: the \"lint\" task's cache key depends on eslint.config.mjs (via own inputs or globalDependencies)", () => {
  it("turbo.json exists and parses", () => {
    expect(raw, `turbo.json not found at ${turboJsonPath}`).toBeTruthy();
  });

  it(
    'the "lint" task\'s cache key names eslint.config.mjs, either in its own ' +
      '"inputs" or in turbo.json\'s top-level "globalDependencies"',
    () => {
      const task = turboConfig.tasks?.lint;
      const taskInputs = task?.inputs;
      const globalDeps = turboConfig.globalDependencies;
      const combined = [...(taskInputs ?? []), ...(globalDeps ?? [])];
      expect(
        inputsNameRootFile(combined, "eslint.config.mjs"),
        `Neither tasks.lint.inputs nor turbo.json's top-level globalDependencies ` +
          `names eslint.config.mjs. Observed tasks.lint.inputs: ` +
          `${JSON.stringify(taskInputs)}; globalDependencies: ` +
          `${JSON.stringify(globalDeps)}. lint reads eslint.config.mjs from the ` +
          `repo root via ESLint's own config resolution, so a "lint" task whose ` +
          `cache key never mentions that file — by either mechanism — will replay ` +
          `a green (or cached) result after an edit that could break lint on ` +
          `every package. Either mechanism satisfies this check: a globalDependencies ` +
          `entry (which also changes every OTHER task's hash, by construction — that ` +
          `is an accepted side effect of the global mechanism, not a defect) or a ` +
          `lint-task-local "inputs" entry (which changes only lint's own hash).`,
      ).toBe(true);
    },
  );

  it(
    "non-blocking context: tsconfig.base.json is already covered for typecheck via globalDependencies (accept-either-mechanism, not a task-level duplicate demand)",
    () => {
      // O1 measured at 19:33Z, and this dispatch re-confirms by reading the
      // same file above, that "tsconfig.base.json" already sits in
      // turbo.json's top-level globalDependencies -- so typecheck's cache key
      // already depends on it by the existing design. Asserted here (accepting
      // the SAME either-mechanism rule CK-138 uses above) only as a currently-
      // green regression guard -- this is not the dropped task-level-duplicate
      // demand from dispatch 7, which additionally required typecheck to carry
      // its OWN "inputs" array even though globalDependencies already covers
      // it. A future edit that removed tsconfig.base.json from
      // globalDependencies WITHOUT adding a task-level replacement would be
      // new information worth its own CK, not silently absorbed into CK-138.
      const globalDeps = turboConfig.globalDependencies ?? [];
      const typecheckInputs = turboConfig.tasks?.typecheck?.inputs;
      const combined = [...(typecheckInputs ?? []), ...globalDeps];
      expect(
        inputsNameRootFile(combined, "tsconfig.base.json"),
        `tsconfig.base.json is no longer covered by either turbo.json's ` +
          `globalDependencies or tasks.typecheck.inputs. Observed ` +
          `globalDependencies: ${JSON.stringify(globalDeps)}; ` +
          `tasks.typecheck.inputs: ${JSON.stringify(typecheckInputs)}.`,
      ).toBe(true);
    },
  );
});

function gitStatusPorcelain(): string[] {
  const git = gitInvocation(root, ["status", "--porcelain"]);
  const status = spawnSync(git.command, git.args, {
    cwd: git.cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return (status.stdout ?? "").split(/\r?\n/).filter((l) => l.length > 0);
}

describe("CK-139: turbo's lint task hash actually changes when the root config it depends on changes, and reverts when restored (outside-tree, --cwd probe)", () => {
  let scratchDir: string | null = null;
  // Snapshotted at describe-setup time (before the scratch probe below ever
  // runs) rather than compared against a hardcoded expected list -- this
  // file's sibling test files are legitimately edited across this same
  // dispatch, so a fixed "known dirty set" would go stale the moment other
  // in-progress work changes. The only thing this check cares about is
  // whether THIS probe adds anything NEW.
  let statusBeforeProbe: string[] = [];

  beforeAll(() => {
    statusBeforeProbe = gitStatusPorcelain();
  });

  afterAll(() => {
    if (scratchDir && fs.existsSync(scratchDir)) {
      fs.rmSync(scratchDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  function runTurboDryJson(cwd: string): { hash: string; raw: string; status: number | null } {
    const result = spawnSync("pnpm", ["exec", "turbo", "run", "lint", "--cwd", cwd, "--dry=json"], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
      shell: true,
    });
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    if (result.status !== 0) {
      throw new Error(
        `turbo --cwd ${cwd} --dry=json exited ${String(result.status)} (spawn error: ` +
          `${result.error ? String(result.error) : "none"}).\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
    let parsed: { tasks?: Array<{ hash?: string }> };
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      throw new Error(
        `turbo --dry=json stdout did not parse as JSON: ${String(e)}\nstdout:\n${stdout}`,
      );
    }
    const hash = parsed.tasks?.[0]?.hash;
    if (!hash) {
      throw new Error(`turbo --dry=json produced no tasks[0].hash. Full output:\n${stdout}`);
    }
    return { hash, raw: stdout, status: result.status };
  }

  it(
    "baseline hash -> mutate scratch root config -> hash changes -> restore -> hash reverts to baseline",
    () => {
      scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "wp001-ck139-"));
      const dir = scratchDir;

      fs.writeFileSync(
        path.join(dir, "package.json"),
        `${JSON.stringify(
          { name: "ck139-scratch-root", version: "0.0.0", private: true, packageManager: "pnpm@11.9.0" },
          null,
          2,
        )}\n`,
        "utf8",
      );
      fs.writeFileSync(path.join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n", "utf8");
      // A minimal, syntactically valid lockfile silences turbo's "lockfile
      // not found" workspace-resolution warning; its content plays no role
      // in the hash being measured (the probed dependency is the scratch
      // "root.config.mjs" file named in globalDependencies below, not the
      // lockfile).
      fs.writeFileSync(
        path.join(dir, "pnpm-lock.yaml"),
        "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n  packages/a: {}\n",
        "utf8",
      );
      fs.writeFileSync(
        path.join(dir, "turbo.json"),
        `${JSON.stringify(
          {
            $schema: "https://turbo.build/schema.json",
            globalDependencies: ["root.config.mjs"],
            tasks: { lint: { outputs: [] } },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      const rootConfigPath = path.join(dir, "root.config.mjs");
      fs.writeFileSync(rootConfigPath, "export default { baseline: true };\n", "utf8");
      fs.mkdirSync(path.join(dir, "packages", "a"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "packages", "a", "package.json"),
        `${JSON.stringify(
          { name: "a", version: "0.0.0", private: true, scripts: { lint: 'node -e "process.exit(0)"' } },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const baseline = runTurboDryJson(dir);

      fs.writeFileSync(rootConfigPath, "export default { baseline: false, mutated: true };\n", "utf8");
      const modified = runTurboDryJson(dir);

      expect(
        modified.hash,
        `Editing the scratch workspace's root config file (named in turbo.json's ` +
          `globalDependencies, the same mechanism CK-138 accepts for eslint.config.mjs) ` +
          `did not change the lint task's --dry=json hash. Baseline: ${baseline.hash}; ` +
          `after edit: ${modified.hash}. This is the exact stale-cache failure mode the ` +
          `builder measured for the real lane's eslint.config.mjs: a task whose hash does ` +
          `not move when its declared root dependency changes will replay a cached green ` +
          `result for a config change that could break every package.`,
      ).not.toBe(baseline.hash);

      fs.writeFileSync(rootConfigPath, "export default { baseline: true };\n", "utf8");
      const restored = runTurboDryJson(dir);

      expect(
        restored.hash,
        `After restoring the scratch root config to its original byte content, the lint ` +
          `task's hash did not return to the original baseline. Baseline: ${baseline.hash}; ` +
          `restored: ${restored.hash}. A cache key that is deterministic in one direction ` +
          `but not the other would itself be a defect (either a hidden nondeterministic ` +
          `input, or the hash never actually depending on file CONTENT, only on some other ` +
          `side channel).`,
      ).toBe(baseline.hash);

      // Deliberately NOT asserted: that some OTHER, unrelated task's hash stays
      // unchanged across this edit. A globalDependencies entry changes EVERY
      // task's hash by construction (that is what "global" means) — asserting
      // an unaffected task's hash would be false against a correct repair that
      // uses globalDependencies, per this dispatch's own correction to CK-138.
    },
    60_000,
  );

  it("this lane's own git status gained nothing new from the scratch probe above", () => {
    const statusAfterProbe = gitStatusPorcelain();
    const beforeSet = new Set(statusBeforeProbe);
    const newLines = statusAfterProbe.filter((line) => !beforeSet.has(line));
    expect(
      newLines,
      `The CK-139 scratch probe left an unexpected NEW mark on this lane's own git ` +
        `status (present after the probe but not before it started): ` +
        `${JSON.stringify(newLines)}. Compared against the snapshot taken before the ` +
        `probe ran (not a hardcoded list) so this check stays correct regardless of ` +
        `what else this dispatch's other in-progress edits have touched. The probe is ` +
        `built entirely under os.tmpdir() and must never touch the lane.`,
    ).toEqual([]);
  });
});
