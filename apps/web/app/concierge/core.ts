import { randomUUID } from 'node:crypto';
import type {
  AssistanceCreationPort,
  ConciergeAiAvailabilityPort,
  AssistanceRequestRecord,
  ConciergeAiGatewayPort,
  ConciergeAnswer,
  ConciergeConversation,
  ConciergeLocale,
  ConciergeSession,
  DirectoryRecord,
  DirectorySearchPort,
} from './types.ts';
import { ConciergeForbiddenError, ConciergeInputError } from './types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_QUESTION_LENGTH = 1_000;
const HUMAN_ROUTE = '/assistance';

const copy = {
  en: {
    disclaimer: 'Directory information can change. Please confirm details with the listed provider or ask a person for help.',
    unknown: "I don't know based on the authorized directory records I can access. You can search the directory or talk to a person.",
    refusal: 'I can help find directory services, but I cannot diagnose, give legal advice, make a final eligibility decision, or dispatch services. A person can help you instead.',
    found: 'I found these authorized directory services:',
  },
  es: {
    disclaimer: 'La información del directorio puede cambiar. Confirme los detalles con el proveedor indicado o pida ayuda a una persona.',
    unknown: 'No lo sé según los registros autorizados del directorio a los que tengo acceso. Puede buscar en el directorio o hablar con una persona.',
    refusal: 'Puedo ayudarle a encontrar servicios del directorio, pero no puedo diagnosticar, dar asesoramiento legal, tomar una decisión final de elegibilidad ni enviar servicios. Una persona puede ayudarle.',
    found: 'Encontré estos servicios autorizados del directorio:',
  },
} as const;

type RefusalKind = 'diagnosis' | 'legal' | 'eligibility' | 'dispatch';
const refusalPatterns: Readonly<Record<RefusalKind, readonly RegExp[]>> = {
  diagnosis: [
    /\b(?:diagnose|diagnosis|medical diagnosis|what (?:condition|disease) (?:do|might) i have|do i have)\b/u,
    /\b(?:is|could|might) (?:my|this|that) [a-z ]{1,60} (?:shingles|cancer|diabetes|infection|stroke|neuropathy)\b/u,
    /\b(?:diagnosticar|diagnostico|que enfermedad (?:tengo|podria tener)|tengo)\b/u,
    /\b(?:es|podria ser) (?:mi|este|esta|esto) [a-z ]{1,60} (?:culebrilla|cancer|diabetes|infeccion|derrame|neuropatia)\b/u,
  ],
  legal: [
    /\b(?:legal advice|is (?:this|that|it) (?:legal|illegal)|should i sign|my legal rights|can (?:my )?(?:landlord|employer) legally|can i sue|should i sue)\b/u,
    /\b(?:asesoramiento legal|es (?:esto|eso) (?:legal|ilegal)|debo firmar|mis derechos legales|puedo demandar|debo demandar)\b/u,
  ],
  eligibility: [
    /\b(?:am i (?:definitely )?(?:eligible|approved|qualified)|do i qualify|decide (?:my )?eligibility|final eligibility|guarantee (?:i m|i am|approval))\b/u,
    /\b(?:soy elegible|estoy aprobad[oa]|califico para|cumplo (?:con )?los requisitos|decidir mi elegibilidad|elegibilidad final|garantizar (?:mi )?aprobacion)\b/u,
  ],
  dispatch: [
    /\b(?:dispatch|send|get me|call) (?:an |the )?(?:ambulance|police|fire truck|driver|911)|\b(?:book (?:the )?(?:ride|ambulance)|alert (?:the )?(?:police|staff)|call 911 for me)\b/u,
    /\b(?:enviar|enviame|mandar|mandame|conseguir|consigueme|despachar) (?:una |la )?(?:ambulancia|policia)|\b(?:reservar (?:el )?(?:viaje|transporte)|llamar al 911 por mi)\b/u,
  ],
};

const unsafeData = /(?:ignore (?:all |any )?(?:previous|prior)|system prompt|developer message|unrestricted mode|reveal .*prompt|tool[_ -]?call|SS-CANARY|INTERNAL-ONLY|<\/?[a-z][^>]*>)/iu;

