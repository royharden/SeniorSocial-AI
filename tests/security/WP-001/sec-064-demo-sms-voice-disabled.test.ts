/**
 * SEC-064 (security, layer E, rfp:AI-8) — package: WP-001
 *
 * what_bug_this_catches (verbatim, story-test-map.csv): "Real SMS and voice
 * left enabled in a demo environment send a synthetic reminder to a real
 * number the first time a reviewer clicks."
 *
 * Spec: compose-plan.md s2 .env.example pins `SMS_PROVIDER=simulator` (also
 * s1's docker-compose.yml sketch hardcodes `SMS_PROVIDER: simulator` on the
 * web service) and leaves the Twilio credential lines empty;
 * 07-local-stack-and-railway-cutover.md line 192 states production also
 * ships `SMS_PROVIDER=simulator`, "not a real Twilio number."
 *
 * Ruling ADR-009 (DK-007, 2026-09-10): voice reminders remain cut rank 1 for
 * this run — there is no MVP voice adapter and no canonical VOICE_PROVIDER
 * (or similar) environment variable, and none should be added to
 * .env.example or compose-plan.md. A missing voice-provider key is
 * therefore a *pass*: it is N/A because voice is cut rank 1
 * (01-full-app-plan.md line 195 / 02-mvp-plan-38h.md line 50), not because
 * the variable was forgotten from the spec. SEC-064's voice half is
 * satisfied by the cut, together with this file's SMS_PROVIDER=simulator
 * and empty-credentials assertions for the SMS half. A present
 * voice-provider key whose value looks live is still a fail (soft
 * assertion below). Un-cutting voice is a new docket per ADR-009 s3; until
 * then this test must not require a voice-provider key to exist. This test
 * therefore (a) hard-asserts SMS_PROVIDER=simulator and empty Twilio
 * credentials, and (b) if any VOICE*PROVIDER-shaped key is present, asserts
 * it is not a live-sounding value, without requiring such a key to exist.
 */
import { describe, expect, it } from "vitest";
import { findRepoRoot, parseDotenvText } from "../../fixtures/WP-001/repo-helpers";
import fs from "node:fs";
import path from "node:path";

const root = findRepoRoot();

const ENV_EXAMPLE_CANDIDATES = ["infra/.env.example", ".env.example"];

function findEnvExample(): string | null {
  for (const c of ENV_EXAMPLE_CANDIDATES) {
    const p = path.join(root, c);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

describe("SEC-064: real SMS and voice are disabled by configuration in the demo environment", () => {
  const envPath = findEnvExample();
  const envVars = envPath ? parseDotenvText(fs.readFileSync(envPath, "utf8")) : null;

  it("an .env.example exists at one of the spec's candidate paths", () => {
    expect(
      envPath,
      `No .env.example found at any of: ${ENV_EXAMPLE_CANDIDATES.join(", ")} ` +
        `(relative to ${root}). Expected red until WP-001 lands it.`,
    ).not.toBeNull();
  });

  it("SMS_PROVIDER=simulator (never a real provider) by default", () => {
    expect(envVars, ".env.example could not be read/parsed").not.toBeNull();
    expect(
      envVars?.SMS_PROVIDER,
      `SMS_PROVIDER=${JSON.stringify(envVars?.SMS_PROVIDER)}, expected exactly ` +
        `"simulator" per compose-plan.md s2/07-local-stack-and-railway-cutover.md ` +
        `line 192 ("SMS_PROVIDER=simulator stays the default in every environment ` +
        `including production").`,
    ).toBe("simulator");
  });

  it("Twilio credentials ship empty in .env.example (no real value committed)", () => {
    expect(envVars, ".env.example could not be read/parsed").not.toBeNull();
    for (const key of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"]) {
      if (envVars && key in envVars) {
        expect(
          envVars[key],
          `${key}=${JSON.stringify(envVars[key])} is non-empty in .env.example — ` +
            `real credentials must never ship in a committed file (C5).`,
        ).toBe("");
      }
    }
  });

  it("voice is N/A because cut rank 1 (ADR-009), not because the variable was forgotten; any voice-provider key present must still not look live", () => {
    if (!envVars) return; // covered by the "exists" test above
    const voiceKeys = Object.keys(envVars).filter((k) => /VOICE/i.test(k) && /PROVIDER/i.test(k));
    for (const key of voiceKeys) {
      const value = envVars[key];
      expect(
        /twilio|live|real|production|prod\b/i.test(value),
        `${key}=${JSON.stringify(value)} looks like a live provider value, not a simulator/off value.`,
      ).toBe(false);
    }
  });
});
