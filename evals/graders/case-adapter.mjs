import fs from "node:fs";

const pathname = process.env.SENIORSOCIAL_PROMPTFOO_CASES;
if (!pathname) throw new Error("SENIORSOCIAL_PROMPTFOO_CASES is required");
const cases = JSON.parse(fs.readFileSync(pathname, "utf8"));
if (!Array.isArray(cases) || cases.length === 0) throw new Error("Promptfoo case adapter received no cases");

export default cases.map((evalCase) => ({
  description: evalCase.id,
  vars: {
    case_id: evalCase.id,
    provider_input_json: JSON.stringify(evalCase.input),
    case_json: JSON.stringify(evalCase),
  },
  assert: [{ type: "javascript", value: "file://graders/result-grader.mjs" }],
  metadata: { case_id: evalCase.id },
}));
