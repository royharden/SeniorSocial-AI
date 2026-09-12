export interface EvalCase {
  id: string;
  feature_id: string;
  category: string;
  prompt_version_min: string;
  locale?: "en" | "es";
  input: { messages: Array<{ role: "user" | "assistant" | "tool"; content: string }> };
  expected_behavior: string;
  assertions: Array<{ grader: string; value?: unknown }>;
  grader: "deterministic" | "rubric";
  what_bug_this_catches: string;
  story_refs: string[];
  floor_group: string;
  severity: string;
  must_pass?: boolean;
}

export interface DiscoveredSource {
  relativePath: string;
  packageId: string;
  kind: "locked-cases" | "legacy-adapted" | "executable-adapted";
  cases: EvalCase[];
  adapterId?: string;
  bindingOnly?: boolean;
  execution?: "wp008-zero-spend" | "wp021-translation" | "wp023-hybrid";
}

export interface CaseResult {
  case_id: string;
  source: string;
  package_id: string;
  floor_group: string;
  must_pass: boolean;
  status: "pass" | "fail" | "abstain" | "not_run";
  score: number;
  provider: "stub";
  model: string;
  external_calls: number;
  billable_tokens: number;
  cost_usd: number;
  assertions: Array<{ grader: string; passed: boolean; detail: string }>;
}

export interface EvalResult {
  schema_version: "1.1";
  run_id: string;
  mode: "stub";
  provider: "stub";
  network_calls: 0;
  billable_tokens: 0;
  cost_usd: 0;
  cases: CaseResult[];
  summary: { total: number; passed: number; failed: number; abstained: number; not_run: number };
}
