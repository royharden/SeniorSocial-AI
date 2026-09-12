import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import en from '../../../packages/i18n/en/messages.json';
import status from '../../../packages/i18n/es/messages.status.json';

describe('WP-032 messaging source binding', () => {
  it('binds every fully qualified status entry to the exact English catalog bytes', async () => {
    // what_bug_this_catches: stale review state surviving after consequential English messaging copy changes.
    const bytes = await readFile(new URL('../../../packages/i18n/en/messages.json', import.meta.url));
    const sourceVersion = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    expect(sourceVersion).toBe('sha256:a46105fa5e7c6e7ef848f4c29e6a4b9c9cfd3c7b03689be76c41b7ba575a4ba1');
    expect(Object.keys(status).sort()).toEqual(Object.keys(en).map(key => `messages.${key}`).sort());
    expect(new Set(Object.values(status).map(entry => entry.source_version))).toEqual(new Set([sourceVersion]));
  });
});
