import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function randomSixDigitCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function digestSecret(secret: string, pepper: string): string {
  return createHash('sha256').update(pepper).update('\0').update(secret).digest('hex');
}

export function equalDigest(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
