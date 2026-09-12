import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://ss:ss_dev_only@localhost:5432/seniorsocial',
  },
  strict: true,
  verbose: true,
});
