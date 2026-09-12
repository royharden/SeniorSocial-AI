import type { DatabaseClient } from '@seniorsocial/db';
import { withOrg } from '@seniorsocial/db';

export const flagKeys = [
  'ai.master', 'ai.concierge', 'ai.moderation', 'ai.translation_assist', 'ai.triage',
  'ai.intake_routing', 'ai.event_rerank', 'ai.conversation_starters', 'ai.summaries',
  'ai.provider.anthropic_api', 'ai.provider.cli_bridge', 'ai.cache.exact_match',
  'ai.batch.moderation', 'rag.enabled', 'notify.sms.real_send', 'notify.voice.real_send',
  'notify.web_push', 'messages.one_to_one', 'intake.health', 'translate.review_queue_ui',
  'admin.analytics_extended', 'events.resident_proposals', 'easy_mode.voice_io', 'demo.reset_endpoint',
] as const;
export type FlagKey = (typeof flagKeys)[number];
export type FlagScope = 'global' | 'org';
export interface FlagView { key: FlagKey; enabled: boolean; scope: FlagScope; updated_by: string }
export interface FlagMutationContext {
  orgId: string; actorId: string; scope: FlagScope; requestId?: string;
}

const flagSet = new Set<string>(flagKeys);
export function isFlagKey(value: string): value is FlagKey { return flagSet.has(value); }

interface StoredFlag { id: string; flag_key: FlagKey; scope: FlagScope; enabled: boolean; updated_by: string }
const systemActorId = '00000000-0000-4000-8000-000000000000';

export class FlagRepository {
  constructor(private readonly client: DatabaseClient) {}

  async effective(flag: FlagKey, orgId: string, cache?: RequestFlagCache): Promise<boolean> {
    if (cache) return cache.effective(flag, orgId);
    return this.readEffective(flag, orgId);
  }

  async readEffective(flag: FlagKey, orgId: string): Promise<boolean> {
    return withOrg(this.client, orgId, async transaction => {
      const rows = await transaction<{ global_enabled: boolean; org_enabled: boolean }[]>`
        select global_flag.enabled as global_enabled, org_flag.enabled as org_enabled
        from feature_flags global_flag
        join feature_flags org_flag on org_flag.flag_key = global_flag.flag_key
          and org_flag.scope = 'org' and org_flag.org_id = ${orgId}
        where global_flag.scope = 'global' and global_flag.flag_key = ${flag}
      `;
      const row = rows[0];
      if (!row) throw new Error(`flag is not provisioned: ${flag}`);
      return row.global_enabled && row.org_enabled;
    });
  }

  requestCache(): RequestFlagCache { return new RequestFlagCache(this); }

  async list(orgId: string): Promise<{ items: FlagView[] }> {
    return withOrg(this.client, orgId, async transaction => {
      const rows = await transaction<(StoredFlag & { global_enabled: boolean })[]>`
        select f.id, f.flag_key, f.scope, f.enabled, f.updated_by,
          g.enabled as global_enabled
        from feature_flags f
        join feature_flags g on g.flag_key = f.flag_key and g.scope = 'global'
        where f.scope = 'global' or (f.scope = 'org' and f.org_id = ${orgId})
        order by f.flag_key, f.scope
      `;
      return { items: rows.map(row => ({
        key: row.flag_key,
        enabled: row.scope === 'org' ? row.enabled && row.global_enabled : row.enabled,
        scope: row.scope,
        updated_by: row.scope === 'global' ? systemActorId : row.updated_by,
      })) };
    });
  }

  async set(flag: FlagKey, enabled: boolean, reason: string, context: FlagMutationContext): Promise<FlagView> {
    const rationale = reason.trim();
    if (!rationale || rationale.length > 400 || /[\r\n]/u.test(rationale)) {
      throw new Error('reason must be one line between 1 and 400 characters');
    }
    return withOrg(this.client, context.orgId, async transaction => {
      const rows = await transaction<FlagView[]>`
        select key, enabled, scope, updated_by
        from set_feature_flag(${context.orgId}, ${context.actorId}, ${context.scope}::flag_scope, ${flag}, ${enabled}, ${rationale}, ${context.requestId ?? null})
      `;
      const result = rows[0];
      if (!result) throw new Error(`flag is not provisioned: ${flag}`);
      return result;
    });
  }
}

export class RequestFlagCache {
  private readonly values = new Map<string, Promise<boolean>>();
  constructor(private readonly repository: FlagRepository) {}
  effective(flag: FlagKey, orgId: string): Promise<boolean> {
    const key = `${orgId}:${flag}`;
    const existing = this.values.get(key);
    if (existing) return existing;
    const value = this.repository.readEffective(flag, orgId);
    this.values.set(key, value);
    return value;
  }
}

export type AiKillFeature = 'ai.concierge' | 'ai.moderation' | 'ai.translation_assist' | 'ai.triage' | 'ai.intake_routing' | 'ai.event_rerank' | 'ai.conversation_starters' | 'ai.summaries';
export async function aiEnabled(flags: Pick<FlagRepository, 'effective'>, feature: AiKillFeature, orgId: string, cache?: RequestFlagCache): Promise<boolean> {
  const master = await flags.effective('ai.master', orgId, cache);
  if (!master) return false;
  return flags.effective(feature, orgId, cache);
}
