import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { EncryptedArtifact, ExportEncryptionKeyProvider, ExportFormat } from './types.ts';
import { IndividualExportFault } from './types.ts';

export function artifactAad(input: {
  orgId: string; subjectId: string; jobId: string; format: ExportFormat;
}): Uint8Array {
  return Buffer.from(JSON.stringify([input.orgId, input.subjectId, input.jobId, input.format]), 'utf8');
}

export async function encryptArtifact(
  plaintext: Uint8Array,
  aad: Uint8Array,
  keys: ExportEncryptionKeyProvider,
): Promise<EncryptedArtifact> {
  const current = await keys.current();
  assertKey(current.key);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', current.key, nonce, { authTagLength: 16 });
  cipher.setAAD(versionedAad(aad, current.version));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    algorithm: 'aes-256-gcm', keyVersion: current.version, nonce,
    tag: cipher.getAuthTag(), ciphertext,
  };
}

export async function decryptArtifact(
  artifact: EncryptedArtifact,
  aad: Uint8Array,
  keys: ExportEncryptionKeyProvider,
  maximumCiphertextBytes: number,
): Promise<Uint8Array> {
  if (artifact.algorithm !== 'aes-256-gcm' || artifact.nonce.byteLength !== 12 ||
      artifact.tag.byteLength !== 16 || artifact.ciphertext.byteLength > maximumCiphertextBytes) {
    integrityFailure();
  }
  const key = await keys.byVersion(artifact.keyVersion);
  if (key === null) integrityFailure();
  assertKey(key);
  let unauthenticated: Uint8Array | undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, artifact.nonce, { authTagLength: 16 });
    decipher.setAAD(versionedAad(aad, artifact.keyVersion));
    decipher.setAuthTag(artifact.tag);
    unauthenticated = decipher.update(artifact.ciphertext);
    return Buffer.concat([unauthenticated, decipher.final()]);
  } catch {
    return integrityFailure();
  } finally {
    unauthenticated?.fill(0);
  }
}

function assertKey(key: Uint8Array): void {
  if (key.byteLength !== 32) {
    throw new IndividualExportFault(409, 'encryption_unavailable', 'artifact encryption is unavailable');
  }
}

function versionedAad(aad: Uint8Array, version: string): Uint8Array {
  return Buffer.from(JSON.stringify([version, Buffer.from(aad).toString('base64')]), 'utf8');
}

function integrityFailure(): never {
  throw new IndividualExportFault(409, 'artifact_integrity', 'artifact authentication failed');
}
