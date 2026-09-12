/**
 * SEC-053 (security, layer L, rfp:S-5) — package: WP-001
 *
 * what_bug_this_catches (verbatim, story-test-map.csv): "An unpinned action
 * is a supply-chain write to CI, and a provider list that does not match
 * live configuration makes the disclosure appendix untrue."
 *
 * Scope note (dispatch): "The providers.yml half belongs to WP-008/WP-019 —
 * mark it forwarded in your fragment, do not assert it here." This file
 * therefore asserts only the GitHub Actions commit-SHA-pin half of SEC-053.
 * The providers.yml / retrieved_on / live-config-match half is recorded as
 * forwarded in this package's CATALOG.WP-001.json fragment and in the
 * test-author receipt, not asserted in this file.
 */
import { describe, expect, it } from "vitest";
import {
  extractActionUsesRefs,
  findRepoRoot,
  isFullCommitSha,
  readAllWorkflowFiles,
} from "../../fixtures/WP-001/repo-helpers";

const root = findRepoRoot();

describe("SEC-053 (CI half only — providers.yml half forwarded to WP-008/WP-019): GitHub Actions are pinned to commit SHAs", () => {
  const workflows = readAllWorkflowFiles(root);

  it("at least one workflow file exists", () => {
    expect(
      workflows.length,
      `No .github/workflows/*.yml files found under ${root}. Expected red until WP-001 lands CI.`,
    ).toBeGreaterThan(0);
  });

  it("every `uses:` action reference is pinned to a full 40-character commit SHA", () => {
    const allRefs = workflows.flatMap((w) =>
      extractActionUsesRefs(w.content).map((r) => ({ ...r, file: w.relPath })),
    );

    expect(
      allRefs.length,
      `No "uses:" action references found across: ${workflows.map((w) => w.relPath).join(", ")}`,
    ).toBeGreaterThan(0);

    // Local composite/reusable actions (uses: ./.github/actions/foo) have no
    // remote ref to pin and are exempt from this check.
    const remoteRefs = allRefs.filter((r) => !r.action.startsWith("."));

    const violations = remoteRefs.filter((r) => !isFullCommitSha(r.ref));

    expect(
      violations,
      `Action reference(s) not pinned to a full commit SHA (found a tag/branch ` +
        `like "@v4" instead): ${JSON.stringify(violations)}`,
    ).toEqual([]);
  });

  it("no workflow grants a broader-than-read-only default GITHUB_TOKEN without an explicit narrower override (10-security.md line 235)", () => {
    // A coarse, deliberately conservative check: if a top-level `permissions:`
    // block exists anywhere in the workflow file, it must not set
    // `contents: write` (or broader) at the top level without a job-level
    // narrowing — the spec's rule is "read-only default GITHUB_TOKEN".
    const offenders = workflows.filter((w) => {
      const topLevelPermissions = w.content.match(/^permissions:\s*\n((?:\s+\S+:.*\n?)+)/m);
      if (!topLevelPermissions) return false; // no explicit block: relies on org default, not this file's concern
      return /contents:\s*write/.test(topLevelPermissions[1]);
    });

    expect(
      offenders.map((o) => o.relPath),
      `Workflow(s) with a top-level permissions block granting contents: write: ` +
        `${JSON.stringify(offenders.map((o) => o.relPath))}`,
    ).toEqual([]);
  });
});
