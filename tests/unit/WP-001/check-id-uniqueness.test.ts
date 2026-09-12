/**
 * CK-141 (unit, layer 0, rfp:T-15) — package: WP-001
 *
 * Global check-id uniqueness sweep, attempt 5 dispatch 8, item 6 (planning/
 * reviews/review-WP-001-4.md remediation 4, second half — the renumber
 * itself, CK-098/CK-099 -> CK-136/CK-137, was already done at dispatch 7).
 * Written from the remediation text and this dispatch's own instruction.
 *
 * what_bug_this_catches: "A merged package's check_ids that collide with a
 * different package's check_ids (assigned to the shared story-test-map.csv,
 * or landed independently in another package's own test catalog) make the
 * global catalog ambiguous — two different tests answer to the same id, so a
 * report against that id cannot say which one actually ran or failed."
 *
 * SCOPE, STATED EXPLICITLY: `scripts/project-catalogs.ts` — the tool that
 * would actually PROJECT every package's catalog fragment into one global
 * catalog — does NOT exist in this lane (confirmed by this test at run time,
 * below). No projection ran, and none is claimed by this check. This suite
 * proves SOURCE-LEVEL uniqueness only: it directly scans docs/specs/
 * story-test-map.csv (the adopted story-to-check map) plus every
 * tests/**\/CATALOG*.json fragment on disk today, and asserts no check_id is
 * attributed to more than one owning package across that combined source
 * set. A future projector could still find additional collisions this scan
 * cannot see (e.g. two fragments that both claim the SAME package for a
 * shared id in a way that is individually self-consistent per this check but
 * still wrong) — this check is a floor, not a replacement for that tool once
 * it exists.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot } from "../../fixtures/WP-001/repo-helpers";

const root = findRepoRoot();

/** Splits one CSV line into fields, honoring double-quoted fields that may contain embedded commas and doubled-quote escapes ("" -> "). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Parses a full CSV document into rows of fields. Assumes no field contains
 * an embedded newline (verified true of story-test-map.csv's own content —
 * every what_bug_this_catches value is single-line prose); a document that
 * ever needs multi-line quoted fields would need a real state machine across
 * lines, not this line-at-a-time splitter.
 */
function parseCsv(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map(parseCsvLine);
}

interface Owner {
  source: string;
  package: string;
  testId?: string;
}

function collectFromStoryTestMap(): { owners: Map<string, Owner[]>; rowCount: number } {
  const csvPath = path.join(root, "docs", "specs", "story-test-map.csv");
  const text = fs.readFileSync(csvPath, "utf8");
  const rows = parseCsv(text);
  const header = rows[0] ?? [];
  const checkIdIdx = header.indexOf("check_id");
  const packageIdx = header.indexOf("package");
  const owners = new Map<string, Owner[]>();
  let rowCount = 0;
  for (const row of rows.slice(1)) {
    rowCount++;
    const checkId = row[checkIdIdx]?.trim();
    const pkg = row[packageIdx]?.trim();
    if (!checkId) continue;
    const list = owners.get(checkId) ?? [];
    list.push({ source: "docs/specs/story-test-map.csv", package: pkg ?? "UNKNOWN" });
    owners.set(checkId, list);
  }
  return { owners, rowCount };
}

function findCatalogFiles(): string[] {
  const results: string[] = [];
  const testsRoot = path.join(root, "tests");
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/^CATALOG.*\.json$/i.test(entry.name)) {
        results.push(full);
      }
    }
  }
  if (fs.existsSync(testsRoot)) walk(testsRoot);
  return results;
}

function collectFromCatalogs(): { owners: Map<string, Owner[]>; files: string[] } {
  const owners = new Map<string, Owner[]>();
  const files = findCatalogFiles();
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    let parsed: { package?: string; checks?: Array<{ check_id?: string; test_id?: string }> };
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`Failed to parse ${rel} as JSON: ${String(e)}`);
    }
    const pkg = parsed.package ?? "UNKNOWN";
    for (const check of parsed.checks ?? []) {
      const id = check.check_id;
      if (!id) continue;
      const list = owners.get(id) ?? [];
      list.push({ source: rel, package: pkg, testId: check.test_id ?? "UNKNOWN" });
      owners.set(id, list);
    }
  }
  return { owners, files };
}

