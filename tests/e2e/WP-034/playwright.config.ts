import { defineConfig } from '@playwright/test';

export default defineConfig({ testDir: '.', timeout: 10_000, workers: 1 });
