/**
 * what_bug_this_catches: The PR gate can appear deterministic while opening a socket, requiring a provider token, mutating owner eval files, or producing different identities on identical runs.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runStub } from "../../../evals/harness/runner.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const promptfooEvidence = [{ case_id: "EV-wp011-stub-01", text: "WP-011 stub preserves deterministic concierge evidence", tool_calls: [], model: "test-stub", external_calls: 0, billable_tokens: 0, cost_usd: 0 }];

function ownerHashes(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const dir of fs.readdirSync(path.join(root, "evals"), { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^WP-/u.test(entry.name))) {
    for (const file of fs.readdirSync(path.join(root, "evals", dir.name)).sort()) {
      const relative = `evals/${dir.name}/${file}`;
      result[relative] = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, relative))).digest("hex");
    }
  }
  return result;
}

afterEach(() => vi.restoreAllMocks());

describe("WP-022 clean-checkout zero-spend stub run", () => {
  it("uses the existing stub with no network calls, no credentials, no billable tokens, and no owner mutation", async () => {
    const before = ownerHashes();
    const connect = vi.spyOn(net, "connect").mockImplementation(() => { throw new Error("network call forbidden in stub eval"); });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("fetch forbidden in stub eval"); });
    const first = await runStub(root, { promptfooEvidence });
    const second = await runStub(root, { promptfooEvidence });
    expect(first).toEqual(second);
    expect(first.summary).toEqual({ total: 7, passed: 7, failed: 0, abstained: 0, not_run: 0 });
    expect(first.cases.map((item) => item.case_id)).toEqual(["EV-wp008-kill-01", "EV-wp008-cache-01", "EV-wp008-egress-01", "EV-wp011-stub-01", "EV-wp021-workflow-01", "EV-wp021-fidelity-01", "EV-wp023-hybrid-01"]);
    expect(first.cases.every((item) => item.must_pass === false)).toBe(true);
    expect(first.cases.find((item) => item.case_id === "EV-wp008-cache-01")?.assertions.find((item) => item.grader === "two_events_logged")?.passed).toBe(true);
    expect(first.cases.find((item) => item.case_id === "EV-wp023-hybrid-01")?.assertions.find((item) => item.grader === "citation_ids_only")?.passed).toBe(true);
    expect(first.cases.find((item) => item.case_id === "EV-wp021-workflow-01")?.assertions.find((item) => item.grader === "critical_machine_draft_held")?.passed).toBe(true);
    expect(first.cases.find((item) => item.case_id === "EV-wp021-fidelity-01")?.assertions.find((item) => item.grader === "dropped_negation_detected")?.passed).toBe(true);
    expect(first.network_calls).toBe(0);
    expect(first.billable_tokens).toBe(0);
    expect(first.cost_usd).toBe(0);
    expect(connect).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ownerHashes()).toEqual(before);
  });

  it("runs through the committed CLI without requiring or printing credentials", () => {
    const syntheticSecret = "SYNTHETIC-SECRET-MUST-NOT-APPEAR";
    const stdout = execFileSync(process.execPath, ["scripts/eval-guard.ts", "--mode", "stub"], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, ANTHROPIC_API_KEY: syntheticSecret } });
    const parsed = JSON.parse(stdout) as { summary: { failed: number }; provider: string; network_calls: number };
    expect(parsed).toMatchObject({ provider: "stub", network_calls: 0, summary: { failed: 0 } });
    expect(stdout).not.toContain(syntheticSecret);
  }, 30_000);

  it("wires the pinned CI job only to the fail-closed stub command", () => {
    const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "evals.yml"), "utf8");
    expect(workflow).toContain("pnpm verify:evals:stub");
    expect(workflow).toContain("EVAL_MODE: stub");
    expect(workflow).toMatch(/actions\/checkout@[a-f0-9]{40}/u);
    expect(workflow).not.toMatch(/ANTHROPIC_API_KEY|OPENAI_API_KEY|claude-cli-bridge|codex-cli-bridge/u);
  });
});