function findCollisions(
  fromCsv: Map<string, Owner[]>,
  fromCatalogs: Map<string, Owner[]>,
): Array<{ id: string; owners: Owner[] }> {
  const allIds = new Set<string>([...fromCsv.keys(), ...fromCatalogs.keys()]);
  const collisions: Array<{ id: string; owners: Owner[] }> = [];
  for (const id of allIds) {
    const catalogOwners = fromCatalogs.get(id) ?? [];
    const owners = [...(fromCsv.get(id) ?? []), ...catalogOwners];
    const distinctPackages = new Set(owners.map((owner) => owner.package));
    if (distinctPackages.size > 1 || catalogOwners.length > 1) {
      collisions.push({ id, owners });
    }
  }
  return collisions;
}

describe(
  "CK-141: no check_id is attributed to more than one owning package across " +
    "story-test-map.csv and every tests/**/CATALOG*.json (source-level only " +
    "-- scripts/project-catalogs.ts is absent, no projection ran or is claimed)",
  () => {
    it("scripts/project-catalogs.ts does not exist in this lane (this check is source-level uniqueness only)", () => {
      const projectorPath = path.join(root, "scripts", "project-catalogs.ts");
      // Recorded as an observation, not a standing requirement that it never
      // exist -- if a future dispatch adds the real projector, THAT tool's
      // own pass/fail becomes the authoritative uniqueness-plus-projection
      // check and this file's scope note above should be revisited, not this
      // assertion flipped to expect existence.
      const exists = fs.existsSync(projectorPath);
      expect(
        exists,
        "scripts/project-catalogs.ts now exists. This check was written when it was " +
          "absent and only proves SOURCE-LEVEL uniqueness (a direct scan of story-test-" +
          "map.csv plus every tests/**/CATALOG*.json) -- once a real projector exists, " +
          "its own output is the authoritative uniqueness-plus-projection check and " +
          "this file's scope note should be revisited rather than silently continuing " +
          "to stand in for it.",
      ).toBe(false);
    });

    it("both sources actually contain rows/files to scan (a check that scanned nothing would trivially pass)", () => {
      const { rowCount } = collectFromStoryTestMap();
      const { files } = collectFromCatalogs();
      expect(rowCount, "docs/specs/story-test-map.csv has no data rows").toBeGreaterThan(0);
      expect(files.length, "no tests/**/CATALOG*.json files were found").toBeGreaterThan(0);
    });

    it("no check_id maps to more than one distinct owning package", () => {
      const { owners: fromCsv } = collectFromStoryTestMap();
      const { owners: fromCatalogs } = collectFromCatalogs();
      const collisions = findCollisions(fromCsv, fromCatalogs);

      expect(
        collisions,
        `${collisions.length} check_id(s) are attributed to more than one owning ` +
          `package: ${JSON.stringify(collisions, null, 2)}. Each entry lists every ` +
          `(source, package, testId) identity that claimed the id. A check_id shared ` +
          `by two packages or by two catalog entries makes the global catalog ` +
          `ambiguous -- a report cannot say which test it refers to.`,
      ).toEqual([]);
    });

    it("rejects two catalog tests in the same package reusing one check_id", () => {
      const catalogs = new Map<string, Owner[]>([
        [
          "CK-SYNTHETIC-DUPLICATE",
          [
            { source: "tests/unit/WP-X/CATALOG.json", package: "WP-X", testId: "first" },
            { source: "tests/unit/WP-X/CATALOG.json", package: "WP-X", testId: "second" },
          ],
        ],
      ]);
      expect(findCollisions(new Map(), catalogs)).toHaveLength(1);
    });
  },
);
