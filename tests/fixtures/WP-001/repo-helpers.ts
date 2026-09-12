/**
 * Shared read-only helpers for the WP-001 test set (unit + security layers).
 *
 * Test-author ownership boundary (agentops/prompts/test-author.md s4): this file
 * lives under tests/fixtures/WP-001/**, which is a writable surface for the
 * test-author role. It contains no product logic and asserts nothing itself —
 * it only locates and reads files that the WP-001 builder is expected to land
 * under apps/, packages/, infra/, .github/ and root config. Tests import it to
 * avoid duplicating "where is the file" logic eight times over.
 *
 * Written from the specification (planning/plan-phase2/03-parallel-build-
 * architecture.md, 04-tests-and-evals.md, 10-security.md, compose-plan.md),
 * not from the builder's diff — see known-hazards.md and test-author.md s2.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Locate the coding-tree root (the worktree root that carries package.json /
 * pnpm-workspace.yaml) by walking up from a starting directory. Tests are run
 * via `pnpm vitest run tests/unit/WP-001 tests/security/WP-001` from the lane
 * worktree root (C:\ss-wt\WP-001\SeniorSocial-AI-Bts per the launch note), so
 * process.cwd() is normally already the root; walking up is defensive against
 * a runner invoked from a subdirectory.
 */
export function findRepoRoot(startDir: string = process.cwd()): string {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    if (
      fs.existsSync(path.join(dir, "package.json")) ||
      fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir);
}

/**
 * Build a Git invocation for both ordinary linked worktrees and the private
 * integration checkout, whose Git directory is the sibling
 * `seniorsocial-private-git` rather than a discoverable `.git` entry.
 */
export function gitInvocation(
  root: string,
  args: string[],
): { command: string; args: string[]; cwd: string } {
  const privateRoot = path.dirname(root);
  const explicitGitDir = path.join(privateRoot, "seniorsocial-private-git");
  if (fs.existsSync(explicitGitDir)) {
    return {
      command: "git",
      args: [`--git-dir=${explicitGitDir}`, `--work-tree=${privateRoot}`, ...args],
      cwd: privateRoot,
    };
  }
  return { command: "git", args, cwd: root };
}

export interface RootPackageJson {
  scripts?: Record<string, string>;
  pnpm?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Reads and parses the root package.json, or returns null if it does not exist yet. */
export function readRootPackageJson(
  root: string = findRepoRoot(),
): RootPackageJson | null {
  const p = path.join(root, "package.json");
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw) as RootPackageJson;
}

/** Reads pnpm-workspace.yaml as raw text, or null if absent. Kept as text (not
 * YAML-parsed) so these tests do not need a YAML dependency of their own. */
export function readPnpmWorkspaceYamlText(root: string = findRepoRoot()): string | null {
  const p = path.join(root, "pnpm-workspace.yaml");
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8");
}

