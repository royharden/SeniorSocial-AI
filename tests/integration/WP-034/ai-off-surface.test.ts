import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const runtime = new URL('../../../apps/web/app/api/v1/concierge/_runtime.ts', import.meta.url);
const client = new URL('../../../apps/web/app/concierge/concierge-client.tsx', import.meta.url);
const services = new URL('../../../apps/web/app/services/page.tsx', import.meta.url);
const help = new URL('../../../apps/web/app/(shell)/help/page.tsx', import.meta.url);

describe('WP-034 AI-off reviewer surface', () => {
  it('derives availability from both authoritative flags and hides the AI control when disabled', async () => {
    // what_bug_this_catches: the reviewer fixture looking off while a feature-specific or master flag is ignored.
    const [runtimeSource, clientSource] = await Promise.all([readFile(runtime, 'utf8'), readFile(client, 'utf8')]);
    expect(runtimeSource).toContain("flags.effective('ai.master', orgId)");
    expect(runtimeSource).toContain("flags.effective('ai.concierge', orgId)");
    expect(clientSource).toContain('conversation.ai_enabled ? <form');
    expect(clientSource).toContain('<a href="/services">');
    expect(clientSource).toContain('id="human-handoff"');
  });

  it('keeps truthful directory search and native assistance available independently of AI', async () => {
    // what_bug_this_catches: an AI kill switch leaving only decorative fallback copy rather than usable native actions.
    const [servicesSource, helpSource] = await Promise.all([readFile(services, 'utf8'), readFile(help, 'utf8')]);
    expect(servicesSource).toContain('servicesRepository().search');
    expect(servicesSource).toContain('method="get"');
    expect(helpSource).toContain('<AssistanceForm locale={locale} />');
    expect(helpSource).toContain('href="tel:911"');
  });
});
