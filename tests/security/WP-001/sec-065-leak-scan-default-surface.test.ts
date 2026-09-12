/**
 * SEC-076 / SEC-077 (security, layer L, rfp:T-15) — package: WP-001
 *
 * RENUMBERED at attempt 5, dispatch 8 (this dispatch's item 6, planning/
 * reviews/review-WP-001-4.md remediation 4 second half): CK-141 (tests/unit/
 * WP-001/check-id-uniqueness.test.ts), the global check-id uniqueness sweep
 * this dispatch adds, found that this file's original ids -- SEC-065 and
 * SEC-066 -- collide with story-test-map.csv's OWN SEC-065 (assigned to
 * WP-003) and SEC-066 (assigned to WP-009). Same class of defect as the
 * CK-098/CK-099 collision found and repaired at dispatch 7 (WP-001's own
 * catalog independently reused ids the shared map later assigned elsewhere);
 * this one was not caught until CK-141's broader sweep because it is in the
 * SEC- namespace, not CK-. Renumbered to SEC-076 / SEC-077 -- the next free
 * ids after the confirmed high-water mark (SEC-075 across story-test-map.csv
 * and this catalog combined). Every assertion, it() title, expect() message
 * and the what_bug_this_catches text below is unchanged from before the
 * renumber; only the four label occurrences (this header, the two describe()
 * titles, and the CATALOG.WP-001.json entries) changed, confirmed by re-grep.
 * story-test-map.csv was NOT edited (not this author's file).
 *
 * R-3 regression, attempt 3 (planning/reviews/review-WP-001-2.md finding b,
 * verdict REOPEN, reviewer 0161). Written from the review's remediation text
 * — never from the builder's diff.
 *
 * what_bug_this_catches (both checks in this file): "A leak scan wired to a
 * subset of the public surface passes while a customer term sits in a root
 * config file or a workflow that ships to the public repo."
 *
 * The review's finding b showed `verify:leak` supplying an explicit
 * `-Paths apps,packages,infra` override, which scripts/leak-scan.ps1 treats
 * as "scan exactly this" — its own default additions (root config files and
 * .github/workflows) are suppressed whenever the caller binds -Paths at all
 * (see leak-scan.ps1's `$scoped = $PSBoundParameters.ContainsKey('Paths')`).
 * Measured by the reviewer: 24 files under the default invocation vs 13
 * under the wired one.
 *
 * SEC-054 (sec-054-leak-scan-wired-fail-closed.test.ts) already proves the
 * scanner fails closed on a planted term UNDER apps/ via an explicit
 * path-scope override — that file and its check id are untouched by this
 * dispatch. This file is deliberately separate and proves the opposite half
 * of the surface: files the *default*, unscoped invocation is supposed to
 * reach (root config, .github/workflows) that a `-Paths`-scoped invocation
 * would miss.
 *
 * Fixture technique: this test-author session may not write under root
 * config or .github (builder-owned paths). So the target files are never
 * the real repo's own package.json/.github — they are freshly created,
 * root-config-*shaped* files inside an outside-tree scratch directory
 * (os.tmpdir(), well outside this worktree), scanned by a COPY of the real
 * scripts/leak-scan.ps1 + scripts/verify-stage.mjs invoked exactly as
 * package.json's own scripts["verify:leak"] string names them — same
 * argv, same "--" absence, same lack of any -Paths override — so this test
 * proves the exact wired command's behaviour, not an approximation of it.
 * The scanner resolves its own scan root from its own script location
 * (verify-stage.mjs's `import.meta.url`, leak-scan.ps1's `$PSScriptRoot`),
 * which is why the scripts must be copied alongside the scratch fixtures
 * rather than pointed at from a distance.
 *
 * The planted term is the existing invented SEC-054 fixture term
 * ("zzyzxglarnok", tests/fixtures/WP-001/leak-terms.synthetic.txt) — never a
 * real customer term, per the dispatch.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findRepoRoot, readRootPackageJson } from "../../fixtures/WP-001/repo-helpers";

const root = findRepoRoot();
const pkg = readRootPackageJson(root);
const SYNTHETIC_TERMS_FILE = path.join(
  root,
  "tests",
  "fixtures",
  "WP-001",
  "leak-terms.synthetic.txt",
);
const PLANTED_TERM = "zzyzxglarnok";

const REAL_VERIFY_STAGE = path.join(root, "scripts", "verify-stage.mjs");
const REAL_LEAK_SCAN = path.join(root, "scripts", "leak-scan.ps1");

const scratchDirs: string[] = [];

/**
 * Builds an outside-tree scratch "repo root" holding a COPY of the two
 * scanner scripts (so their self-located REPO_ROOT resolution lands on the
 * scratch dir, not the real worktree) plus a root-config-shaped
 * package.json and a .github/workflows/ci.yml, both clean unless
 * `plantIn` says otherwise.
 */
function buildScratchRepo(plantIn: "none" | "package.json" | "workflow"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wp001-sec065-"));
  scratchDirs.push(dir);

  const scriptsDir = path.join(dir, "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.copyFileSync(REAL_VERIFY_STAGE, path.join(scriptsDir, "verify-stage.mjs"));
  fs.copyFileSync(REAL_LEAK_SCAN, path.join(scriptsDir, "leak-scan.ps1"));

  // A root-config-shaped file: a plausible package.json. The synthetic term
  // sits in a comment-shaped field a real package.json could plausibly carry
  // (an npm "config" note), never in a position that would break JSON parse.
  const pkgJson: Record<string, unknown> = {
    name: "scratch-root-config-fixture",
    private: true,
  };
  if (plantIn === "package.json") {
    pkgJson._leakProbeNote = `internal codename ${PLANTED_TERM} — do not ship`;
  }
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkgJson, null, 2), "utf8");

  const workflowsDir = path.join(dir, ".github", "workflows");
  fs.mkdirSync(workflowsDir, { recursive: true });
  const workflowLines = [
    "name: ci",
    "on: [push]",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
  ];
  if (plantIn === "workflow") {
    workflowLines.push(`      # ${PLANTED_TERM} — internal codename, scratch fixture only`);
  }
  fs.writeFileSync(path.join(workflowsDir, "ci.yml"), workflowLines.join("\n") + "\n", "utf8");

  return dir;
}

