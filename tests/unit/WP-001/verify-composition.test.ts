/**
 * CK-097 (unit, layer 0, rfp:T-15) — package: WP-001
 *
 * what_bug_this_catches (verbatim, story-test-map.csv / 04-tests-and-evals.md
 * s4.4): "A stage quietly removed from the verify chain when it went red
 * means every later package passes a gauntlet that no longer contains that
 * check."
 *
 * Spec: 04-tests-and-evals.md s4.2 "pnpm verify — exact composition" states
 * the root package.json script block verbatim, and its own closing note says
 * this exact test exists: "`verify` is its own smoke test:
 * tests/unit/WP-001/verify-composition.test.ts parses package.json and fails
 * if any named stage is missing from the verify chain ... so a stage cannot
 * be quietly dropped when it goes red." This file is that test.
 *
 * Acceptance clause covered (work-packages-overlay.csv, WP-001 row): "pnpm
 * verify runs all ten gates and exits 0 on an empty app". NOTE: the overlay
 * row says "ten gates" but 04-tests-and-evals.md s4.2's exact composition
 * (cycle-3 research) names fourteen verify:* stages chained under `verify`.
 * The launch note for this dispatch explicitly directs asserting the
 * fourteen-stage list from 04 s4.2, which is the more specific and more
 * recently revised source; the "ten gates" wording in the overlay is a stale
 * summary. This discrepancy is filed as a docket submission (see this
 * package's test-author receipt) rather than silently resolved.
 */
import { describe, expect, it } from "vitest";
import {
  findRepoRoot,
  looksLikeNoOp,
  readRootPackageJson,
  splitAndChain,
} from "../../fixtures/WP-001/repo-helpers";

// Exact order and names from 04-tests-and-evals.md s4.2's `"verify": "..."` line.
const EXPECTED_STAGE_ORDER = [
  "verify:typecheck",
  "verify:lint",
  "verify:contracts",
  "verify:unit",
  "verify:integration",
  "verify:contract-tests",
  "verify:e2e:changed",
  "verify:a11y:shell",
  "verify:evals:stub",
  "verify:security",
  "verify:leak",
  "verify:secrets",
  "verify:lockfile",
  "verify:audit",
] as const;

describe("CK-097: pnpm verify chains every verify:* stage from 04 s4.2, none a no-op", () => {
  const root = findRepoRoot();
  const pkg = readRootPackageJson(root);

  it("has a root package.json with a scripts block (blocked until WP-001 lands)", () => {
    expect(
      pkg,
      `No package.json found by walking up from ${root}. This is the ` +
        `expected red state before the WP-001 builder lands a root ` +
        `package.json; re-run once it exists.`,
    ).not.toBeNull();
    expect(pkg?.scripts, "package.json has no \"scripts\" block").toBeTruthy();
  });

  it('the "verify" script exists and is a non-empty string', () => {
    const verify = pkg?.scripts?.verify;
    expect(
      verify,
      'scripts.verify is missing or empty — "pnpm verify" would resolve to nothing',
    ).toBeTruthy();
  });

  it("the verify chain calls every verify:* stage named in 04 s4.2, in order, with no stage silently dropped", () => {
    const verify = pkg?.scripts?.verify;
    const tokens = splitAndChain(verify).map((t) => t.replace(/^pnpm run\s+/, "pnpm "));

    const expectedTokens = EXPECTED_STAGE_ORDER.map((stage) => `pnpm ${stage}`);

    // Report exactly which stages are missing, not just "chain doesn't match" —
    // that is the whole point of this check per its what_bug_this_catches text.
    const missing = expectedTokens.filter((t) => !tokens.includes(t));
    expect(
      missing,
      `verify chain is missing these stages: ${JSON.stringify(missing)}. ` +
        `Full observed chain: ${JSON.stringify(tokens)}`,
    ).toEqual([]);

    // Order matters too: 04 s4.2 states one specific ordering and a reordered
    // chain that happens to include every token is still a spec deviation
    // worth catching (e.g. security running after leak/secrets rather than
    // before them would change what a red run tells you).
    expect(
      tokens,
      `verify chain does not match the exact ordering in 04-tests-and-evals.md s4.2.`,
    ).toEqual(expectedTokens);
  });

  it.each(EXPECTED_STAGE_ORDER)(
    "stage script %s exists on package.json and is not a no-op placeholder",
    (stage) => {
      const script = pkg?.scripts?.[stage];
      expect(
        script,
        `scripts["${stage}"] is missing from package.json even though ` +
          `"verify" is expected to call it`,
      ).toBeTruthy();
      expect(
        looksLikeNoOp(script),
        `scripts["${stage}"] = ${JSON.stringify(script)} looks like a ` +
          `placeholder/no-op rather than a real check — this is exactly the ` +
          `EMR-SO failure mode this check exists to catch`,
      ).toBe(false);
    },
  );
});
