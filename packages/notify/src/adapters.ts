import type { Adapter, Confirmation, Delivery } from './types.ts';

const COMPOSE_MAILPIT_URL = 'http://mailpit:8025/';

/** No network, clock, random outcome or real telephone number is used. */
export function createSimulator(outcome: Confirmation['outcome'] = 'confirmed'): Adapter {
  return { send: (_delivery: Delivery) => Promise.resolve({ outcome, synthetic: true } as Confirmation) };
}

/** Mailpit capture API, deliberately restricted to numeric loopback or the one
 * explicitly marked local-Compose endpoint. Redirects are refused and all
 * recipients are synthetic .invalid addresses. Never release captured messages
 * or configure Mailpit auto-relay in the local test stack.
 */
export function createLocalAdapter(
  mailpitUrl: string,
  transport: typeof fetch = fetch,
): Adapter {
  const url = new URL(mailpitUrl);
  const numericLoopback = ['127.0.0.1', '[::1]'].includes(url.hostname);
  const markedLocalCompose = mailpitUrl === COMPOSE_MAILPIT_URL &&
    process.env.SENIORSOCIAL_LOCAL_COMPOSE === 'true' &&
    process.env.EMAIL_PROVIDER === 'mailpit' &&
    process.env.MAILPIT_URL === COMPOSE_MAILPIT_URL;
  if (url.protocol !== 'http:' || (!numericLoopback && !markedLocalCompose) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw new Error('Mailpit must use an authorized local endpoint');
  const simulator = createSimulator();
  return {
    async send(delivery) {
      if (delivery.channel === 'sms' || delivery.channel === 'voice') return simulator.send(delivery);
      if (delivery.channel !== 'email' || !/^[a-f0-9]{64}$/.test(delivery.idempotencyKey)) return { outcome: 'failed', synthetic: true };
      try {
        const response = await transport(new URL('/api/v1/send', url), {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ From: { Email: 'notify@example.invalid', Name: 'Synthetic SeniorSocial' },
            To: [{ Email: `capture-${delivery.idempotencyKey.slice(0, 16)}@example.invalid` }],
            Subject: '[SYNTHETIC] Notification', Text: `[SYNTHETIC LOCAL CAPTURE]\n${delivery.body}` }),
        });
        if (!response.ok) return { outcome: 'ambiguous', synthetic: true };
        const receipt: unknown = await response.json();
        if (receipt && typeof receipt === 'object' && 'ID' in receipt && typeof receipt.ID === 'string' && receipt.ID.length > 0)
          return { outcome: 'confirmed', synthetic: true };
      } catch { /* Transport errors do not prove the local server rejected the message. */ }
      return { outcome: 'ambiguous', synthetic: true };
    },
  };
}
