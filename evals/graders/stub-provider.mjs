import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

export default class SeniorSocialStubProvider {
  constructor() { this.providerId = "seniorsocial-existing-stub"; }
  id() { return this.providerId; }

  async callApi(prompt, context) {
    const input = JSON.parse(prompt);
    const caseId = context?.vars?.case_id;
    if (typeof caseId !== "string") throw new Error("Promptfoo case id is unavailable to the local stub provider");
    const moduleUrl = pathToFileURL(path.join(process.cwd(), "packages", "ai", "src", "providers.ts")).href;
    const providers = await tsImport(moduleUrl, import.meta.url);
    const provider = new providers.StubProviderAdapter();
    if (provider.id !== "stub" || provider.capabilities.sdkRetriesDisabled !== true) throw new Error("Existing locked stub adapter is unavailable");
    const last = input?.messages?.at(-1);
    if (!last) throw new Error(`${caseId} has no input message`);
    const response = await provider.complete({ system: "SeniorSocial deterministic eval stub", messages: [{ role: last.role === "tool" ? "tool_result" : last.role, content: last.content }] });
    const output = JSON.stringify({ case_id: caseId, text: response.text, tool_calls: response.toolCalls, model: response.model, external_calls: 0, billable_tokens: 0, cost_usd: 0 });
    const evidencePath = process.env.SENIORSOCIAL_PROMPTFOO_EVIDENCE;
    if (!evidencePath) throw new Error("SENIORSOCIAL_PROMPTFOO_EVIDENCE is required");
    fs.appendFileSync(evidencePath, `${output}\n`, "utf8");
    return { output, tokenUsage: { total: 0, prompt: 0, completion: 0 }, cost: 0 };
  }
}