export interface StoredConversation {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly handoffKey: string;
  turns: ConciergeAnswer[];
  aiEnabled: boolean;
  lastQuestion: string;
  handoff?: AssistanceRequestRecord;
}

export interface ConversationStore {
  create(value: StoredConversation, orgId?: string, userId?: string): Promise<void>;
  get(id: string, orgId?: string, userId?: string): Promise<StoredConversation | null>;
  save(value: StoredConversation, orgId?: string, userId?: string): Promise<void>;
  getOrCreateHandoff(
    id: string,
    orgId: string,
    userId: string,
    create: (conversation: Readonly<StoredConversation>) => Promise<AssistanceRequestRecord>,
  ): Promise<AssistanceRequestRecord | null>;
}

export class InMemoryConversationStore implements ConversationStore {
  private readonly rows = new Map<string, StoredConversation>();
  private readonly generations = new Map<string, number>();
  private readonly observedGenerations = new WeakMap<StoredConversation, number>();
  private readonly handoffs = new Map<string, Promise<AssistanceRequestRecord>>();
  private nextGeneration = 0;
  create(value: StoredConversation): Promise<void> {
    this.rows.set(value.id, structuredClone(value));
    this.generations.set(value.id, ++this.nextGeneration);
    return Promise.resolve();
  }
  get(id: string): Promise<StoredConversation | null> {
    const value = this.rows.get(id);
    if (!value) return Promise.resolve(null);
    const clone = structuredClone(value);
    const generation = this.generations.get(id);
    if (generation !== undefined) this.observedGenerations.set(clone, generation);
    return Promise.resolve(clone);
  }
  save(value: StoredConversation): Promise<void> {
    const observedGeneration = this.observedGenerations.get(value);
    if (observedGeneration !== undefined && this.generations.get(value.id) !== observedGeneration) return Promise.resolve();
    const next = structuredClone(value);
    const current = this.rows.get(value.id);
    if (!current) return Promise.resolve();
    // An answer that began before a handoff completed must not erase that handoff.
    if (current?.handoff && !next.handoff) next.handoff = structuredClone(current.handoff);
    this.rows.set(value.id, next);
    return Promise.resolve();
  }
  getOrCreateHandoff(id: string, orgId: string, userId: string, create: (conversation: Readonly<StoredConversation>) => Promise<AssistanceRequestRecord>): Promise<AssistanceRequestRecord | null> {
    const conversation = this.rows.get(id);
    if (!conversation || conversation.orgId !== orgId || conversation.userId !== userId) return Promise.resolve(null);
    const generation = this.generations.get(id);
    if (conversation.handoff) return Promise.resolve(structuredClone(conversation.handoff));
    const active = this.handoffs.get(id);
    if (active) return active.then(result => structuredClone(result));
    const claimed = create(structuredClone(conversation)).then(result => {
      const latest = this.rows.get(id);
      if (latest && this.generations.get(id) === generation) {
        latest.handoff = structuredClone(result);
        this.rows.set(id, latest);
      }
      return structuredClone(result);
    }).finally(() => {
      if (this.handoffs.get(id) === claimed) this.handoffs.delete(id);
    });
    this.handoffs.set(id, claimed);
    return claimed;
  }

  clear(): void {
    this.rows.clear();
    this.generations.clear();
    this.handoffs.clear();
  }
}

export interface ConciergeServiceOptions {
  readonly directory: DirectorySearchPort;
  readonly assistance: AssistanceCreationPort;
  readonly conversations?: ConversationStore;
  readonly ai?: ConciergeAiGatewayPort;
  readonly aiAvailability?: ConciergeAiAvailabilityPort;
  readonly createId?: () => string;
}

export class ConciergeService {
  private readonly conversations: ConversationStore;
  private readonly createId: () => string;

  constructor(private readonly options: ConciergeServiceOptions) {
    this.conversations = options.conversations ?? new InMemoryConversationStore();
    this.createId = options.createId ?? randomUUID;
  }

