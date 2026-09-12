import postgres from 'postgres';

export function createAuthDatabaseClient(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL is required');
  const setting = process.env.DATABASE_SSL ?? 'disable';
  if (setting !== 'disable' && setting !== 'require') {
    throw new Error('DATABASE_SSL must be "require" or "disable"');
  }
  return postgres(url, { max: 10, ssl: setting === 'require' ? 'require' : false });
}
