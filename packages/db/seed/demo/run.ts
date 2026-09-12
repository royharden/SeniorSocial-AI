import { createDatabaseClient } from '../../src/client.ts';
import { DEMO_ADMIN_ID, DEMO_ORG_ID, assertSyntheticFixture } from './data.ts';
import { resetDemoFixture, type DemoAssistanceNarrativeCodec } from './reset.ts';

const pepper = process.env.AUTH_TOKEN_PEPPER;
if (!pepper) throw new Error('AUTH_TOKEN_PEPPER is required');
const assistanceEncryptionKey = process.env.ASSISTANCE_ENCRYPTION_KEY;
if (!assistanceEncryptionKey) throw new Error('ASSISTANCE_ENCRYPTION_KEY is required');
assertSyntheticFixture();
// Keep @seniorsocial/db free of a package cycle while using the exact runtime
// codec. A non-literal import also keeps the DB TypeScript root self-contained.
const assistanceCodecModuleUrl = new URL('../../../assistance/src/crypto.ts', import.meta.url).href;
const assistanceCodecModule = await import(assistanceCodecModuleUrl) as {
  AesGcmNarrativeCodec: new (base64Key: string) => DemoAssistanceNarrativeCodec;
};
const assistanceCodec = new assistanceCodecModule.AesGcmNarrativeCodec(assistanceEncryptionKey);
const client = createDatabaseClient();
try {
  const result = await resetDemoFixture(
    client,
    { orgId: DEMO_ORG_ID, userId: process.env.DEMO_RESET_ACTOR_ID ?? DEMO_ADMIN_ID },
    pepper,
    assistanceCodec,
  );
  if (result.elapsedMs >= 120_000) throw new Error(`demo reset exceeded two minutes (${result.elapsedMs}ms)`);
  console.log(JSON.stringify(result));
} finally {
  await client.end();
}
