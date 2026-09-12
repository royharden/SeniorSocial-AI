/**
 * SEC-052 (security, layer L, rfp:T-15) — package: WP-001
 *
 * what_bug_this_catches (verbatim, story-test-map.csv): "A floating image
 * tag silently changes the base under a passing build, and a root container
 * turns a container escape into host access."
 *
 * Acceptance text: "images pinned by digest (no :latest, no floating tag);
 * container runs non-root."
 *
 * Spec note on the Dockerfile's own path: 03-parallel-build-architecture.md
 * s5 says "infra/Dockerfile"; compose-plan.md s1's docker-compose.yml sketch
 * says "infra/docker/Dockerfile". These two spec documents disagree on the
 * exact path, so this test searches both candidates rather than asserting
 * one and calling the other wrong; the discrepancy itself is filed as a
 * docket submission.
 */
import { describe, expect, it } from "vitest";
import { findRepoRoot, readTextIfExists } from "../../fixtures/WP-001/repo-helpers";
import path from "node:path";
import fs from "node:fs";

const root = findRepoRoot();

const DOCKERFILE_CANDIDATES = ["infra/Dockerfile", "infra/docker/Dockerfile"];
const COMPOSE_CANDIDATES = ["infra/docker-compose.yml", "infra/docker-compose.yaml"];

function findFirst(candidates: string[]): string | null {
  for (const c of candidates) {
    const p = path.join(root, c);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

interface FromLine {
  raw: string;
  image: string;
  alias: string | null;
}

/**
 * Resolves `ARG NAME=default` build-arg substitutions (Docker's own
 * `${NAME}` / `$NAME` syntax) that a FROM line references, e.g.
 *   ARG NODE_IMAGE=node:24-slim@sha256:...
 *   FROM ${NODE_IMAGE} AS base
 * is a legitimate, single-source-of-truth way to pin a digest once and reuse
 * it across every build stage — checking the FROM line's literal text alone
 * would misreport a correctly-pinned image as a floating one. Only ARG
 * declarations that carry a literal `=<default>` are resolved; an ARG with
 * no default (must be supplied at build time) is left unresolved and any
 * FROM that still references it after substitution correctly fails the
 * digest check below, since its actual pin cannot be determined statically.
 */
function resolveDockerArgs(text: string, image: string): string {
  const argDefaults = new Map<string, string>();
  const argRe = /^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\S+)/gim;
  let am: RegExpExecArray | null;
  while ((am = argRe.exec(text)) !== null) {
    argDefaults.set(am[1], am[2]);
  }
  let resolved = image;
  for (let i = 0; i < 5; i++) {
    // bounded passes in case one ARG's default references another
    const before = resolved;
    resolved = resolved.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a, b) => {
      const name = a ?? b;
      return argDefaults.get(name) ?? _m;
    });
    if (resolved === before) break;
  }
  return resolved;
}

/** Parses `FROM <image>[ AS <alias>]` lines from a Dockerfile's text, resolving ARG substitutions. */
function parseFromLines(text: string): FromLine[] {
  const out: FromLine[] = [];
  const re = /^\s*FROM\s+(\S+)(?:\s+AS\s+(\S+))?/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ raw: m[0], image: resolveDockerArgs(text, m[1]), alias: m[2] ?? null });
  }
  return out;
}

