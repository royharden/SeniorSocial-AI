import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { NarrativeCipher } from './types.ts';
import { IntakeError, parseAnswers } from './validation.ts';

function decodeKey(encoded: string): Buffer {
  const value = encoded.trim();
  const key = /^[0-9a-f]{64}$/iu.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('FIELD_ENCRYPTION_KEY must encode exactly 32 bytes');
  return key;
}

export function createIntakeNarrativeCipher(encodedKey: string | undefined): NarrativeCipher {
  if (!encodedKey) throw new Error('FIELD_ENCRYPTION_KEY is required');
  const key = decodeKey(encodedKey);
  return {
    encrypt(answers, context) {
      const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(context, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(answers), 'utf8'), cipher.final()]);
      return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
    },
    decrypt(payload, context) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
        decipher.setAAD(Buffer.from(context, 'utf8')); decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
        const cleartext = Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, 'base64')), decipher.final()]).toString('utf8');
        return parseAnswers(JSON.parse(cleartext) as unknown);
      } catch { throw new IntakeError('Encrypted intake answers could not be read', 500); }
    },
  };
}
