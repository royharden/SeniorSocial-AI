export interface HumanMatrixBinding {
  readonly sealedCandidateSha: string;
  readonly localBaseUrl: string;
  readonly candidateState: string;
  readonly boundBy: string | null;
  readonly boundAtUtc: string | null;
  readonly priorAutomatedBaselinesAreNotThisCandidate: readonly string[];
}

const fullSha = /^[0-9a-f]{40}$/u;

export function validateHumanMatrixBinding(binding: HumanMatrixBinding): string[] {
  const errors: string[] = [];
  if (binding.sealedCandidateSha === 'POST_REPAIR_SEALED_SHA') {
    errors.push('sealedCandidateSha still contains POST_REPAIR_SEALED_SHA');
  } else if (!fullSha.test(binding.sealedCandidateSha)) {
    errors.push('sealedCandidateSha must be a full lowercase 40-character Git SHA');
  }
  if (binding.priorAutomatedBaselinesAreNotThisCandidate.includes(binding.sealedCandidateSha)) {
    errors.push('sealedCandidateSha must be distinct from recorded automated baselines');
  }

  if (binding.localBaseUrl === 'LOCAL_BASE_URL') {
    errors.push('localBaseUrl still contains LOCAL_BASE_URL');
  } else {
    try {
      const url = new URL(binding.localBaseUrl);
      if (url.protocol !== 'http:') errors.push('localBaseUrl must use HTTP for the bound local run');
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
        errors.push('localBaseUrl must use a loopback hostname');
      }
      if (url.username !== '' || url.password !== '') errors.push('localBaseUrl must not contain credentials');
      if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
        errors.push('localBaseUrl must be an origin with no path, query, or fragment');
      }
    } catch {
      errors.push('localBaseUrl must be a valid absolute URL');
    }
  }

  if (binding.candidateState !== 'post_repair_sealed') {
    errors.push('candidateState must be post_repair_sealed');
  }
  if (typeof binding.boundBy !== 'string' || binding.boundBy.trim() === '') {
    errors.push('boundBy must identify the integrator who bound the candidate');
  }
  if (typeof binding.boundAtUtc !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(binding.boundAtUtc)
    || Number.isNaN(Date.parse(binding.boundAtUtc))) {
    errors.push('boundAtUtc must be a valid second-precision UTC timestamp');
  }
  return errors;
}
