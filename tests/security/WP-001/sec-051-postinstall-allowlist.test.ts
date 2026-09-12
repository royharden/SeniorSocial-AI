/**
 * SEC-051 (security, layer L, rfp:T-15) — package: WP-001
 *
 * what_bug_this_catches (updated per ADR-016, docs\decisions\ADR-016-sec-051-
 * control-is-allowbuilds.md — verbatim origin, story-test-map.csv, extended
 * to name the actual control): "An unrestricted postinstall script executes
 * arbitrary code on every machine and CI runner that installs the project —
 * and an empty (or absent) `onlyBuiltDependencies` list must never be read
 * as proof this cannot happen, because pnpm-workspace.yaml's `allowBuilds`
 * map is the register pnpm >= 11 actually enforces; `allowBuilds: {X: true}`
 * lets X's script run regardless of what onlyBuiltDependencies says."
 *
 * Spec: 10-security.md line 235 "MVP controls" names `onlyBuiltDependencies`;
 * ADR-016 (independently re-read against the pinned pnpm 11.9.0 and verified
 * against a live install, 2026-09-10) ruled that `allowBuilds` is the
 * register pnpm 11 enforces and `onlyBuiltDependencies`/
 * `ignoredBuiltDependencies` are non-authoritative mirrors that may remain
 * in pnpm-workspace.yaml but are not sufficient disposition on their own.
 * pnpm's `allowBuilds` setting can live in either the root package.json's
 * `pnpm` block or in `pnpm-workspace.yaml` depending on pnpm version/config
 * location; this test checks both so it is not tied to whichever the
 * builder picks.
 */
import { describe, expect, it } from "vitest";
import {
  findRepoRoot,
  readPnpmWorkspaceYamlText,
  readRootPackageJson,
} from "../../fixtures/WP-001/repo-helpers";

const root = findRepoRoot();
const pkg = readRootPackageJson(root);
const workspaceYamlText = readPnpmWorkspaceYamlText(root);

interface AllowBuildsEntry {
  value: boolean;
  /** True if the SAME line also carries a trailing `#` comment with content. */
  hasJustification: boolean;
}

/**
 * Extracts pnpm-workspace.yaml's `allowBuilds:` map — SEC-051's actual
 * control per ADR-016. Local duplicate of the identical helper in
 * sec-051-build-script-frozen-install.test.ts (not lifted into the shared
 * fixture, matching that file's existing no-shared-fixture-churn note for
 * this attempt-2 pass).
 */
function extractYamlAllowBuilds(text: string): Map<string, AllowBuildsEntry> {
  const out = new Map<string, AllowBuildsEntry>();
  const lines = text.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => /^\s*allowBuilds\s*:\s*(\{.*\})?\s*$/.test(l));
  if (startIdx === -1) return out;

  const inlineMatch = lines[startIdx].match(/allowBuilds\s*:\s*\{(.*)\}\s*$/);
  if (inlineMatch) {
    for (const pair of inlineMatch[1].split(",")) {
      const m = pair.match(/['"]?([\w@/.\-]+)['"]?\s*:\s*(true|false)/);
      if (m) out.set(m[1], { value: m[2] === "true", hasJustification: false });
    }
    return out;
  }

  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*$/.test(line)) continue;
    const entryMatch = line.match(/^\s{2,}(['"]?[\w@/.\-]+['"]?)\s*:\s*(true|false)\b(.*)$/);
    if (entryMatch) {
      const name = entryMatch[1].replace(/^['"]|['"]$/g, "");
      const value = entryMatch[2] === "true";
      const hasJustification = /#\s*\S/.test(entryMatch[3] ?? "");
      out.set(name, { value, hasJustification });
      continue;
    }
    if (/^\s{2,}#/.test(line)) continue;
    break;
  }
  return out;
}

function getAllowBuildsMap(): Map<string, AllowBuildsEntry> {
  const fromYaml = workspaceYamlText ? extractYamlAllowBuilds(workspaceYamlText) : new Map();
  const merged = new Map<string, AllowBuildsEntry>(fromYaml);
  const fromPackageJson =
    (pkg?.pnpm?.["allowBuilds"] as Record<string, boolean> | undefined) ?? {};
  for (const [name, value] of Object.entries(fromPackageJson)) {
    if (!merged.has(name)) merged.set(name, { value: Boolean(value), hasJustification: false });
  }
  return merged;
}

describe("SEC-051: postinstall scripts are restricted to an explicit allowBuilds disposition", () => {
  it("declares an allowBuilds map in package.json#pnpm or pnpm-workspace.yaml, and no true entry lacks its justification comment", () => {
    const allowBuilds = getAllowBuildsMap();

    // ADR-016: allowBuilds is the authoritative register. An empty or absent
    // onlyBuiltDependencies mirror is never treated as proof either way —
    // this check looks at allowBuilds directly, not at that mirror list.
    expect(
      allowBuilds.size > 0,
      "No allowBuilds entries found in package.json#pnpm or pnpm-workspace.yaml. Per " +
        "ADR-016 (docs\\decisions\\ADR-016-sec-051-control-is-allowbuilds.md), " +
        "allowBuilds is the SEC-051 register pnpm >= 11 actually enforces — an empty " +
        "onlyBuiltDependencies list is not sufficient disposition on its own, and is " +
        "not evidence that allowBuilds is populated or absent.",
    ).toBe(true);

    const unjustified: string[] = [];
    for (const [name, entry] of allowBuilds) {
      if (entry.value === true && !entry.hasJustification) unjustified.push(name);
    }
    expect(
      unjustified,
      `${unjustified.length} allowBuilds entr${unjustified.length === 1 ? "y is" : "ies are"} ` +
        `set to true with no one-line justification comment beside it: ` +
        `${unjustified.join(", ")}. Per ADR-016, every allowBuilds:true entry lets that ` +
        `package run arbitrary code on every install and must carry a trailing "# reason" ` +
        `comment on the same line for a reviewer to see.`,
    ).toEqual([]);
  });

  it("does not set a dangerous escape hatch that would defeat the allowlist", () => {
    // pnpm has a documented dangerouslyAllowAllBuilds override; if it is ever
    // set truthy, the allowlist above is decorative.
    const dangerFlag = pkg?.pnpm?.["dangerouslyAllowAllBuilds"] as unknown;
    expect(
      Boolean(dangerFlag),
      `pnpm.dangerouslyAllowAllBuilds is truthy (${JSON.stringify(dangerFlag)}) — ` +
        "this defeats the onlyBuiltDependencies allowlist entirely.",
    ).toBe(false);
  });
});
