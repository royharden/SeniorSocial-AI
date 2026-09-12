import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const layout = readFileSync(new URL('../../../apps/web/app/layout.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../../../apps/web/app/globals.css', import.meta.url), 'utf8');

function declarations(selector: string): Readonly<Record<string, string>> {
  const start = styles.indexOf(`${selector} {`);
  expect(start, `missing ${selector} rule`).toBeGreaterThanOrEqual(0);
  const bodyStart = styles.indexOf('{', start) + 1;
  const bodyEnd = styles.indexOf('}', bodyStart);
  expect(bodyEnd, `unterminated ${selector} rule`).toBeGreaterThan(bodyStart);
  return Object.fromEntries(styles.slice(bodyStart, bodyEnd).split(';').map(value => value.trim()).filter(Boolean).map(value => {
    const separator = value.indexOf(':');
    return [value.slice(0, separator).trim(), value.slice(separator + 1).trim()];
  }));
}

describe('shared root skip navigation', () => {
  it('renders one localized link to the existing application main landmark', () => {
    // what_bug_this_catches: route-local skip links or a root wrapper create duplicate navigation and main landmarks.
    expect(layout.match(/href="#main"/gu)).toHaveLength(1);
    expect(layout).toContain('{text.skip_main}');
    expect(layout).toContain('className="ss-skip-link"');
    expect(layout.indexOf('className="ss-skip-link"')).toBeLessThan(layout.indexOf('{children}'));
    expect(layout).not.toMatch(/<main\b/u);
  });

  it('loads a keyboard-only treatment with a strong visible focus indicator', () => {
    // what_bug_this_catches: the first Tab lands on an always-visible or off-screen link with no perceptible focus ring.
    expect(layout).toContain("import './globals.css'");
    const base = declarations('.ss-skip-link');
    const focus = declarations('.ss-skip-link:focus-visible');
    expect(base).toMatchObject({
      'min-block-size': 'var(--ss-target)',
      position: 'fixed',
      transform: 'translateY(calc(-100% - 1rem))',
    });
    expect(base['min-inline-size']).toBeUndefined();
    expect(focus.outline).toBe('0.1875rem solid var(--ss-focus-outer)');
    expect(focus['box-shadow']).toBe('0 0 0 0.125rem var(--ss-focus-inner)');
    expect(focus.transform).toBe('none');
    expect(styles).toContain('@media (forced-colors: active)');
    expect(styles).toContain('outline-color: Highlight');
  });

  it('raises only the root Easy-mode skip target to the 3rem floor', () => {
    // what_bug_this_catches: the body-level skip link inheriting Standard target tokens despite an Easy-mode app shell.
    const selector = "body:has(.ss-app[data-mode='easy']) > .ss-skip-link";
    const easy = declarations(selector);
    expect(easy).toEqual({
      'box-sizing': 'border-box',
      'min-block-size': 'max(3rem, var(--ss-target))',
      'min-inline-size': 'max(3rem, var(--ss-target))',
    });
    expect(styles.split(selector)).toHaveLength(2);
    expect(styles).not.toContain("body:has(.ss-app[data-mode='standard']) > .ss-skip-link");
  });
});
