/**
 * what_bug_this_catches: A permissive harness can accept malformed cases/results or quietly lower a regression floor, turning missing evidence into a green CI result.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertCaseFloorCorrespondence, assertResultIntegrity, enforceFloors, type Floors } from "../../../evals/harness/runner.ts";
import { assertSchema, loadJsonSchema, validateSchema } from "../../../evals/harness/schema.ts";
import type { CaseResult, EvalResult } from "../../../evals/harness/types.ts";
import { assertMode, resolveOutputPath, writeOutput } from "../../../scripts/eval-guard.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const caseSchema = loadJsonSchema(path.join(root, "evals", "case.schema.json"));
const resultSchema = loadJsonSchema(path.join(root, "evals", "harness", "result.schema.json"));

function validCase(): Record<string, unknown> {
  return {
    id: "EV-test-schema-01", feature_id: "concierge", category: "grounding", prompt_version_min: "v1",
    input: { messages: [{ role: "user", content: "local stub input" }] },
    expected_behavior: "Returns the deterministic local stub output without transport.",
    assertions: [{ grader: "contains_all", value: ["local stub input"] }], grader: "deterministic",
    what_bug_this_catches: "A missing validation boundary would allow invalid evidence to pass the merge gate silently.",
    story_refs: ["seed:SC-07"], floor_group: "concierge", severity: "High",
  };
}

function result(status: CaseResult["status"]): CaseResult {
  return { case_id: "EV-test-schema-01", source: "evals/WP-011/example.yaml", package_id: "WP-011", floor_group: "concierge", must_pass: true, status, score: status === "pass" ? 1 : 0, provider: "stub", model: "test-stub", external_calls: 0, billable_tokens: 0, cost_usd: 0, assertions: [{ grader: "contains_all", passed: status === "pass", detail: "test" }] };
}

describe("WP-022 locked schemas and floors", () => {
  it("rejects malformed cases and missing or empty what_bug_this_catches", () => {
    const missing = validCase(); delete missing.what_bug_this_catches;
    expect(validateSchema(missing, caseSchema).join("\n")).toContain("what_bug_this_catches is required");
    expect(validateSchema({ ...validCase(), what_bug_this_catches: "" }, caseSchema).join("\n")).toContain("at least 40 characters");
    expect(() => assertSchema({ ...validCase(), surprise: true }, caseSchema, "case")).toThrow(/surprise is not allowed/u);
  });

  it("rejects a malformed result against the versioned locked result schema", () => {
    const malformed = { schema_version: "1.1", run_id: "stub-0000000000000000", mode: "stub", provider: "stub", network_calls: 1, billable_tokens: 0, cost_usd: 0, cases: [result("pass")], summary: { total: 1, passed: 1, failed: 0, abstained: 0, not_run: 0 } };
    expect(validateSchema(malformed, resultSchema).join("\n")).toContain("network_calls must equal 0");
  });

  it("fails closed for missing results, abstentions, skips, and must-pass or rate regressions", () => {
    const floors = JSON.parse(fs.readFileSync(path.join(root, "evals", "floors.json"), "utf8")) as Floors;
    expect(() => enforceFloors([result("fail")], floors)).toThrow(/Regression floor breach/u);
    expect(() => enforceFloors([result("abstain")], floors)).toThrow(/must_pass but was abstain/u);
    expect(() => enforceFloors([result("not_run")], floors)).toThrow(/must_pass but was not_run/u);
    expect(() => enforceFloors([{ ...result("fail"), case_id: "EV-concierge-02", must_pass: false }], floors)).toThrow(/EV-concierge-02 is must_pass/u);
    expect(() => enforceFloors([], floors, ["EV-test-schema-01"])).toThrow(/missing expected case results/u);
    expect(() => enforceFloors([result("pass")], { ...floors, _schema_version: "" })).toThrow(/no valid _schema_version/u);
    const missingRationale = structuredClone(floors);
    missingRationale.floor_groups.concierge!.rationale = "";
    expect(() => enforceFloors([result("pass")], missingRationale)).toThrow(/concierge has no rationale/u);
    expect(() => assertCaseFloorCorrespondence({ ...validCase(), must_pass: true } as never, floors, new Set())).toThrow(/claims must_pass but is absent/u);
  });

  it("rejects a result whose summary or selected-case identities are incomplete", () => {
    const validResult: EvalResult = {
      schema_version: "1.1", run_id: "stub-0000000000000000", mode: "stub", provider: "stub",
      network_calls: 0, billable_tokens: 0, cost_usd: 0, cases: [result("pass")],
      summary: { total: 1, passed: 0, failed: 1, abstained: 0, not_run: 0 },
    };
    expect(() => assertResultIntegrity(validResult, ["EV-test-schema-01"])).toThrow(/summary does not match/u);
    validResult.summary = { total: 1, passed: 1, failed: 0, abstained: 0, not_run: 0 };
    expect(() => assertResultIntegrity(validResult, ["EV-test-schema-01", "EV-missing-01"])).toThrow(/identities do not match/u);
    validResult.cases[0] = { ...result("pass"), assertions: [{ grader: "contains_all", passed: false, detail: "failed" }] };
    expect(() => assertResultIntegrity(validResult, ["EV-test-schema-01"])).toThrow(/status, score, and deterministic assertions disagree/u);
  });

  it("keeps live providers and subscription bridges unavailable", () => {
    expect(() => assertMode(["--mode", "live"])).toThrow(/separate credentials and explicit authorization/u);
    expect(() => assertMode([], "nightly")).toThrow(/separate credentials and explicit authorization/u);
    expect(() => assertMode(["--mode", "stub", "anthropic-api"])).toThrow(/Only the zero-spend stub/u);
    expect(() => assertMode(["--mode", "stub", "codex-cli-bridge"])).toThrow(/Only the zero-spend stub/u);
    expect(() => assertMode(["--mode", "stub", "--mode", "live"])).toThrow(/only once/u);
    expect(() => assertMode(["--mode", "stub"], undefined, "anthropic-api")).toThrow(/Only the zero-spend stub/u);
    expect(() => resolveOutputPath(root, "../outside.json")).toThrow(/below evals\/results/u);
    expect(() => resolveOutputPath(root, "evals/results/nested/stub.json")).toThrow(/direct-child/u);
    expect(resolveOutputPath(root, "evals/results/stub.json")).toBe(path.join(root, "evals", "results", "stub.json"));
    const temporary = fs.mkdtempSync(path.join(process.env.TEMP ?? process.cwd(), "wp022-output-"));
    try {
      writeOutput(temporary, "evals/results/stub.json", "{}\n");
      expect(fs.readFileSync(path.join(temporary, "evals", "results", "stub.json"), "utf8")).toBe("{}\n");
      expect(() => writeOutput(temporary, "evals/results/stub.json", "changed\n")).toThrow();
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  });
});
