import { describe, expect, it } from 'vitest';
import { createIntakeNarrativeCipher } from '../../../packages/intake/src/index';

describe('WP-018 AES-256-GCM narrative protection', () => {
  const key = Buffer.alloc(32, 9).toString('base64');
  it('round-trips answers with a randomized 96-bit IV and no plaintext in ciphertext', () => {
    const cipher = createIntakeNarrativeCipher(key); const answers = { topic: 'housing', details: 'private legal narrative' };
    const first = cipher.encrypt(answers, 'org:resident:submission:legal');
    const second = cipher.encrypt(answers, 'org:resident:submission:legal');
    expect(first.iv).not.toBe(second.iv); expect(Buffer.from(first.iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(first.tag, 'base64')).toHaveLength(16); expect(first.ciphertext).not.toContain('private');
    expect(cipher.decrypt(first, 'org:resident:submission:legal')).toEqual(answers);
  });
  it('binds ciphertext to tenant, owner, row and kind through authenticated data', () => {
    const cipher = createIntakeNarrativeCipher(key); const encrypted = cipher.encrypt({ details: 'private' }, 'org-a:user:row:legal');
    expect(() => cipher.decrypt(encrypted, 'org-b:user:row:legal')).toThrow('could not be read');
  });
  it('fails closed without an exact 256-bit key', () => {
    expect(() => createIntakeNarrativeCipher(undefined)).toThrow('FIELD_ENCRYPTION_KEY is required');
    expect(() => createIntakeNarrativeCipher(Buffer.alloc(16).toString('base64'))).toThrow('exactly 32 bytes');
  });
});
