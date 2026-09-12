import crypto from "node:crypto";
import path from "node:path";
import { discoverPackageCases } from "./discovery.ts";
import { runWp008Probe, runWp021Probe, runWp023Probe } from "./probes.ts";
import { assertSchema, loadJsonSchema } from "./schema.ts";
import type { CaseResult, EvalCase, EvalResult } from "./types.ts";

export interface PromptfooEvidence { case_id: string; text: string; tool_calls: Array<{ name: string }>; model: string; external_calls: number; billable_tokens: number; cost_usd: number }

export interface Floors { _schema_version: string; max_new_regressions_per_run: number; known_failing_cases: string[]; category_to_floor_group: Record<string, string>; floor_groups: Record<string, { min_pass_rate: number; rationale: string; must_pass: string[] }> }

function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }

function grade(evalCase: EvalCase, text: string, toolCalls: readonly { name: string }[]): CaseResult["assertions"] {
  return evalCase.assertions.map((assertion) => {
    const values = stringArray(assertion.value);
    let passed: boolean;
    if (assertion.grader === "contains_all") passed = values.every((value) => text.includes(value));
    else if (assertion.grader === "contains_none" || assertion.grader === "canary_absent") passed = values.every((value) => !text.includes(value));
    else if (assertion.grader === "regex") passed = typeof assertion.value === "string" && new RegExp(assertion.value, "u").test(text);
    else if (assertion.grader === "tool_calls_exactly") passed = JSON.stringify(toolCalls.map((call) => call.name)) === JSON.stringify(values);
    else if (assertion.grader === "tool_calls_subset_of") passed = toolCalls.every((call) => values.includes(call.name));
    else throw new Error(`${evalCase.id} uses unsupported deterministic stub grader ${assertion.grader}`);
    return { grader: assertion.grader, passed, detail: passed ? "passed" : "deterministic assertion failed" };
  });
}

export function assertCaseFloorCorrespondence(evalCase: EvalCase, floors: Floors, lockedMustPass: ReadonlySet<string>): void {
  if (evalCase.must_pass === true && !lockedMustPass.has(evalCase.id)) throw new Error(`${evalCase.id} claims must_pass but is absent from locked floors.json`);
  if (floors.category_to_floor_group[evalCase.category] !== evalCase.floor_group) throw new Error(`${evalCase.id} floor_group does not match the locked category map`);
}

export function enforceFloors(results: CaseResult[], floors: Floors, expectedCaseIds: readonly string[] = results.map((item) => item.case_id)): void {
  const errors: string[] = [];
  if (!/^[0-9]+\.[0-9]+$/u.test(floors._schema_version)) errors.push("floors.json has no valid _schema_version");
  if (!Number.isInteger(floors.max_new_regressions_per_run) || floors.max_new_regressions_per_run < 0) errors.push("max_new_regressions_per_run must be a non-negative integer");
  if (!Array.isArray(floors.known_failing_cases)) errors.push("known_failing_cases must be an array");
  if (results.length === 0) errors.push("eval run contains no results");
  const resultIds = results.map((item) => item.case_id);
  const duplicateIds = resultIds.filter((id, index) => resultIds.indexOf(id) !== index);
  if (duplicateIds.length > 0) errors.push(`duplicate case results: ${[...new Set(duplicateIds)].join(", ")}`);
  const expected = new Set(expectedCaseIds);
  const actual = new Set(resultIds);
  const missing = [...expected].filter((id) => !actual.has(id));
  const unexpected = [...actual].filter((id) => !expected.has(id));
  if (missing.length > 0) errors.push(`missing expected case results: ${missing.join(", ")}`);
  if (unexpected.length > 0) errors.push(`unexpected case results: ${unexpected.join(", ")}`);
  const lockedMustPass = new Set(Object.values(floors.floor_groups).flatMap((floor) => Array.isArray(floor.must_pass) ? floor.must_pass : []));
  for (const result of results) {
    if (!(result.floor_group in floors.floor_groups)) errors.push(`${result.case_id} references unknown floor group ${result.floor_group}`);
    if ((result.must_pass || lockedMustPass.has(result.case_id)) && result.status !== "pass") errors.push(`${result.case_id} is must_pass but was ${result.status}`);
  }
  for (const [group, floor] of Object.entries(floors.floor_groups)) {
    if (typeof floor.rationale !== "string" || floor.rationale.trim().length === 0) errors.push(`${group} has no rationale`);
    if (!Array.isArray(floor.must_pass)) errors.push(`${group} has no must_pass list`);
    if (typeof floor.min_pass_rate !== "number" || floor.min_pass_rate < 0 || floor.min_pass_rate > 1) {
      errors.push(`${group} has an invalid min_pass_rate`);
      continue;
    }
    const groupResults = results.filter((item) => item.floor_group === group);
    if (groupResults.length === 0) continue;
    const passRate = groupResults.filter((item) => item.status === "pass").length / groupResults.length;
    if (passRate < floor.min_pass_rate) errors.push(`${group} pass rate ${passRate.toFixed(3)} is below ${floor.min_pass_rate}`);
  }
  const newRegressions = results.filter((item) => item.status !== "pass" && !floors.known_failing_cases.includes(item.case_id));
  if (newRegressions.length > floors.max_new_regressions_per_run) errors.push(`${newRegressions.length} new regressions exceeds ${floors.max_new_regressions_per_run}`);
  if (errors.length > 0) throw new Error(`Regression floor breach:\n${errors.join("\n")}`);
}

