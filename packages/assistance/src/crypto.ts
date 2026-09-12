import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { NarrativeCodec } from './types.ts';

export class AesGcmNarrativeCodec implements NarrativeCodec {
  readonly #key: Buffer;
  constructor(base64Key: string) {
    this.#key = Buffer.from(base64Key, 'base64');
    if (this.#key.length !== 32) throw new Error('ASSISTANCE_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  }
  seal(plaintext: string): Promise<string> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Promise.resolve([iv, cipher.getAuthTag(), ciphertext].map(value => value.toString('base64url')).join('.'));
  }
  open(sealed: string): Promise<string> {
    const parts = sealed.split('.');
    if (parts.length !== 3) throw new Error('invalid assistance narrative envelope');
    const [ivText, tagText, ciphertextText] = parts;
    if (!ivText || !tagText || !ciphertextText) throw new Error('invalid assistance narrative envelope');
    const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Promise.resolve(Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64url')), decipher.final()]).toString('utf8'));
  }
}
