export function assertDedicatedAuthTestDatabase(databaseUrl = process.env.AUTH_TEST_DATABASE_URL): string {
  if (!databaseUrl) throw new Error('AUTH_TEST_DATABASE_URL is required for PostgreSQL auth tests');
  const databaseName = new URL(databaseUrl).pathname.slice(1).toLowerCase();
  if (process.env.AUTH_TEST_DB_ALLOWED !== 'true' || !/(?:^|[_-])test(?:$|[_-])/.test(databaseName)) {
    throw new Error('refusing auth tests outside an explicitly allowed dedicated test database');
  }
  return databaseUrl;
}
