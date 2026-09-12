import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { assertSchema, loadJsonSchema } from "./schema.ts";
import type { DiscoveredSource, EvalCase } from "./types.ts";

interface AdapterRow { adapter_id: string; source: string; source_sha256: string; kind: "legacy-adapted" | "executable-adapted"; fixture_case_ids: string[]; execution?: "wp008-zero-spend" | "wp021-translation" | "wp023-hybrid"; binding_only?: boolean }
interface FixtureManifest { default_case_ids: string[]; adapters: AdapterRow[] }

function posix(value: string): string { return value.split(path.sep).join("/"); }

function comparePaths(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function caseId(value: unknown): string { return typeof value === "string" ? value : "unknown"; }

function assertSafeSourcePath(value: string): void {
  if (!/^evals\/WP-[0-9]+\/(?!.*(?:^|\/)\.\.?(?:\/|$))[^\\]+$/u.test(value) || value.includes("\\")) {
    throw new Error(`Unsafe adapter source path: ${value}`);
  }
}

export function assertSourceDigest(pathname: string, adapterId: string, expected: string): void {
  const actual = crypto.createHash("sha256").update(fs.readFileSync(pathname)).digest("hex");
  if (actual !== expected) throw new Error(`${adapterId} source digest mismatch for ${posix(pathname)}`);
}

export function validateFixtureManifest(value: unknown): FixtureManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid fixture source manifest");
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.default_case_ids) || !record.default_case_ids.every((id) => typeof id === "string") || !Array.isArray(record.adapters)) {
    throw new Error("Invalid fixture source manifest");
  }
  const adapters: AdapterRow[] = record.adapters.map((value): AdapterRow => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid fixture source adapter");
    const row = value as Record<string, unknown>;
    if (typeof row.adapter_id !== "string" || !/^adapter-wp[0-9]+-[a-z0-9-]+-v[0-9]+$/u.test(row.adapter_id)
      || typeof row.source !== "string" || typeof row.source_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.source_sha256)
      || (row.kind !== "legacy-adapted" && row.kind !== "executable-adapted") || !Array.isArray(row.fixture_case_ids)
      || !row.fixture_case_ids.every((id) => typeof id === "string")
      || (row.binding_only !== undefined && row.binding_only !== true)
      || (row.kind === "executable-adapted" && row.execution === undefined)
      || (row.execution !== undefined && row.execution !== "wp008-zero-spend" && row.execution !== "wp021-translation" && row.execution !== "wp023-hybrid")) {
      throw new Error("Invalid fixture source adapter");
    }
    const adapter: AdapterRow = { adapter_id: row.adapter_id, source: row.source, source_sha256: row.source_sha256, kind: row.kind, fixture_case_ids: row.fixture_case_ids, ...(row.binding_only === true ? { binding_only: true } : {}) };
    if (row.execution === "wp008-zero-spend" || row.execution === "wp021-translation" || row.execution === "wp023-hybrid") return { ...adapter, execution: row.execution };
    return adapter;
  });
  const manifest = { default_case_ids: record.default_case_ids, adapters };
  if (new Set(manifest.default_case_ids).size !== manifest.default_case_ids.length) throw new Error("Duplicate default fixture case ids");
  for (const row of manifest.adapters) {
    assertSafeSourcePath(row.source);
    if (row.fixture_case_ids.length === 0 && row.binding_only !== true) throw new Error(`${row.source} adapter has no fixture cases`);
    if (row.binding_only === true && (row.fixture_case_ids.length > 0 || row.execution !== undefined)) throw new Error(`${row.source} binding-only adapter cannot execute cases`);
    if (new Set(row.fixture_case_ids).size !== row.fixture_case_ids.length) throw new Error(`${row.source} adapter repeats a fixture case id`);
  }
  if (new Set(manifest.adapters.map((row) => row.source)).size !== manifest.adapters.length) throw new Error("Duplicate adapter source paths");
  if (new Set(manifest.adapters.map((row) => row.adapter_id)).size !== manifest.adapters.length) throw new Error("Duplicate adapter ids");
  return manifest;
}

function yamlParser(repoRoot: string): { parse(text: string): unknown } {
  const packageManifest = path.join(repoRoot, "packages", "contracts", "package.json");
  return createRequire(packageManifest)("yaml") as { parse(text: string): unknown };
}

function yamlCases(repoRoot: string, pathname: string): unknown[] {
  const parsed = yamlParser(repoRoot).parse(fs.readFileSync(pathname, "utf8"));
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { cases?: unknown }).cases)) return (parsed as { cases: unknown[] }).cases;
  return [];
}

