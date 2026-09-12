function strings(value) { return Array.isArray(value) ? value.filter((item) => typeof item === "string") : []; }

export default function grade(output, context) {
  try {
    const result = JSON.parse(output);
    const evalCase = JSON.parse(context.vars.case_json);
    const details = evalCase.assertions.map((assertion) => {
      const values = strings(assertion.value);
      if (assertion.grader === "contains_all") return values.every((value) => result.text.includes(value));
      if (assertion.grader === "contains_none" || assertion.grader === "canary_absent") return values.every((value) => !result.text.includes(value));
      if (assertion.grader === "regex") return typeof assertion.value === "string" && new RegExp(assertion.value, "u").test(result.text);
      if (assertion.grader === "tool_calls_exactly") return JSON.stringify(result.tool_calls.map((call) => call.name)) === JSON.stringify(values);
      if (assertion.grader === "tool_calls_subset_of") return result.tool_calls.every((call) => values.includes(call.name));
      throw new Error(`unsupported deterministic grader ${assertion.grader}`);
    });
    const zeroSpend = result.model === "test-stub" && result.external_calls === 0 && result.billable_tokens === 0 && result.cost_usd === 0;
    const pass = zeroSpend && details.every(Boolean);
    return { pass, score: pass ? 1 : 0, reason: pass ? "locked deterministic assertions passed at zero spend" : "locked deterministic assertion or zero-spend invariant failed" };
  } catch (error) {
    return { pass: false, score: 0, reason: `malformed stub result: ${error instanceof Error ? error.message : String(error)}` };
  }
}
