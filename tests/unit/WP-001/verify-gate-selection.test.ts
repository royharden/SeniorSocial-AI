/**
 * CK-136 / CK-137 (unit, layer 0, rfp:T-15) — package: WP-001
 *
 * R-2 regression, attempt 3 (planning/reviews/review-WP-001-2.md finding b,
 * verdict REOPEN, reviewer 0161). Written from the review's remediation text
 * and 04-tests-and-evals.md s4.2 — never from the builder's diff.
 *
 * what_bug_this_catches (both checks in this file): "A merge gate that
 * selects zero tasks on the candidate it is gating reports green after
 * running nothing, so every later package merges past checks that never
 * executed."
 *
 * The review's finding b showed two independent ways `pnpm verify` can pass
 * while doing nothing:
 *   (1) `verify:typecheck` / `verify:lint` / `verify:unit` / `verify:integration`
 *       key their Turbo package selection solely to `--filter=...[HEAD^]`, so
 *       a candidate whose final commit only touches root config or tests
 *       selects zero workspace packages ("0 successful, 0 total") and Turbo
 *       still exits 0.
 *   (2) the root suite under tests/unit/ (this file's own directory) is not
 *       chained into `pnpm verify` at all, so all 17 WP-001 unit checks never
 *       run as part of the gate even when they exist on disk and pass
 *       directly.
 *
 * CK-097 (verify-composition.test.ts) already guards the full stage *list*
 * and ordering against 04 s4.2's fourteen named stages; this file is
 * deliberately a separate one so CK-097's existing assertions are never
 * touched (attempt-3 dispatch instruction). A stage the WP-001 repair adds
 * to make check (2) below pass (e.g. a root-suite stage inserted ahead of
 * `verify:unit`) will legitimately change the exact chain CK-097 asserts;
 * that is CK-097's business to report, not something this file papers over.
 */
import { describe, expect, it } from "vitest";
import {
  findRepoRoot,
  readRootPackageJson,
  splitAndChain,
} from "../../fixtures/WP-001/repo-helpers";

const root = findRepoRoot();
const pkg = readRootPackageJson(root);
const scripts = pkg?.scripts ?? {};

// The four stages the review names by name in finding b.
const GATED_STAGES = [
  "verify:typecheck",
  "verify:lint",
  "verify:unit",
  "verify:integration",
] as const;

/**
 * True when `cmd` selects Turbo's package set using ONLY a HEAD^-relative
 * single-parent filter — the exact shape the review's finding b names
 * (`--filter=...[HEAD^]`) — with nothing else in the command that could also
 * widen selection (an unfiltered `turbo run <task>` with no --filter at all,
 * or a filter naming the real merge base / `main`, are both acceptable and
 * must NOT trip this check).
 */
function selectsSolelyOnHeadCaret(cmd: string | undefined | null): boolean {
  if (!cmd) return false;
  // Turbo filter syntax for "packages changed since a single ref": e.g.
  // --filter=...[HEAD^] or --filter '...[HEAD^1]'. Match the ref token
  // loosely (HEAD^, HEAD^1, HEAD~1 are all single-parent-only selectors).
  const headCaretFilter = /--filter[=\s]+\S*\[\s*HEAD[\^~]\d*\s*\]/i;
  if (!headCaretFilter.test(cmd)) return false;
  // If the same command also references the real merge base or `main`
  // anywhere (e.g. a computed `$(git merge-base HEAD main)` substituted in,
  // or an explicit `...main`/`...origin/main` filter target), it is not
  // relying on HEAD^ alone — that is an acceptable shape per the dispatch.
  const alsoReferencesMainOrMergeBase = /\bmain\b|merge-base/i.test(cmd);
  return !alsoReferencesMainOrMergeBase;
}