export function assertResultIntegrity(result: EvalResult, expectedCaseIds: readonly string[]): void {
  const counts = {
    total: result.cases.length,
    passed: result.cases.filter((item) => item.status === "pass").length,
    failed: result.cases.filter((item) => item.status === "fail").length,
    abstained: result.cases.filter((item) => item.status === "abstain").length,
    not_run: result.cases.filter((item) => item.status === "not_run").length,
  };
  if (JSON.stringify(result.summary) !== JSON.stringify(counts)) throw new Error("eval result summary does not match case results");
  for (const item of result.cases) {
    const assertionsPass = item.assertions.every((assertion) => assertion.passed);
    if (item.score !== (item.status === "pass" ? 1 : 0) || (item.status === "pass") !== assertionsPass) {
      throw new Error(`${item.case_id} status, score, and deterministic assertions disagree`);
    }
  }
  const expected = [...expectedCaseIds].sort();
  const actual = result.cases.map((item) => item.case_id).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("eval result case identities do not match the selected case set");
}

export async function runStub(repoRoot: string, options: { all?: boolean; caseIds?: string[]; promptfooEvidence?: PromptfooEvidence[] } = {}): Promise<EvalResult> {
  const { sources, defaultCaseIds } = discoverPackageCases(repoRoot);
  const selectedIds = new Set(options.caseIds ?? (options.all ? sources.flatMap((source) => source.cases.map((item) => item.id)) : defaultCaseIds));
  const selected = sources.flatMap((source) => source.cases.map((evalCase) => ({ source, evalCase }))).filter(({ evalCase }) => selectedIds.has(evalCase.id));
  if (selected.length !== selectedIds.size) throw new Error(`Requested cases were not discovered: ${[...selectedIds].filter((id) => !selected.some(({ evalCase }) => evalCase.id === id)).join(", ")}`);
  const floors = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(path.join(repoRoot, "evals", "floors.json"), "utf8"))) as Floors;
  const lockedMustPass = new Set(Object.values(floors.floor_groups).flatMap((floor) => floor.must_pass));
  for (const { evalCase } of selected) {
    assertCaseFloorCorrespondence(evalCase, floors, lockedMustPass);
  }
  const promptfooById = new Map((options.promptfooEvidence ?? []).map((item) => [item.case_id, item]));
  if (promptfooById.size !== (options.promptfooEvidence ?? []).length) throw new Error("Promptfoo returned duplicate case evidence");
  const results: CaseResult[] = [];
  const wp008Assertions = selected.some(({ source }) => source.execution === "wp008-zero-spend") ? await runWp008Probe(repoRoot) : {};
  const wp021Assertions = selected.some(({ source }) => source.execution === "wp021-translation") ? await runWp021Probe(repoRoot) : {};
  const wp023Assertions = selected.some(({ source }) => source.execution === "wp023-hybrid") ? await runWp023Probe(repoRoot) : [];
  for (const { source, evalCase } of selected) {
    const last = evalCase.input.messages.at(-1);
    if (!last) throw new Error(`${evalCase.id} has no messages`);
    let assertions: CaseResult["assertions"];
    let model = "test-stub";
    if (source.execution === "wp008-zero-spend") {
      assertions = wp008Assertions[evalCase.id] ?? [];
      if (assertions.length === 0) throw new Error(`${source.adapterId ?? source.relativePath} has no executable assertions for ${evalCase.id}`);
      model = "wp008-gateway-with-test-stub";
    } else if (source.execution === "wp023-hybrid") {
      assertions = wp023Assertions;
      model = "wp023-rag-with-test-stub";
    } else if (source.execution === "wp021-translation") {
      assertions = wp021Assertions[evalCase.id] ?? [];
      if (assertions.length === 0) throw new Error(`${source.adapterId ?? source.relativePath} has no executable assertions for ${evalCase.id}`);
      model = "wp021-i18n-deterministic-probe";
    } else {
      const response = promptfooById.get(evalCase.id);
      if (!response) throw new Error(`${evalCase.id} has no required promptfoo execution evidence`);
      if (response.model !== "test-stub" || response.external_calls !== 0 || response.billable_tokens !== 0 || response.cost_usd !== 0) throw new Error(`${evalCase.id} promptfoo evidence violates the locked zero-spend stub contract`);
      assertions = grade(evalCase, response.text, response.tool_calls);
    }
    const passed = assertions.every((item) => item.passed);
    results.push({ case_id: evalCase.id, source: source.relativePath, package_id: source.packageId, floor_group: evalCase.floor_group, must_pass: lockedMustPass.has(evalCase.id), status: passed ? "pass" : "fail", score: passed ? 1 : 0, provider: "stub", model, external_calls: 0, billable_tokens: 0, cost_usd: 0, assertions });
  }
  enforceFloors(results, floors, [...selectedIds]);
  const identity = results.map((item) => `${item.source}:${item.case_id}:${item.status}`).sort().join("\n");
  const result: EvalResult = { schema_version: "1.1", run_id: `stub-${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 16)}`, mode: "stub", provider: "stub", network_calls: 0, billable_tokens: 0, cost_usd: 0, cases: results, summary: { total: results.length, passed: results.filter((item) => item.status === "pass").length, failed: results.filter((item) => item.status === "fail").length, abstained: results.filter((item) => item.status === "abstain").length, not_run: results.filter((item) => item.status === "not_run").length } };
  assertSchema(result, loadJsonSchema(path.join(repoRoot, "evals", "harness", "result.schema.json")), "eval result");
  assertResultIntegrity(result, [...selectedIds]);
  return result;
}
