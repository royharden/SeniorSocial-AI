/**
 * what_bug_this_catches: Promptfoo can be present only as a label while the guard bypasses it, leaks provider credentials, or accepts missing and malformed subprocess evidence.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { discoverPackageCases } from "../../../evals/harness/discovery.ts";
import { invokePromptfoo, promptfooEnvironment } from "../../../scripts/eval-guard.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const stubCase = discoverPackageCases(root).sources.flatMap((source) => source.execution ? [] : source.cases)[0]!;

function successfulSpawn(_command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) {
  const outputIndex = args.indexOf("-o");
  fs.writeFileSync(args[outputIndex + 1]!, JSON.stringify({ results: { results: [{ success: true }] } }));
  fs.writeFileSync(options.env!.SENIORSOCIAL_PROMPTFOO_EVIDENCE!, `${JSON.stringify({ case_id: stubCase.id, text: stubCase.input.messages.at(-1)!.content, tool_calls: [], model: "test-stub", external_calls: 0, billable_tokens: 0, cost_usd: 0 })}\n`);
  return { pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null };
}

describe("WP-022 required promptfoo execution", () => {
  it("invokes the exact local pin without a shell and accepts complete zero-spend evidence", () => {
    const spawn = vi.fn(successfulSpawn);
    const evidence = invokePromptfoo(root, [stubCase], { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, spawn as never);
    expect(evidence).toHaveLength(1);
    expect(spawn).toHaveBeenCalledOnce();
    const [command, args, options] = spawn.mock.calls[0]!;
    expect(command).toBe(process.execPath);
    expect(args[0]).toBe(path.join(root, "node_modules", "promptfoo", "dist", "src", "entrypoint.js"));
    expect(args).toContain(path.join(root, "evals", "promptfoo.config.yaml"));
    expect(options).toMatchObject({ cwd: root, shell: false });
  });

  it("fails closed on promptfoo process failure, malformed result, or missing evidence", () => {
    const failed = vi.fn(() => ({ pid: 1, output: [], stdout: "", stderr: "local failure", status: 1, signal: null }));
    expect(() => invokePromptfoo(root, [stubCase], {}, failed as never)).toThrow(/execution failed with exit 1/u);
    const malformed = vi.fn((_command: string, args: readonly string[]) => {
      fs.writeFileSync(args[args.indexOf("-o") + 1]!, "not-json");
      return { pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null };
    });
    expect(() => invokePromptfoo(root, [stubCase], {}, malformed as never)).toThrow(/result is malformed JSON/u);
    const noEvidence = vi.fn((_command: string, args: readonly string[]) => {
      fs.writeFileSync(args[args.indexOf("-o") + 1]!, JSON.stringify({ results: { results: [{ success: true }] } }));
      return { pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null };
    });
    expect(() => invokePromptfoo(root, [stubCase], {}, noEvidence as never)).toThrow(/no stub execution evidence/u);
  });

  it("does not pass provider credentials or permit remote providers in config", () => {
    const env = promptfooEnvironment({ PATH: "local-bin", OPENAI_API_KEY: "never-inspect-this", ANTHROPIC_API_KEY: "never-inspect-this" }, "cases", "evidence", "config");
    expect(env).toMatchObject({ PATH: "local-bin", EVAL_MODE: "stub", AI_PROVIDER: "stub", PROMPTFOO_DISABLE_TELEMETRY: "1" });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    const config = fs.readFileSync(path.join(root, "evals", "promptfoo.config.yaml"), "utf8");
    expect(config).toContain("file://graders/stub-provider.mjs");
    expect(config).toContain('raw: "{{provider_input_json}}"');
    expect(config).not.toContain('raw: "{{case_json}}"');
    expect(config).not.toMatch(/https?:|anthropic|openai|gateway|cli-bridge/iu);
  });
});