/**
 * Invokes the scratch repo's copy of verify-stage.mjs with EXACTLY the argv
 * package.json's own scripts["verify:leak"] names (split on whitespace,
 * dropping the leading "node" token) — same flags, same absent "--"
 * separator, same absent -Paths override — so no scope-widening is
 * introduced by this test itself.
 */
function runWiredLeakStage(scratchRoot: string): { status: number | null; stdout: string; stderr: string } {
  const leakCmd = pkg?.scripts?.["verify:leak"] ?? "";
  const tokens = leakCmd.trim().split(/\s+/);
  expect(
    tokens[0] === "node" && tokens[1] === "scripts/verify-stage.mjs",
    `scripts["verify:leak"] = ${JSON.stringify(leakCmd)} does not start with the ` +
      `expected "node scripts/verify-stage.mjs" form this probe assumes.`,
  ).toBe(true);
  const wiredArgs = tokens.slice(2); // everything after "node scripts/verify-stage.mjs"

  const res = spawnSync(
    process.execPath,
    [path.join(scratchRoot, "scripts", "verify-stage.mjs"), ...wiredArgs],
    {
      cwd: scratchRoot,
      env: { ...process.env, LEAK_TERMS_FILE: SYNTHETIC_TERMS_FILE },
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
    },
  );
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

afterEach(() => {
  for (const d of scratchDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("SEC-076: the exact wired verify:leak command reaches an outside-tree scratch root config file and workflow", () => {
  it(
    "sanity control: a clean scratch repo (no planted term) exits 0 under the exact wired command",
    () => {
      const scratch = buildScratchRepo("none");
      const result = runWiredLeakStage(scratch);
      expect(
        result.status,
        `Expected exit 0 on a clean scratch repo. Got status=${result.status}, ` +
          `stdout=${result.stdout.slice(0, 800)}, stderr=${result.stderr.slice(0, 800)}`,
      ).toBe(0);
    },
    60_000,
  );

  it(
    "exits nonzero when the synthetic term sits in the scratch repo's root package.json",
    () => {
      const scratch = buildScratchRepo("package.json");
      const result = runWiredLeakStage(scratch);
      expect(
        result.status,
        `Expected a nonzero exit when "${PLANTED_TERM}" sits in the scratch ` +
          `repo's root package.json under the exact wired verify:leak command. ` +
          `A leak scan wired to a subset of the public surface would pass here ` +
          `while a customer term ships in root config. Got status=${result.status}, ` +
          `stdout=${result.stdout.slice(0, 800)}, stderr=${result.stderr.slice(0, 800)}`,
      ).not.toBe(0);
    },
    60_000,
  );

  it(
    "exits nonzero when the synthetic term sits in the scratch repo's .github/workflows/ci.yml",
    () => {
      const scratch = buildScratchRepo("workflow");
      const result = runWiredLeakStage(scratch);
      expect(
        result.status,
        `Expected a nonzero exit when "${PLANTED_TERM}" sits in the scratch ` +
          `repo's .github/workflows/ci.yml under the exact wired verify:leak ` +
          `command. A leak scan wired to a subset of the public surface would ` +
          `pass here while a customer term ships in a workflow that is part of ` +
          `the public repo. Got status=${result.status}, ` +
          `stdout=${result.stdout.slice(0, 800)}, stderr=${result.stderr.slice(0, 800)}`,
      ).not.toBe(0);
    },
    60_000,
  );
});

describe("SEC-077: verify:leak's wired invocation does not narrow the scan surface to apps,packages,infra", () => {
  it('scripts["verify:leak"] either passes no -Paths/--paths override, or names root config and .github explicitly', () => {
    const leakCmd = pkg?.scripts?.["verify:leak"] ?? "";
    expect(leakCmd, 'scripts["verify:leak"] is missing').toBeTruthy();

    const pathsFlag = leakCmd.match(/-{1,2}paths\s+(\S+)/i);
    if (!pathsFlag) {
      // No override at all -> leak-scan.ps1's own default branch runs,
      // which includes its root-config file list and .github/workflows.
      // This is the acceptable, non-narrowing shape.
      expect(true).toBe(true);
      return;
    }

    const scopedValue = pathsFlag[1];
    const namesRootConfigOrGithub =
      /(^|,)(\.github|package\.json|readme\.md|turbo\.json|pnpm-workspace\.yaml)(,|$)/i.test(
        scopedValue,
      );
    expect(
      namesRootConfigOrGithub,
      `scripts["verify:leak"] = ${JSON.stringify(leakCmd)} passes an explicit ` +
        `-Paths override (${JSON.stringify(scopedValue)}) that narrows the scan ` +
        `to those directories only. scripts/leak-scan.ps1 treats ANY explicit ` +
        `-Paths as "scan exactly this" and suppresses its own default ` +
        `root-config/.github additions (measured by the reviewer: 24 files ` +
        `under the default invocation vs 13 under this scoped one). Either ` +
        `drop the override entirely or add root-config/.github coverage to it ` +
        `explicitly.`,
    ).toBe(true);
  });
});