  async start(session: ConciergeSession): Promise<ConciergeConversation> {
    assertSession(session);
    let aiEnabled: boolean;
    try { aiEnabled = Boolean(this.options.ai) && await this.options.aiAvailability?.enabled(session.orgId) === true; }
    catch { aiEnabled = false; }
    const value: StoredConversation = {
      id: this.createId(), orgId: session.orgId, userId: session.userId,
      handoffKey: this.createId(), turns: [], aiEnabled, lastQuestion: '',
    };
    await this.conversations.create(value, session.orgId, session.userId);
    return present(value);
  }

  async get(session: ConciergeSession, id: string): Promise<ConciergeConversation | null> {
    assertSession(session);
    const value = await this.authorized(session, id);
    return value ? present(value) : null;
  }

  async answer(session: ConciergeSession, id: string, text: string, locale: ConciergeLocale): Promise<ConciergeAnswer | null> {
    assertSession(session);
    const question = text.trim();
    if (!question || question.length > MAX_QUESTION_LENGTH) throw new ConciergeInputError('text must be between 1 and 1000 characters');
    const conversation = await this.authorized(session, id);
    if (!conversation) return null;
    conversation.lastQuestion = question;
    const refusal = refusalKind(question);
    if (refusal) {
      const answer = refused(locale);
      conversation.turns.push(answer);
      await this.conversations.save(conversation, session.orgId, session.userId);
      return answer;
    }

    let records: readonly DirectoryRecord[] = [];
    try {
      records = (await this.options.directory.search({ orgId: session.orgId, query: question, locale, limit: 5 }))
        .filter(record => record.orgId === session.orgId && UUID.test(record.id));
    } catch {
      // A directory outage is rendered honestly; it never invites the model to answer ungrounded.
    }

    if (!records.length) {
      const answer = unknown(locale, this.options.ai ? 'v1' : 'native-v1');
      conversation.turns.push(answer);
      await this.conversations.save(conversation, session.orgId, session.userId);
      return answer;
    }

    let selected: readonly DirectoryRecord[] = records.slice(0, 3);
    let promptVersion = 'native-v1';
    let useNative = !this.options.ai;
    if (this.options.ai) {
      try {
        const result = await this.options.ai.chat({
          feature: 'concierge',
          context: {
            orgId: session.orgId, userId: session.userId, userRole: session.role,
            ...(session.onBehalfOf ? { onBehalfOf: session.onBehalfOf } : {}), locale, requestId: session.requestId,
          },
          messages: [
            { role: 'user', content: spotlight('resident', question) },
            { role: 'tool_result', toolCallId: 'directory-search', content: spotlight('directory', JSON.stringify(records.map(modelEvidence))) },
          ],
          schema: citationSchema,
          maxTokens: 160,
          temperature: 0,
        });
        promptVersion = result.promptRef?.version ?? 'v1';
        useNative = result.outcome === 'killed' || result.outcome === 'error' || result.outcome === 'egress_blocked';
        if (useNative) conversation.aiEnabled = false;
        const allowed = new Set(records.map(record => record.id));
        const cited = [...new Set(result.citations)].filter(idValue => allowed.has(idValue));
        if (result.outcome === 'ok' && cited.length > 0) {
          selected = cited.map(citation => records.find(record => record.id === citation)).filter((record): record is DirectoryRecord => Boolean(record));
        } else if (result.outcome === 'ok') {
          selected = [];
        } else if (!useNative) {
          selected = [];
        }
      } catch {
        conversation.aiEnabled = false;
        useNative = true;
      }
    }

    const answer = selected.length > 0 && (useNative || this.options.ai) ? grounded(locale, selected, promptVersion) : unknown(locale, promptVersion);
    conversation.turns.push(answer);
    await this.conversations.save(conversation, session.orgId, session.userId);
    return answer;
  }

