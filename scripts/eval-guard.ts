import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { fileURLToPath } from "node:url";
import { discoverPackageCases } from "../evals/harness/discovery.ts";
import { runStub, type PromptfooEvidence } from "../evals/harness/runner.ts";
import type { EvalCase } from "../evals/harness/types.ts";

const PROMPTFOO_VERSION = "0.123.0";
type Spawn = typeof spawnSync;

export function repoRootFromScript(): string { return path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); }

export function assertMode(argv: string[], environmentMode = process.env.EVAL_MODE, providerMode = process.env.AI_PROVIDER): { all: boolean; output?: string } {
  let mode: string | undefined;
  let all = false;
  let output: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--mode") {
      if (mode !== undefined) throw new Error("--mode may be supplied only once");
      mode = argv[++index];
      if (!mode) throw new Error("--mode requires a value");
    } else if (item === "--all") {
      if (all) throw new Error("--all may be supplied only once");
      all = true;
    } else if (item === "--output") {
      if (output !== undefined) throw new Error("--output may be supplied only once");
      output = argv[++index];
      if (!output) throw new Error("--output requires a path");
    } else if (["anthropic-api", "openai-api", "claude-cli-bridge", "codex-cli-bridge"].includes(String(item))) {
      throw new Error("Only the zero-spend stub provider is permitted by this guard.");
    } else {
      throw new Error(`Unsupported eval argument: ${String(item)}`);
    }
  }
  mode ??= environmentMode ?? "stub";
  if (mode !== "stub") throw new Error("Live/provider eval mode is unavailable. It requires separate credentials and explicit authorization; this guard never reads provider credentials.");
  if (providerMode && providerMode !== "stub") throw new Error("Only the zero-spend stub provider is permitted by this guard.");
  return { all, ...(output ? { output } : {}) };
}

export function resolveOutputPath(repoRoot: string, requested: string): string {
  const resultRoot = path.resolve(repoRoot, "evals", "results");
  const resolved = path.resolve(repoRoot, requested);
  const relative = path.relative(resultRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.dirname(relative) !== "." || path.extname(resolved) !== ".json") {
    throw new Error("--output must name a new direct-child .json file below evals/results");
  }
  return resolved;
}

export function writeOutput(repoRoot: string, requested: string, contents: string): void {
  const resultRoot = path.resolve(repoRoot, "evals", "results");
  if (fs.existsSync(resultRoot) && !fs.lstatSync(resultRoot).isDirectory()) throw new Error("evals/results must be a real directory");
  fs.mkdirSync(resultRoot, { recursive: true });
  const resolved = resolveOutputPath(repoRoot, requested);
  if (fs.realpathSync(path.dirname(resolved)) !== fs.realpathSync(resultRoot)) throw new Error("--output resolved outside the real evals/results directory");
  fs.writeFileSync(resolved, contents, { flag: "wx" });
}

export function promptfooEnvironment(environment: NodeJS.ProcessEnv, casesPath: string, evidencePath: string, configDir: string): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "ComSpec", "PATHEXT", "WINDIR"]) {
    if (environment[name]) child[name] = environment[name];
  }
  return { ...child, EVAL_MODE: "stub", AI_PROVIDER: "stub", IS_TESTING: "1", PROMPTFOO_DISABLE_TELEMETRY: "1", PROMPTFOO_DISABLE_UPDATE: "1", PROMPTFOO_CONFIG_DIR: configDir, SENIORSOCIAL_PROMPTFOO_CASES: casesPath, SENIORSOCIAL_PROMPTFOO_EVIDENCE: evidencePath };
}

