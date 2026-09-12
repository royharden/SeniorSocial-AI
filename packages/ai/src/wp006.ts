import type { AiEventRepository } from '@seniorsocial/audit';
import type { FlagRepository } from '@seniorsocial/flags';
import { DefaultAiGateway } from './gateway.ts';
import type { GatewayOptions } from './gateway.ts';

/** Binds the gateway to WP-006's tenant-scoped flags and append-only AiEventRepository. */
export function createWp006Gateway(
  flags: Pick<FlagRepository, 'effective'>,
  events: Pick<AiEventRepository, 'append'>,
  options: Omit<GatewayOptions, 'flags' | 'events'>,
) {
  return new DefaultAiGateway({
    ...options,
    flags: { effective: (flag, orgId) => flags.effective(flag, orgId) },
    events: { append: event => events.append(event) },
  });
}