  async handoff(session: ConciergeSession, id: string): Promise<AssistanceRequestRecord | null> {
    assertSession(session);
    if (session.role !== 'senior') throw new ConciergeForbiddenError('the resident must confirm this handoff');
    if (!UUID.test(id)) return null;
    return this.conversations.getOrCreateHandoff(id, session.orgId, session.userId, async conversation => {
      const result = await this.options.assistance.create({
        orgId: session.orgId,
        actorId: session.userId,
        summary: conversation.lastQuestion ? `Concierge handoff: ${plain(conversation.lastQuestion, 400)}` : 'Concierge handoff requested by resident',
        locale: session.locale,
        idempotencyKey: conversation.handoffKey,
      });
      if (result.org_id !== session.orgId) throw new Error('assistance port returned a cross-tenant record');
      return result;
    });
  }

  private async authorized(session: ConciergeSession, id: string): Promise<StoredConversation | null> {
    if (!UUID.test(id)) return null;
    const value = await this.conversations.get(id, session.orgId, session.userId);
    return value?.orgId === session.orgId && value.userId === session.userId ? value : null;
  }
}

const citationSchema = {
  type: 'object', properties: { citations: { type: 'array', items: { type: 'string' } } },
  required: ['citations'], additionalProperties: false,
} as const;

function refusalKind(value: string): RefusalKind | null {
  const normalized = normalize(value);
  for (const [kind, patterns] of Object.entries(refusalPatterns) as [RefusalKind, readonly RegExp[]][]) {
    if (patterns.some(pattern => pattern.test(normalized))) return kind;
  }
  return null;
}

function refused(locale: ConciergeLocale): ConciergeAnswer {
  return { text: copy[locale].refusal, citations: [], disclaimer: copy[locale].disclaimer, refused: true, human_route: HUMAN_ROUTE, prompt_version: 'deterministic-v1' };
}

function unknown(locale: ConciergeLocale, promptVersion: string): ConciergeAnswer {
  return { text: copy[locale].unknown, citations: [], disclaimer: copy[locale].disclaimer, human_route: HUMAN_ROUTE, prompt_version: promptVersion };
}

function grounded(locale: ConciergeLocale, records: readonly DirectoryRecord[], promptVersion: string): ConciergeAnswer {
  const lines = records.map(record => {
    const name = safeName(record.name);
    const description = safeOptional(record.description);
    const phone = safePhone(record.phone);
    return `- ${name}${description ? ` — ${description}` : ''}${phone ? ` — ${phone}` : ''} [${record.id}]`;
  });
  return { text: `${copy[locale].found}\n${lines.join('\n')}`, citations: records.map(record => record.id), disclaimer: copy[locale].disclaimer, human_route: HUMAN_ROUTE, prompt_version: promptVersion };
}

function modelEvidence(record: DirectoryRecord): Readonly<Record<string, unknown>> {
  return { id: record.id, name: plain(record.name, 120), description: record.description ? plain(record.description, 240) : '', phone: safePhone(record.phone) };
}

export function spotlight(source: 'resident' | 'directory', value: string): string {
  const escaped = value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');
  return `<untrusted source="${source}">${escaped}</untrusted>`;
}

function normalize(value: string): string {
  return value.normalize('NFKD').replace(/\p{Mark}/gu, '').toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/gu, ' ').trim();
}

function safeName(value: string): string { return unsafeData.test(value) ? 'Directory service' : plain(value, 120); }
function safeOptional(value: string | undefined): string { return value && !unsafeData.test(value) ? plain(value, 240) : ''; }
function safePhone(value: string | undefined): string { return value && /^[+()\d .x-]{3,40}$/iu.test(value) ? value.trim() : ''; }
function plain(value: string, limit: number): string {
  return [...value].map(character => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127 ? ' ' : character;
  }).join('').replace(/\s+/gu, ' ').trim().slice(0, limit);
}
function present(value: StoredConversation): ConciergeConversation { return { id: value.id, turns: value.turns, ai_enabled: value.aiEnabled }; }
function assertSession(session: ConciergeSession): void {
  if (!UUID.test(session.orgId) || !UUID.test(session.userId) || !session.requestId.trim()) throw new ConciergeForbiddenError('an authenticated server session is required');
}
