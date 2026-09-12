/**
 * SEC-059 (security, layer E, rfp:T-9) — package: WP-001
 *
 * what_bug_this_catches (verbatim, story-test-map.csv): "TLS not enforced
 * end to end, including on the database connection, means the encryption
 * claim covers the browser hop and nothing else."
 *
 * Dispatch note: "For the scaffold, assert what config can prove
 * (DATABASE_URL / compose config requires TLS outside the dev lane; HSTS in
 * the base headers config if the scaffold carries one); anything that needs
 * a running deploy is failing-expected or forwarded, stated as such." The
 * full end-to-end enforcement (E layer) genuinely needs a running deploy —
 * 10-security.md's threat model attributes the header half to SEC-057/058
 * and the encryption half to SEC-042/SEC-059, both proved fully only once
 * WP-033's security pass and a real environment exist. This file asserts the
 * config-level evidence that is possible to check in a scaffold-only
 * package, and both cases are expected to be red until then — that is
 * recorded explicitly in the test-author receipt as "failing-expected,
 * forwarded to WP-033/WP-042", not silently skipped.
 */
import { describe, expect, it } from "vitest";
import { findRepoRoot } from "../../fixtures/WP-001/repo-helpers";
import fs from "node:fs";
import path from "node:path";

const root = findRepoRoot();

/** Recursively collects files under `dir` (bounded depth/count to stay fast and safe). */
function collectFiles(dir: string, maxFiles = 4000): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length && out.length < maxFiles) {
    const cur = stack.pop() as string;
    if (!fs.existsSync(cur)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === ".next") continue;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

describe("SEC-059: TLS enforced end to end including the database connection; HSTS present", () => {
  it(
    "a production/non-dev DATABASE_URL template or documented config requires TLS " +
      "(e.g. sslmode=require) — failing-expected/forwarded to WP-033/WP-042 if absent",
    () => {
      const candidateDirs = [
        path.join(root, "infra"),
        path.join(root, "docs"),
      ].filter((d) => fs.existsSync(d));

      const hits: string[] = [];
      for (const dir of candidateDirs) {
        for (const f of collectFiles(dir)) {
          if (!/\.(env.*|ya?ml|md|json|toml)$/i.test(f)) continue;
          let text: string;
          try {
            text = fs.readFileSync(f, "utf8");
          } catch {
            continue;
          }
          if (/DATABASE_URL/.test(text) && /sslmode=require|ssl=true|sslmode%3Drequire/i.test(text)) {
            hits.push(f);
          }
        }
      }

      expect(
        hits,
        "No file under infra/ or docs/ documents a DATABASE_URL requiring TLS " +
          "(sslmode=require) outside the local dev lane. This is expected to be " +
          "red at the WP-001 scaffold stage — the local dev DATABASE_URL in " +
          "compose-plan.md's .env.example intentionally has no sslmode, and a " +
          "TLS-enforced non-dev DATABASE_URL depends on a real deploy target " +
          "(Railway, WP-042) or an explicit production env template this package " +
          "does not yet define. Recorded in the receipt as failing-expected, " +
          "forwarded to WP-033/WP-042.",
      ).not.toEqual([]);
    },
  );

  it(
    "a base headers config sets Strict-Transport-Security — failing-expected/forwarded to WP-033 if absent",
    () => {
      const candidateDirs = [path.join(root, "apps"), path.join(root, "infra")].filter(
        (d) => fs.existsSync(d),
      );

      const hits: string[] = [];
      for (const dir of candidateDirs) {
        for (const f of collectFiles(dir)) {
          if (!/\.(ts|tsx|js|mjs|cjs)$/.test(f)) continue;
          let text: string;
          try {
            text = fs.readFileSync(f, "utf8");
          } catch {
            continue;
          }
          if (/Strict-Transport-Security/i.test(text)) hits.push(f);
        }
      }

      expect(
        hits,
        "No config file under apps/ or infra/ sets a Strict-Transport-Security " +
          "header. This is expected to be red at the WP-001 scaffold stage — " +
          "10-security.md attributes the security-headers pass to WP-033 " +
          "('confirm rate limits and security headers ... are active in " +
          "production' per railway-runbook.md T+36:55). Recorded in the receipt " +
          "as failing-expected, forwarded to WP-033.",
      ).not.toEqual([]);
    },
  );
});