function packageFiles(repoRoot: string): string[] {
  const evalRoot = path.join(repoRoot, "evals");
  const walk = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const pathname = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(pathname);
    return entry.isFile() && /(?:\.ya?ml|\.eval\.test\.ts)$/u.test(entry.name) ? [pathname] : [];
  });
  return fs.readdirSync(evalRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^WP-[0-9]+$/u.test(entry.name))
    .flatMap((entry) => walk(path.join(evalRoot, entry.name)))
    .sort((left, right) => comparePaths(posix(left), posix(right)));
}

export function discoverPackageCases(repoRoot: string): { sources: DiscoveredSource[]; defaultCaseIds: string[] } {
  const schema = loadJsonSchema(path.join(repoRoot, "evals", "case.schema.json"));
  const fixturePath = path.join(repoRoot, "evals", "fixtures", "stub-cases.yaml");
  const fixtures = yamlCases(repoRoot, fixturePath) as EvalCase[];
  for (const evalCase of fixtures) assertSchema(evalCase, schema, `${posix(path.relative(repoRoot, fixturePath))}:${evalCase.id}`);
  const byId = new Map(fixtures.map((item) => [item.id, item]));
  const manifest = validateFixtureManifest(JSON.parse(fs.readFileSync(path.join(repoRoot, "evals", "fixtures", "sources.json"), "utf8")));
  const adapters = new Map(manifest.adapters.map((row) => [row.source, row]));
  const sources: DiscoveredSource[] = [];

  for (const pathname of packageFiles(repoRoot)) {
    const relativePath = posix(path.relative(repoRoot, pathname));
    const packageId = relativePath.split("/")[1] ?? "UNKNOWN";
    const adapter = adapters.get(relativePath);
    if (adapter) {
      assertSourceDigest(pathname, adapter.adapter_id, adapter.source_sha256);
      if (/\.ya?ml$/u.test(pathname)) {
        const rawCases = yamlCases(repoRoot, pathname);
        const lockedCases = rawCases.filter((item) => item && typeof item === "object" && "feature_id" in item);
        if (lockedCases.length > 0 && lockedCases.length !== rawCases.length) throw new Error(`${relativePath} mixes locked and legacy case formats`);
        for (const evalCase of lockedCases) assertSchema(evalCase, schema, `${relativePath}:${caseId((evalCase as { id?: unknown }).id)}`);
      }
      const cases = adapter.fixture_case_ids.map((id) => {
        const found = byId.get(id);
        if (!found) throw new Error(`${relativePath} adapter references missing fixture case ${id}`);
        return found;
      });
      sources.push({ relativePath, packageId, kind: adapter.kind, cases, adapterId: adapter.adapter_id, ...(adapter.execution ? { execution: adapter.execution } : {}), ...(adapter.binding_only ? { bindingOnly: true } : {}) });
      continue;
    }
    if (!/\.ya?ml$/u.test(pathname)) throw new Error(`Unmapped executable eval source: ${relativePath}`);
    const cases = yamlCases(repoRoot, pathname);
    if (cases.length === 0) throw new Error(`Eval source contains no cases: ${relativePath}`);
    for (const evalCase of cases) assertSchema(evalCase, schema, `${relativePath}:${caseId((evalCase as { id?: unknown }).id)}`);
    sources.push({ relativePath, packageId, kind: "locked-cases", cases: cases as EvalCase[] });
  }
  const duplicates = sources.flatMap((source) => source.cases.map((item) => item.id)).filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicates.length > 0) throw new Error(`Duplicate discovered eval case ids: ${[...new Set(duplicates)].join(", ")}`);
  const discoveredPaths = new Set(sources.map((source) => source.relativePath));
  const danglingAdapters = manifest.adapters.filter((row) => !discoveredPaths.has(row.source));
  if (danglingAdapters.length > 0) throw new Error(`Adapters reference undiscovered sources: ${danglingAdapters.map((row) => row.source).join(", ")}`);
  const discoveredIds = new Set(sources.flatMap((source) => source.cases.map((item) => item.id)));
  const missingDefaults = manifest.default_case_ids.filter((id) => !discoveredIds.has(id));
  if (manifest.default_case_ids.length === 0 || missingDefaults.length > 0) throw new Error(`Default fixture cases were not discovered: ${missingDefaults.join(", ") || "none configured"}`);
  return { sources, defaultCaseIds: manifest.default_case_ids };
}
