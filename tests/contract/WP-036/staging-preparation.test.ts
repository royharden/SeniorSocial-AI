import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  requireResolvedBaseUrl, requireResolvedDigest, requireResolvedSha, validateCandidateCheckout,
} from '../../../infra/railway/release-gate.mjs';

const root = new URL('../../../', import.meta.url);
const contract = JSON.parse(readFileSync(new URL('infra/railway/deployment-contract.json', root), 'utf8')) as any;
const healthRoute = readFileSync(new URL('apps/web/app/api/v1/health/route.ts', root), 'utf8');
const prepareImage = readFileSync(new URL('infra/railway/prepare-image.ps1', root), 'utf8');

describe('WP-036 staging preparation', () => {
  it('binds Railway Active gating to the implemented web and worker health surfaces', () => {
    expect(contract.services.web.healthcheck.path).toBe('/api/v1/health');
    expect(contract.services.web.healthcheck.port_environment_variable).toBe('PORT');
    expect(contract.services.web.healthcheck.activation_requirement).toMatch(/Active only after/u);
    expect(contract.services.worker.healthcheck).toMatchObject({ path: '/healthz', port_environment_variable: 'PORT' });
    expect(healthRoute).toContain("status: 'ok'");
    expect(healthRoute).toContain("service: 'web'");
  });

  it('fails closed on all three unresolved deployment identities', () => {
    expect(() => requireResolvedSha('SEALED_CANDIDATE_SHA')).toThrow(/resolved/u);
    expect(() => requireResolvedBaseUrl('DEPLOYED_BASE_URL')).toThrow(/unresolved/u);
    expect(() => requireResolvedDigest('IMAGE_DIGEST')).toThrow(/resolved/u);
    expect(() => requireResolvedBaseUrl('http://example.test')).toThrow(/HTTPS origin/u);
    expect(() => requireResolvedDigest('sha256:abcd')).toThrow(/OCI manifest digest/u);
  });

  it('requires an exact clean sealed checkout before local preparation', () => {
    const sha = 'a'.repeat(40);
    const calls: string[][] = [];
    const run = (_file: string, args: string[]) => {
      calls.push(args);
      return args[0] === 'rev-parse' ? `${sha}\n` : '';
    };
    expect(validateCandidateCheckout({ repoRoot: 'C:/candidate', sealedCandidateSha: sha, run })).toEqual({
      sealedCandidateSha: sha, clean: true,
    });
    expect(calls).toEqual([['rev-parse', 'HEAD'], ['status', '--porcelain']]);
    expect(() => validateCandidateCheckout({
      repoRoot: 'C:/candidate', sealedCandidateSha: sha,
      run: (_file: string, args: string[]) => args[0] === 'rev-parse' ? `${sha}\n` : ' M file.ts',
    })).toThrow(/dirty/u);
  });

  it('runs the fail-closed leak scan before the first image build and never uploads', () => {
    expect(prepareImage.indexOf('leak-scan.ps1')).toBeGreaterThan(-1);
    expect(prepareImage.indexOf('docker build')).toBeGreaterThan(prepareImage.indexOf('leak-scan.ps1'));
    expect(prepareImage).toContain('IMAGE_DIGEST remains unresolved');
    expect(prepareImage).not.toMatch(/docker\s+(?:push|login)|railway\s+(?:up|link|login)/iu);
  });
});
