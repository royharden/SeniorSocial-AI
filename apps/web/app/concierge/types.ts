export type ConciergeLocale = 'en' | 'es';
export type ConciergeRole = 'senior' | 'caregiver' | 'staff' | 'admin' | 'partner' | 'support';

export interface ConciergeSession {
  readonly orgId: string;
  readonly userId: string;
  readonly role: ConciergeRole;
  readonly onBehalfOf?: string;
  readonly locale: ConciergeLocale;
  readonly requestId: string;
}

export interface DirectoryRecord {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly description?: string;
  readonly phone?: string;
  readonly eligibilityNote?: string;
  readonly languages?: readonly string[];
  readonly accessibility?: readonly string[];
}

export interface DirectorySearchPort {
  search(input: {
    readonly orgId: string;
    readonly query: string;
    readonly locale: ConciergeLocale;
    readonly limit: number;
  }): Promise<readonly DirectoryRecord[]>;
}

export interface AssistanceRequestRecord {
  readonly id: string;
  readonly org_id: string;
  readonly state: 'pending_unowned' | 'owned' | 'in_progress' | 'resolved' | 'closed_unable';
  readonly summary?: string;
  readonly triage_category?: string;
  readonly triage_source?: 'rules' | 'ai' | 'staff';
  readonly owner_id?: string | null;
  readonly sla_due_at?: string | null;
  readonly after_hours?: boolean;
}

export interface AssistanceCreationPort {
  create(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly onBehalfOf?: string;
    readonly summary: string;
    readonly locale: ConciergeLocale;
    readonly idempotencyKey: string;
  }): Promise<AssistanceRequestRecord>;
}

export interface ConciergeAiResult {
  readonly outcome: 'ok' | 'refused' | 'error' | 'killed' | 'egress_blocked';
  readonly text: string;
  readonly citations: readonly string[];
  readonly toolCalls: readonly { readonly id: string; readonly name: string; readonly arguments: Readonly<Record<string, unknown>> }[];
  readonly promptRef?: { readonly version: string };
}

export interface ConciergeAiGatewayPort {
  chat(input: {
    readonly feature: 'concierge';
    readonly context: {
      readonly orgId: string;
      readonly userId: string;
      readonly userRole: ConciergeRole;
      readonly onBehalfOf?: string;
      readonly locale: ConciergeLocale;
      readonly requestId: string;
    };
    readonly messages: readonly { readonly role: 'user' | 'tool_result'; readonly content: string; readonly toolCallId?: string }[];
    readonly schema: Readonly<Record<string, unknown>>;
    readonly maxTokens: number;
    readonly temperature: number;
  }): Promise<ConciergeAiResult>;
}

export interface ConciergeAiAvailabilityPort {
  enabled(orgId: string): Promise<boolean>;
}

export interface ConciergeAnswer {
  readonly text: string;
  readonly citations: readonly string[];
  readonly disclaimer: string;
  readonly refused?: boolean;
  readonly human_route?: string;
  readonly prompt_version: string;
}

export interface ConciergeConversation {
  readonly id: string;
  readonly turns: readonly ConciergeAnswer[];
  readonly ai_enabled: boolean;
}

export class ConciergeInputError extends Error {}
export class ConciergeForbiddenError extends Error {}
