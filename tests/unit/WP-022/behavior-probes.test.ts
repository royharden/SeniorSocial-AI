/**
 * what_bug_this_catches: An adapter can invoke real package code but grade only labels, allowing broken gateway controls or retrieval ordering to remain green.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateWp008Evidence, validateWp021FidelityEvidence, validateWp021WorkflowEvidence, validateWp023Evidence } from "../../../evals/harness/probes.ts";
import { enforceFloors, type Floors } from "../../../evals/harness/runner.ts";
import type { CaseResult } from "../../../evals/harness/types.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const floors = JSON.parse(fs.readFileSync(path.join(root, "evals", "floors.json"), "utf8")) as Floors;

function probeResult(caseId: string, floorGroup: string, assertions: CaseResult["assertions"]): CaseResult {
  const passed = assertions.every((item) => item.passed);
  const packageId = caseId.includes("wp008") ? "WP-008" : caseId.includes("wp021") ? "WP-021" : "WP-023";
  const source = packageId === "WP-008" ? "evals/WP-008/zero-spend.yaml" : packageId === "WP-021" ? "evals/WP-021/translation-assist.eval.test.ts" : "evals/WP-023/hybrid-retrieval.eval.test.ts";
  return { case_id: caseId, source, package_id: packageId, floor_group: floorGroup, must_pass: false, status: passed ? "pass" : "fail", score: passed ? 1 : 0, provider: "stub", model: "broken-probe", external_calls: 0, billable_tokens: 0, cost_usd: 0, assertions };
}

describe("WP-022 behavioral probe regression sensitivity", () => {
  it("fails WP-008 evidence when provider isolation, cache visibility, or pre-transport egress blocking breaks", () => {
    const assertions = validateWp008Evidence({
      killed: { outcome: "ok", humanRoute: undefined, providerCalls: 1, events: 0 },
      cache: { firstCacheHit: false, secondCacheHit: false, providerCalls: 2, events: 1, costs: [0.01] },
      egress: { blocked: false, transportCalls: 1 },
    });
    expect(Object.values(assertions).flat().every((item) => item.passed)).toBe(false);
    expect(assertions["EV-wp008-kill-01"]?.some((item) => !item.passed)).toBe(true);
    expect(assertions["EV-wp008-cache-01"]?.some((item) => !item.passed)).toBe(true);
    expect(assertions["EV-wp008-egress-01"]?.some((item) => !item.passed)).toBe(true);
    expect(() => enforceFloors([probeResult("EV-wp008-kill-01", "over_reliance", assertions["EV-wp008-kill-01"] ?? [])], floors)).toThrow(/Regression floor breach/u);
  });

  it("fails WP-023 evidence when exact order or citation-only response shape breaks", () => {
    const assertions = validateWp023Evidence({ ids: ["semantic", "exact"], keys: [["answer", "service_id"]] }, "exact", "semantic");
    expect(assertions.every((item) => item.passed)).toBe(false);
    expect(() => enforceFloors([probeResult("EV-wp023-hybrid-01", "concierge", assertions)], floors)).toThrow(/Regression floor breach/u);
  });

  it("fails the gate when either WP-021 workflow or fidelity evidence breaks", () => {
    const workflow = validateWp021WorkflowEvidence({ manualAvailable: false, machineUnavailable: false, criticalHeld: false, publishRejected: false });
    const fidelity = validateWp021FidelityEvidence({ goodFailures: ["numbers"], changedPhone: [], missingFullDate: [], changedAddress: [], droppedNegation: [] });
    expect(workflow.every((item) => item.passed)).toBe(false);
    expect(fidelity.every((item) => item.passed)).toBe(false);
    expect(() => enforceFloors([probeResult("EV-wp021-workflow-01", "translation", workflow)], floors)).toThrow(/Regression floor breach/u);
    expect(() => enforceFloors([probeResult("EV-wp021-fidelity-01", "translation", fidelity)], floors)).toThrow(/Regression floor breach/u);
  });
});