describe("CK-136: verify's Turbo-backed stages never key selection solely to HEAD^", () => {
  it.each(GATED_STAGES)("scripts[\"%s\"] does not select solely via --filter=...[HEAD^] (or HEAD~N)", (stage) => {
    const cmd = scripts[stage];
    expect(
      cmd,
      `scripts["${stage}"] is missing from package.json — cannot evaluate its Turbo selection`,
    ).toBeTruthy();
    expect(
      selectsSolelyOnHeadCaret(cmd),
      `scripts["${stage}"] = ${JSON.stringify(cmd)} selects Turbo's package set ` +
        `solely via a HEAD^-relative single-parent filter. On a multi-commit ` +
        `candidate whose FINAL commit changes only root config or tests, this ` +
        `filter selects zero workspace packages and Turbo still exits 0 — the ` +
        `gate reports green after running nothing. Acceptable shapes: an ` +
        `unfiltered run, or a filter against the real merge base with main.`,
    ).toBe(false);
  });
});

describe("CK-137: the root unit suite (tests/unit) is chained into pnpm verify as a stage", () => {
  // Find any verify:* stage whose command actually invokes vitest over
  // tests/unit. Not hard-coded to one script key/name so a differently named
  // stage (e.g. "verify:unit:root") still satisfies the check — the
  // acceptance clause is "a stage exists and is wired", not "a stage with a
  // specific name exists".
  const rootUnitStageEntries = Object.entries(scripts).filter(([key, cmd]) => {
    if (!key.startsWith("verify:")) return false;
    if (typeof cmd !== "string") return false;
    // Match a vitest invocation whose target includes the tests/unit tree,
    // written either directly (vitest run tests/unit) or via the project's
    // verify-stage.mjs guard wrapper (... -- vitest run tests/unit), and
    // guard against a broader "tests/" target (e.g. tests/unit-something)
    // by requiring a path boundary after "unit".
    return /vitest\s+run\s+[^\n]*\btests\/unit(\/|\b)/i.test(cmd);
  });

  it("at least one verify:* stage runs vitest over tests/unit", () => {
    expect(
      rootUnitStageEntries.length,
      `No scripts["verify:*"] entry invokes "vitest run tests/unit". Observed ` +
        `verify:* scripts: ${JSON.stringify(
          Object.keys(scripts).filter((k) => k.startsWith("verify:")),
        )}. Without this stage, none of the WP-001 root unit checks under ` +
        `tests/unit/ (this file included) ever run as part of the merge gate, ` +
        `even though they exist on disk and pass when invoked directly.`,
    ).toBeGreaterThan(0);
  });

  it('that stage is actually chained into the top-level "verify" script', () => {
    expect(rootUnitStageEntries.length).toBeGreaterThan(0);
    const verify = scripts.verify ?? "";
    const tokens = splitAndChain(verify).map((t) => t.replace(/^pnpm run\s+/, "pnpm "));
    const wired = rootUnitStageEntries.some(([key]) => tokens.includes(`pnpm ${key}`));
    expect(
      wired,
      `Found a stage that runs vitest over tests/unit (${rootUnitStageEntries
        .map(([k]) => k)
        .join(", ")}) but scripts.verify does not call it. Full observed ` +
        `chain: ${JSON.stringify(tokens)}. A stage that exists but is not ` +
        `chained into "verify" is exactly as useless as one that was never ` +
        `written.`,
    ).toBe(true);
  });
});

/**
 * (c) Behavioural probe — NOT ENCODABLE within this dispatch's 35-minute
 * timebox, per the attempt-3 instruction's explicit fallback.
 *
 * Reason: a trustworthy version of "a scratch copy of the workspace with a
 * root-config-only commit on top yields nonzero Turbo tasks under the wired
 * selection" needs either (a) a second git worktree with its OWN `pnpm
 * install` (Turbo's package graph and `node_modules/.bin` resolution depend
 * on a real install, not a bare file copy) — a multi-minute operation this
 * dispatch's budget cannot absorb alongside the R-3 fixture work below — or
 * (b) running the real `turbo run typecheck`/`lint` unfiltered directly
 * against THIS worktree on a synthetic root-config-only HEAD, which the
 * builder (0148) is concurrently editing under its own dispatch-3 lease in
 * this exact worktree; mutating HEAD here to stage a probe commit would race
 * that lease. Checks CK-136 (structural: no command may rely solely on a
 * HEAD^ single-parent filter) and CK-137 (structural: the root suite is
 * chained into verify) cover the same underlying defect at the configuration
 * level — a command that passes both cannot exhibit the zero-task failure
 * mode the review demonstrated, regardless of which commit HEAD is at.
 */