function parseEvidence(pathname: string, expectedIds: readonly string[]): PromptfooEvidence[] {
  if (!fs.existsSync(pathname)) throw new Error("Promptfoo produced no stub execution evidence");
  const lines = fs.readFileSync(pathname, "utf8").split(/\r?\n/u).filter(Boolean);
  const evidence = lines.map((line, index) => {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error(`Promptfoo evidence line ${index + 1} is malformed JSON`); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Promptfoo evidence line ${index + 1} is malformed`);
    const item = value as Record<string, unknown>;
    if (typeof item.case_id !== "string" || typeof item.text !== "string" || !Array.isArray(item.tool_calls)
      || typeof item.model !== "string" || item.external_calls !== 0 || item.billable_tokens !== 0 || item.cost_usd !== 0) {
      throw new Error(`Promptfoo evidence line ${index + 1} violates the zero-spend result contract`);
    }
    if (!item.tool_calls.every((call) => call && typeof call === "object" && typeof (call as { name?: unknown }).name === "string")) throw new Error(`Promptfoo evidence line ${index + 1} has malformed tool calls`);
    return item as unknown as PromptfooEvidence;
  });
  const actual = evidence.map((item) => item.case_id).sort();
  const expected = [...expectedIds].sort();
  if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Promptfoo evidence case identities do not match the selected stub case set");
  return evidence;
}

function assertPromptfooOutput(pathname: string, expectedCount: number): void {
  if (!fs.existsSync(pathname)) throw new Error("Promptfoo produced no result file");
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(pathname, "utf8")); } catch { throw new Error("Promptfoo result is malformed JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Promptfoo result is malformed");
  const root = value as Record<string, unknown>;
  const nested = root.results && typeof root.results === "object" && !Array.isArray(root.results) ? root.results as Record<string, unknown> : root;
  const rows = Array.isArray(nested.results) ? nested.results : Array.isArray(root.results) ? root.results : undefined;
  if (!rows || rows.length !== expectedCount) throw new Error("Promptfoo result count does not match the selected stub case set");
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Promptfoo emitted a malformed case result");
    const record = row as Record<string, unknown>;
    if (record.success !== true && record.pass !== true) throw new Error("Promptfoo reported a failed or malformed case result");
  }
}

export function invokePromptfoo(repoRoot: string, cases: EvalCase[], environment: NodeJS.ProcessEnv = process.env, spawn: Spawn = spawnSync): PromptfooEvidence[] {
  if (cases.length === 0) throw new Error("Promptfoo must receive at least one locked-schema stub case");
  const packagePath = path.join(repoRoot, "node_modules", "promptfoo", "package.json");
  const entrypoint = path.join(repoRoot, "node_modules", "promptfoo", "dist", "src", "entrypoint.js");
  if (!fs.existsSync(packagePath) || !fs.existsSync(entrypoint)) throw new Error("The exact local promptfoo 0.123.0 installation is required");
  const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { version?: unknown };
  if (manifest.version !== PROMPTFOO_VERSION) throw new Error(`Expected local promptfoo ${PROMPTFOO_VERSION}`);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "seniorsocial-promptfoo-"));
  try {
    const casesPath = path.join(temporary, "cases.json");
    const evidencePath = path.join(temporary, "evidence.jsonl");
    const resultPath = path.join(temporary, "promptfoo-result.json");
    const modelVisibleCases = cases.map(({ id, input, assertions }) => ({ id, input, assertions }));
    fs.writeFileSync(casesPath, `${JSON.stringify(modelVisibleCases)}\n`, { flag: "wx" });
    const args = [entrypoint, "eval", "-c", path.join(repoRoot, "evals", "promptfoo.config.yaml"), "-o", resultPath, "--no-cache", "--no-share", "--no-write", "--no-table", "--no-progress-bar", "-j", "1"];
    const result: SpawnSyncReturns<string> = spawn(process.execPath, args, { cwd: repoRoot, env: promptfooEnvironment(environment, casesPath, evidencePath, temporary), encoding: "utf8", shell: false, timeout: 240_000, maxBuffer: 4 * 1024 * 1024 });
    if (result.error) throw new Error(`Promptfoo execution failed: ${result.error.message}`);
    if (result.status !== 0) {
      const diagnostic = String(result.stderr ?? "").trim().split(/\r?\n/u).slice(-12).join(" | ");
      throw new Error(`Promptfoo execution failed with exit ${String(result.status)}${diagnostic ? `: ${diagnostic}` : ""}`);
    }
    assertPromptfooOutput(resultPath, cases.length);
    return parseEvidence(evidencePath, cases.map((item) => item.id));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export async function runGuard(repoRoot: string, options: { all: boolean }, environment: NodeJS.ProcessEnv = process.env, spawn: Spawn = spawnSync) {
  const { sources, defaultCaseIds } = discoverPackageCases(repoRoot);
  const selectedIds = new Set(options.all ? sources.flatMap((source) => source.cases.map((item) => item.id)) : defaultCaseIds);
  const promptfooCases = sources.flatMap((source) => source.execution ? [] : source.cases.filter((item) => selectedIds.has(item.id)));
  const evidence = invokePromptfoo(repoRoot, promptfooCases, environment, spawn);
  return runStub(repoRoot, { all: options.all, promptfooEvidence: evidence });
}

export async function main(argv = process.argv.slice(2), repoRoot = repoRootFromScript()): Promise<void> {
  const options = assertMode(argv);
  const result = await runGuard(repoRoot, options);
  if (options.output) {
    writeOutput(repoRoot, options.output, `${JSON.stringify(result, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => { process.stderr.write(`eval-guard: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
