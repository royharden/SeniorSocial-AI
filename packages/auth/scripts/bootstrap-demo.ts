import {
  bootstrapDemoAccounts,
  createAuthDatabaseClient,
  parseDemoBootstrapInputs,
  type AuthBeginClient,
} from '../src/index';

const pepper = process.env.AUTH_TOKEN_PEPPER;
const source = process.env.AUTH_DEMO_ACCOUNTS_JSON;
if (!pepper) throw new Error('AUTH_TOKEN_PEPPER is required');
if (!source) throw new Error('AUTH_DEMO_ACCOUNTS_JSON is required');

const client = createAuthDatabaseClient();
try {
  const count = await bootstrapDemoAccounts(
    client as unknown as AuthBeginClient,
    parseDemoBootstrapInputs(source),
    pepper,
  );
  console.log(`Bootstrapped ${count} expiring demo accounts with per-org canonical-role coverage.`);
} finally {
  await client.end();
}
