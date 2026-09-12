/**
 * SEC-050 (security, layer L, rfp:T-15) — package: WP-001
 *
 * what_bug_this_catches (verbatim, story-test-map.csv): "An install without
 * a frozen lockfile resolves a different dependency tree than the one
 * reviewed, and an unaudited high-severity advisory ships with it." This
 * check must additionally catch the regression ADR-012 documents: npm audit
 * ENOLOCK on a pnpm workspace must not be the merge gate.
 *
 * Acceptance text (work-packages-overlay.csv row / launch note): "frozen
 * lockfile on install; audit at high severity passes."
 *
 * Spec sources: 10-security.md s"MVP controls" (line 235): "`pnpm install
 * --frozen-lockfile` everywhere including CI ... `pnpm audit --audit-level
 * high` inside `pnpm verify`". 04-tests-and-evals.md s4.2's exact composition
 * (cycle-3 research) had instead pinned `"verify:audit": "npm audit
 * --audit-level=high"`, reasoning that npm "reads the same lockfile and
 * answers in seconds."
 *
 * Ruling ADR-012 (DK-011, supersedes ADR-007/DK-005, 2026-09-10):
 * independently re-run in this worktree, `npm audit --audit-level=high`
 * exits 1 with ENOLOCK ("This command requires an existing lockfile")
 * because this tree has no package-lock.json — only pnpm-lock.yaml + pnpm
 * node_modules. `pnpm audit --audit-level high` exits 0, "No known
 * vulnerabilities found." npm audit ENOLOCK on a pnpm workspace must not be
 * the merge gate: shipping the npm-audit string would make every `pnpm
 * verify` red for a missing npm lockfile, and synthesizing a
 * package-lock.json to feed npm audit is forbidden (verify:lockfile exists
 * to prevent a second resolution truth). `verify:audit` is therefore
 * `pnpm audit --audit-level high` — 10-security.md's wording wins over 04
 * s4.2's npm-audit sketch, which is superseded. This test asserts the audit
 * *severity threshold* (high) and *frozen install* unconditionally, and now
 * asserts the merge-gate `verify:audit` stage as `pnpm audit --audit-level
 * high` per ADR-012.
 */
import { describe, expect, it } from "vitest";
import {
  findRepoRoot,
  readAllWorkflowFiles,
  readRootPackageJson,
} from "../../fixtures/WP-001/repo-helpers";
import fs from "node:fs";
import path from "node:path";

const root = findRepoRoot();
const pkg = readRootPackageJson(root);

describe("SEC-050: frozen lockfile on install; pnpm audit --audit-level high in the merge gate", () => {
  it("pnpm-lock.yaml exists at the repo root (a frozen install has nothing to freeze without it)", () => {
    const lockPath = path.join(root, "pnpm-lock.yaml");
    expect(
      fs.existsSync(lockPath),
      `pnpm-lock.yaml not found at ${lockPath}. Expected red until the WP-001 ` +
        `builder runs an initial \`pnpm install\` and commits the lockfile.`,
    ).toBe(true);
  });

  it("CI installs with --frozen-lockfile", () => {
    const workflows = readAllWorkflowFiles(root);
    expect(
      workflows.length,
      `No .github/workflows/*.yml files found under ${root}. Expected red ` +
        `until WP-001 lands CI.`,
    ).toBeGreaterThan(0);

    const hasFrozenInstall = workflows.some((w) =>
      /pnpm\s+install[^\n]*--frozen-lockfile/.test(w.content),
    );
    expect(
      hasFrozenInstall,
      `No workflow step runs "pnpm install --frozen-lockfile". Checked: ` +
        workflows.map((w) => w.relPath).join(", "),
    ).toBe(true);
  });

  it('verify:audit runs "pnpm audit --audit-level high" (ADR-012, DK-011, supersedes ADR-007)', () => {
    expect(
      pkg,
      "root package.json not found — expected red until WP-001 lands it",
    ).not.toBeNull();
    const script = pkg?.scripts?.["verify:audit"];
    expect(
      script,
      'scripts["verify:audit"] is missing from package.json',
    ).toBeTruthy();
    expect(
      script,
      `scripts["verify:audit"] = ${JSON.stringify(script)}, expected exactly ` +
        `"pnpm audit --audit-level high" per ADR-012: npm audit ENOLOCK on a ` +
        `pnpm workspace must not be the merge gate.`,
    ).toBe("pnpm audit --audit-level high");
  });

  it('"verify" chains "pnpm verify:audit" so the audit actually gates the merge queue', () => {
    const verify = pkg?.scripts?.verify ?? "";
    expect(
      verify.includes("pnpm verify:audit"),
      `scripts.verify does not call "pnpm verify:audit": ${JSON.stringify(verify)}`,
    ).toBe(true);
  });

  it("treats the root workspace resolution policy as a reviewed lockfile declaration", () => {
    const source = fs.readFileSync(path.join(root, "scripts", "lockfile-diff.mjs"), "utf8");
    expect(source).toContain("pnpm-workspace\\.yaml$");
    expect(source).toContain("declarationsChanged");
    expect(source).toContain("maxBuffer: 16 * 1024 * 1024");
  });

  it("Dependabot is enabled on the public repository (10-security.md line 235)", () => {
    const dependabotPath = path.join(root, ".github", "dependabot.yml");
    expect(
      fs.existsSync(dependabotPath),
      `${dependabotPath} not found. Expected red until WP-001 lands it; note ` +
        `.github/dependabot.yml describes the *public* mirror's Dependabot ` +
        `config, which is forwarded/reviewed at sync time (C5) — this test ` +
        `only asserts the file exists in this tree.`,
    ).toBe(true);
  });
});
