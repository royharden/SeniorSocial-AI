/**
 * what_bug_this_catches: Filesystem enumeration order or an unreviewed legacy format can make package eval coverage vary by machine or disappear without failing discovery.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertSourceDigest, discoverPackageCases, validateFixtureManifest } from "../../../evals/harness/discovery.ts";

const root = path.resolve(import.meta.dirname, "../../..");

describe("WP-022 deterministic package eval discovery", () => {
  it("discovers every current package source in stable path order with explicit adapters", () => {
    const first = discoverPackageCases(root);
    const second = discoverPackageCases(root);
    expect(first).toEqual(second);
    expect(first.sources.map((item) => item.relativePath)).toEqual([
      "evals/WP-008/zero-spend.yaml",
      "evals/WP-011/concierge-core.yaml",
      "evals/WP-021/translation-assist.eval.test.ts",
      "evals/WP-021/translation-assist.yaml",
      "evals/WP-023/hybrid-retrieval.eval.test.ts",
    ]);
    expect(first.sources.map((item) => item.kind)).toEqual(["legacy-adapted", "legacy-adapted", "executable-adapted", "legacy-adapted", "executable-adapted"]);
    expect(first.defaultCaseIds).toEqual(["EV-wp008-kill-01", "EV-wp008-cache-01", "EV-wp008-egress-01", "EV-wp011-stub-01", "EV-wp021-workflow-01", "EV-wp021-fidelity-01", "EV-wp023-hybrid-01"]);
    expect(first.sources.map((item) => item.adapterId)).toEqual(["adapter-wp008-zero-spend-v1", "adapter-wp011-concierge-v1", "adapter-wp021-translation-v1", "adapter-wp021-seed-binding-v1", "adapter-wp023-hybrid-v1"]);
    expect(first.sources.find((item) => item.bindingOnly)?.cases).toEqual([]);
    expect(() => assertSourceDigest(path.join(root, "evals", "WP-008", "zero-spend.yaml"), "adapter-wp008-zero-spend-v1", "0".repeat(64))).toThrow(/source digest mismatch/u);
    expect(() => assertSourceDigest(path.join(root, "evals", "WP-021", "translation-assist.eval.test.ts"), "adapter-wp021-translation-v1", "0".repeat(64))).toThrow(/source digest mismatch/u);
  });

  it("fails closed on unsafe, duplicate, or empty adapter mappings", () => {
    const adapter = { adapter_id: "adapter-wp008-test-v1", source: "evals/WP-008/source.yaml", source_sha256: "0".repeat(64), kind: "legacy-adapted", fixture_case_ids: ["EV-one-01"] };
    expect(() => validateFixtureManifest({ default_case_ids: ["EV-one-01"], adapters: [{ ...adapter, source: "../outside.yaml" }] })).toThrow(/Unsafe adapter source path/u);
    expect(() => validateFixtureManifest({ default_case_ids: ["EV-one-01", "EV-one-01"], adapters: [] })).toThrow(/Duplicate default/u);
    expect(() => validateFixtureManifest({ default_case_ids: ["EV-one-01"], adapters: [{ ...adapter, fixture_case_ids: [] }] })).toThrow(/has no fixture cases/u);
    expect(() => validateFixtureManifest({ default_case_ids: ["EV-one-01"], adapters: [{ ...adapter, kind: "executable-adapted" }] })).toThrow(/Invalid fixture source adapter/u);
  });
});