/** Returns the absolute path of the first candidate (relative to root) that exists, else null. */
export function firstExisting(root: string, candidates: string[]): string | null {
  for (const c of candidates) {
    const p = path.join(root, c);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export interface WorkflowFile {
  relPath: string;
  absPath: string;
  content: string;
}

/** Reads every *.yml / *.yaml file under .github/workflows, if that directory exists. */
export function readAllWorkflowFiles(root: string = findRepoRoot()): WorkflowFile[] {
  const dir = path.join(root, ".github", "workflows");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => {
      const absPath = path.join(dir, f);
      return {
        relPath: path.join(".github", "workflows", f),
        absPath,
        content: fs.readFileSync(absPath, "utf8"),
      };
    });
}

/** Reads a file's text content, or null if it does not exist. */
export function readTextIfExists(absPath: string | null): string | null {
  if (!absPath || !fs.existsSync(absPath)) return null;
  return fs.readFileSync(absPath, "utf8");
}

/**
 * Extracts every `uses: <action>@<ref>` reference from a GitHub Actions
 * workflow file's raw text. Deliberately regex-based (not a YAML parser) so
 * this test set has no new dependency of its own.
 */
export function extractActionUsesRefs(
  workflowText: string,
): { action: string; ref: string }[] {
  const out: { action: string; ref: string }[] = [];
  const re = /uses:\s*([^\s#'"]+)@([^\s#'"]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(workflowText)) !== null) {
    out.push({ action: m[1], ref: m[2] });
  }
  return out;
}

/** A 40-character hex commit SHA, which is what "pinned to a commit SHA" means. */
export function isFullCommitSha(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref);
}

/** Parses a minimal KEY=VALUE dotenv-style file's text into a map. Ignores comments/blank lines. */
export function parseDotenvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Splits a `pnpm a && pnpm b && ...` chain into trimmed tokens. Returns [] for a falsy input. */
export function splitAndChain(script: string | undefined | null): string[] {
  if (!script) return [];
  return script
    .split("&&")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True if a script body looks like a placeholder/no-op rather than a real stage. */
export function looksLikeNoOp(script: string | undefined | null): boolean {
  if (script == null) return true;
  const s = script.trim();
  if (s === "") return true;
  const trivial = new Set([
    "true",
    ":",
    "exit 0",
    "echo done",
    "echo ok",
    "echo skip",
    "echo skipped",
    "echo noop",
    "echo no-op",
    "# noop",
  ]);
  if (trivial.has(s.toLowerCase())) return true;
  // A bare `echo <anything>` with no other command chained in is a stand-in, not a check.
  if (/^echo\b/i.test(s) && !/&&|;|\|\|/.test(s)) return true;
  return false;
}

/**
 * Extracts the script-file token (…/foo.ts | .js | .mjs | .cjs | .ps1) that
 * an npm-script command actually runs as its check, e.g. "tsx
 * scripts/leak-scan.ts --paths apps packages infra" -> "scripts/leak-scan.ts".
 *
 * Prefers an explicit `--file <path>` / `--ps1 <path>` flag value first: this
 * project wires several verify:* stages through a generic
 * `node scripts/verify-stage.mjs --name <stage> --file|--ps1 <path> -- ...`
 * wrapper (observed directly in the worktree's package.json), and for those
 * the wrapper script itself — not the flag's target — would otherwise be the
 * first ".mjs" token matched. Falls back to the first bare script-looking
 * token for a stage invoked directly (e.g. "tsx scripts/leak-scan.ts ...").
 * Returns null if neither form matches.
 */
export function extractScriptFileToken(command: string | undefined | null): string | null {
  if (!command) return null;
  const flagMatch = command.match(/--(?:file|ps1)\s+(\S+\.(?:ts|js|mjs|cjs|ps1))/);
  if (flagMatch) return flagMatch[1];
  const m = command.match(/(\S+\.(?:ts|js|mjs|cjs|ps1))\b/);
  return m ? m[1] : null;
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/**
 * Runs a resolved script file with the interpreter matching its extension
 * (tsx for .ts, node for .js/.mjs/.cjs, powershell for .ps1) with the given
 * args and an explicit environment. Used to exercise scripts (e.g. the leak
 * scanner) directly, since the WP-001 scaffold and its dependencies may not
 * be installed yet — a spawn failure ("tsx"/"node" missing, script absent)
 * is captured in `error`/`status: null` rather than throwing, so a calling
 * test can assert on it as a normal, informative red result.
 */
export function runScriptFile(
  absScriptPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
): RunResult {
  const ext = path.extname(absScriptPath).toLowerCase();
  let cmd: string;
  let cmdArgs: string[];
  if (ext === ".ps1") {
    cmd = "powershell";
    cmdArgs = ["-NoProfile", "-NonInteractive", "-File", absScriptPath, ...args];
  } else if (ext === ".ts") {
    cmd = "npx";
    cmdArgs = ["--yes", "tsx", absScriptPath, ...args];
  } else {
    cmd = "node";
    cmdArgs = [absScriptPath, ...args];
  }
  try {
    const res = spawnSync(cmd, cmdArgs, {
      env,
      cwd,
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
    });
    return {
      status: res.status,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      error: res.error ? String(res.error) : undefined,
    };
  } catch (e) {
    return { status: null, stdout: "", stderr: "", error: String(e) };
  }
}
