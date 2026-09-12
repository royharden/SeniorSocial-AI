#!/usr/bin/env node
/**
 * secrets-scan.mjs — the `verify:secrets` stage (WP-001, SEC-056).
 *
 * 04-tests-and-evals.md s4.2 names `gitleaks detect` for this stage. gitleaks is
 * NOT installed on this machine and installing a binary is not a builder's call,
 * so the stage is implemented here as a zero-dependency scanner rather than left
 * to a tool that is absent. The distinction matters: a stage that shells out to a
 * missing binary either errors on every run (and gets commented out) or is written
 * `gitleaks || true` (and is a no-op forever). Neither is a gate.
 *
 * This is deliberately NOT a claim that it equals gitleaks' rule set. It covers
 * the provider credential shapes this product can actually leak plus a tight
 * generic assignment rule. `backlog_proposed[]` in the WP-001 build receipt carries
 * the line to swap gitleaks in — behind a pinned action SHA — once it is available,
 * and to keep this scanner as the second opinion rather than delete it.
 *
 * Fails closed: any hit exits 1 and prints file:line with the value redacted.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SCAN_ROOTS = ['apps', 'packages', 'infra', 'scripts', '.github', 'tests', 'evals', 'docs'];
const SCAN_FILES = [
  '.dockerignore', '.editorconfig', '.gitignore', '.npmrc', 'README.md',
  'eslint.config.mjs', 'package.json', 'playwright.config.ts', 'pnpm-lock.yaml',
  'pnpm-workspace.yaml', 'tsconfig.base.json', 'turbo.json',
];

const SKIP_DIRS = new Set([
  'node_modules', '.next', '.turbo', 'dist', 'build', 'coverage', '.git',
  'playwright-report', 'test-results', '.pnpm-store',
]);

const BINARY = /\.(png|jpe?g|gif|ico|webp|avif|pdf|woff2?|ttf|otf|eot|zip|gz|tgz|mp4|webm|mp3|wav|node|wasm)$/i;

/** Values that are inert by construction and must not raise a finding. */
const INERT = [
  /^dev[-_]?only/i,
  /^changeme$/i,
  /^(your|my|the)[-_]/i,
  /^x{3,}$/i,
  /^placeholder/i,
  /^example/i,
  /^test[-_]/i,
  /^\$\{/,
  /^process\.env\./,
  /^<.*>$/,
  /^[-_.]*$/,
];

const RULES = [
  { id: 'anthropic-api-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: 'openai-api-key', re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/g },
  { id: 'aws-access-key-id', re: /\b(?:AKIA|ASIA|AIDA|AROA)[0-9A-Z]{16}\b/g },
  { id: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g },
  { id: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g },
  { id: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'twilio-account-sid', re: /\bAC[0-9a-fA-F]{32}\b/g },
  { id: 'twilio-api-key', re: /\bSK[0-9a-fA-F]{32}\b/g },
  { id: 'stripe-secret-key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'private-key-block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  {
    id: 'generic-secret-assignment',
    re: /\b(?:api[_-]?key|secret|token|password|passwd|auth)\s*[:=]\s*["']?([A-Za-z0-9+/=_-]{24,})["']?/gi,
    capture: 1,
  },
];

function redact(v) {
  if (v.length <= 8) return '*'.repeat(v.length);
  return `${v.slice(0, 4)}${'*'.repeat(Math.min(v.length - 8, 24))}${v.slice(-4)}`;
}

const files = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    if (BINARY.test(entry)) continue;
    if (st.size > 2 * 1024 * 1024) continue;
    files.push(p);
  }
}

for (const r of SCAN_ROOTS) {
  const abs = join(REPO_ROOT, r);
  if (existsSync(abs)) walk(abs);
}
for (const f of SCAN_FILES) {
  const abs = join(REPO_ROOT, f);
  if (existsSync(abs)) files.push(abs);
}

const findings = [];

for (const file of files) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  if (text.indexOf(String.fromCharCode(0)) !== -1) continue; // binary past the ext test

  // The scanner's own rule table is full of credential-shaped strings.
  if (resolve(file) === resolve(fileURLToPath(import.meta.url))) continue;

  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (/secrets-scan:\s*allow/.test(line)) return;
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        const value = rule.capture ? m[rule.capture] : m[0];
        if (!value) continue;
        if (INERT.some((p) => p.test(value))) continue;
        findings.push({
          file: relative(REPO_ROOT, file).replace(/\\/g, '/'),
          line: i + 1,
          rule: rule.id,
          value: redact(value),
        });
      }
    }
  });
}

if (findings.length > 0) {
  console.error(`verify:secrets: FAIL - ${findings.length} finding(s) in ${files.length} scanned file(s).`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}: [${f.rule}] ${f.value}`);
  }
  console.error('  A false positive is silenced with a `secrets-scan: allow` comment on the line,');
  console.error('  and that silencing is reviewable in the diff. Never widen a rule to pass.');
  process.exit(1);
}

console.log(`verify:secrets: PASS - ${RULES.length} rule(s) over ${files.length} file(s); 0 findings.`);
process.exit(0);
