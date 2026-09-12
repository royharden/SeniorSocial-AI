import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const port=3129;
export default defineConfig({testDir:'.',testMatch:'admin-smoke.spec.ts',workers:1,timeout:30000,use:{baseURL:`http://localhost:${port}`},webServer:{command:`node node_modules/next/dist/bin/next dev --webpack --port ${port}`,cwd:fileURLToPath(new URL('../../../apps/web/',import.meta.url)),url:`http://localhost:${port}/home`,timeout:60000,reuseExistingServer:false,stdout:'pipe',stderr:'pipe'}});