interface WorkspaceManifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function workspaceManifests(): Map<string, { relative: string; manifest: WorkspaceManifest }> {
  const result = new Map<string, { relative: string; manifest: WorkspaceManifest }>();
  for (const parent of ["apps", "packages"]) {
    const directory = path.join(root, parent);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const manifestPath = path.join(directory, entry.name, "package.json");
      if (!entry.isDirectory() || !fs.existsSync(manifestPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as WorkspaceManifest;
      result.set(manifest.name, { relative: `${parent}/${entry.name}`, manifest });
    }
  }
  return result;
}

function workspaceClosure(rootName: string): Array<{ name: string; relative: string; hasPackageModules: boolean }> {
  const manifests = workspaceManifests();
  const pending = [rootName];
  const found = new Map<string, string>();
  while (pending.length > 0) {
    const name = pending.shift();
    if (!name || found.has(name)) continue;
    const entry = manifests.get(name);
    expect(entry, `workspace manifest ${name} is missing`).toBeDefined();
    if (!entry) continue;
    found.set(name, entry.relative);
    for (const group of [entry.manifest.dependencies, entry.manifest.devDependencies, entry.manifest.optionalDependencies]) {
      for (const [dependency, version] of Object.entries(group ?? {})) {
        if (version.startsWith("workspace:")) pending.push(dependency);
      }
    }
  }
  return [...found].map(([name, relative]) => {
    const manifest = manifests.get(name)?.manifest;
    const hasPackageModules = [manifest?.dependencies, manifest?.devDependencies, manifest?.optionalDependencies].some(group => Object.keys(group ?? {}).length > 0);
    return { name, relative, hasPackageModules };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function dockerStage(text: string, alias: string): string {
  const start = text.search(new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${alias}\\s*$`, "im"));
  if (start < 0) return "";
  const rest = text.slice(start);
  const next = rest.slice(1).search(/^FROM\s+/im);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe("SEC-052: images pinned by digest (no :latest, no floating tag); container runs non-root", () => {
  const dockerfilePath = findFirst(DOCKERFILE_CANDIDATES);
  const dockerfileText = readTextIfExists(dockerfilePath);

  it("a Dockerfile exists at one of the spec's candidate paths", () => {
    expect(
      dockerfilePath,
      `No Dockerfile found at any of: ${DOCKERFILE_CANDIDATES.join(", ")} ` +
        `(relative to ${root}). Expected red until WP-001 lands it.`,
    ).not.toBeNull();
  });

  it("every FROM line pins an external base image by digest (@sha256:...), not :latest or a floating tag", () => {
    expect(dockerfileText, "Dockerfile could not be read").not.toBeNull();
    const fromLines = parseFromLines(dockerfileText ?? "");
    expect(
      fromLines.length,
      "no FROM lines found in the Dockerfile",
    ).toBeGreaterThan(0);

    const knownAliases = new Set(
      fromLines.map((f) => f.alias).filter((a): a is string => Boolean(a)),
    );

    const violations = fromLines.filter((f) => {
      // A FROM referencing an earlier build stage by its own alias (e.g.
      // "FROM deps AS build") is not an external image and is exempt.
      if (knownAliases.has(f.image)) return false;
      const hasDigest = /@sha256:[0-9a-f]{64}/i.test(f.image);
      const isLatestOrFloating = /:latest\b/i.test(f.image) || !/[:@]/.test(f.image);
      return !hasDigest || isLatestOrFloating;
    });

    expect(
      violations.map((v) => v.raw),
      `FROM line(s) not pinned by digest: ${JSON.stringify(violations.map((v) => v.image))}`,
    ).toEqual([]);
  });

  it('a runtime USER directive sets a non-root user (not "root" and not uid 0)', () => {
    expect(dockerfileText, "Dockerfile could not be read").not.toBeNull();
    const userLines = [...(dockerfileText ?? "").matchAll(/^\s*USER\s+(\S+)/gim)].map(
      (m) => m[1],
    );
    expect(
      userLines.length,
      "no USER directive found in the Dockerfile — an image with no USER runs as root by default",
    ).toBeGreaterThan(0);

    const lastUser = userLines[userLines.length - 1];
    expect(
      /^root$/i.test(lastUser) || lastUser === "0",
      `final USER directive is "${lastUser}" — the runtime image must not run as root`,
    ).toBe(false);
  });

  it("installs the derived worker workspace closure and seeds every package dependency directory", () => {
    const text = dockerfileText ?? "";
    const deps = dockerStage(text, "deps");
    const dev = dockerStage(text, "dev");
    const build = dockerStage(text, "build");
    const closure = workspaceClosure("@seniorsocial/worker");
    expect(closure.map(entry => entry.name)).toEqual([
      "@seniorsocial/assistance",
      "@seniorsocial/audit",
      "@seniorsocial/contracts",
      "@seniorsocial/db",
      "@seniorsocial/flags",
      "@seniorsocial/messaging",
      "@seniorsocial/notify",
      "@seniorsocial/policy",
      "@seniorsocial/worker",
    ]);
    for (const entry of closure) {
      expect(deps, `${entry.name} manifest is absent from the dependency graph`).toContain(`COPY ${entry.relative}/package.json ./${entry.relative}/package.json`);
      expect(dev, `${entry.name} node_modules is absent from the dev image`).toContain(`/app/${entry.relative}/node_modules ./${entry.relative}/node_modules`);
      expect(build, `${entry.name} node_modules is absent from the web build image`).toContain(`/app/${entry.relative}/node_modules ./${entry.relative}/node_modules`);
    }
  });

  it("retains the complete web workspace closure in both dev and build dependency layers", () => {
    const text = dockerfileText ?? "";
    const deps = dockerStage(text, "deps");
    const dev = dockerStage(text, "dev");
    const build = dockerStage(text, "build");
    for (const entry of workspaceClosure("@seniorsocial/web")) {
      expect(deps, `${entry.name} manifest is absent from the web dependency graph`).toContain(`COPY ${entry.relative}/package.json ./${entry.relative}/package.json`);
      if (!entry.hasPackageModules) continue;
      expect(dev, `${entry.name} node_modules is absent from the dev image`).toContain(`/app/${entry.relative}/node_modules ./${entry.relative}/node_modules`);
      expect(build, `${entry.name} node_modules is absent from the web build image`).toContain(`/app/${entry.relative}/node_modules ./${entry.relative}/node_modules`);
    }
  });

  it("includes the root tsx launcher and worker pg-boss runtime dependency through copied frozen manifests", () => {
    const rootManifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as WorkspaceManifest;
    const workerManifest = workspaceManifests().get("@seniorsocial/worker")?.manifest;
    expect(rootManifest.devDependencies?.tsx).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(workerManifest?.dependencies?.["pg-boss"]).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(dockerStage(dockerfileText ?? "", "deps")).toContain("COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./");
  });

  it("keeps dependency installation frozen, script-free, cached, and out of startup/runtime stages", () => {
    const text = dockerfileText ?? "";
    const deps = dockerStage(text, "deps");
    expect(deps).toContain("--mount=type=cache,id=pnpm-store,target=/pnpm/store");
    expect(deps).toMatch(/pnpm install\s+--frozen-lockfile\s+--ignore-scripts/u);
    for (const stage of ["dev", "build", "runtime"]) expect(dockerStage(text, stage)).not.toMatch(/pnpm\s+(?:install|add)\b/u);
    expect(text).not.toMatch(/CMD\s+\[[^\]]*pnpm[^\]]*(?:install|add)/iu);
  });

  it("keeps both local dev and deploy runtime execution non-root", () => {
    for (const stage of ["dev", "runtime"]) {
      const users = [...dockerStage(dockerfileText ?? "", stage).matchAll(/^\s*USER\s+(\S+)/gim)].map(match => match[1]);
      expect(users.at(-1), `${stage} has no explicit user`).toBe("node");
    }
  });

  it("the compose db image (pgvector/pgvector:pg16) is pinned by digest, not a floating major-version tag", () => {
    const composePath = findFirst(COMPOSE_CANDIDATES);
    const composeText = readTextIfExists(composePath);
    expect(
      composePath,
      `No docker-compose file found at any of: ${COMPOSE_CANDIDATES.join(", ")}. ` +
        `Expected red until WP-001 lands it.`,
    ).not.toBeNull();

    const dbImageMatch = (composeText ?? "").match(
      /db:\s*[\s\S]*?image:\s*(\S+)/,
    );
    expect(
      dbImageMatch,
      "could not find the db service's image: line in the compose file",
    ).not.toBeNull();

    const dbImage = dbImageMatch?.[1] ?? "";
    expect(
      /@sha256:[0-9a-f]{64}/i.test(dbImage),
      `db image "${dbImage}" is not pinned by digest. compose-plan.md's own sketch ` +
        `uses the floating tag "pgvector/pgvector:pg16"; SEC-052's rule (images ` +
        `pinned by digest, no floating tag) requires firming this up in the actual ` +
        `infra/ output, which is exactly the gap this check exists to hold open until closed.`,
    ).toBe(true);
  });
});
