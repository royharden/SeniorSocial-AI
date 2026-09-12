export const intakeKinds = ['legal', 'health'] as const;
export type IntakeKind = (typeof intakeKinds)[number];
export const intakeLocales = ['en', 'es'] as const;
export type IntakeLocale = (typeof intakeLocales)[number];
export const intakeStates = ['draft', 'routed', 'closed'] as const;
export type IntakeState = (typeof intakeStates)[number];
export const intakeIntents = ['save_draft', 'submit'] as const;
export type IntakeIntent = (typeof intakeIntents)[number];

export type IntakeAnswer = string | boolean | string[];
export type IntakeAnswers = Record<string, IntakeAnswer>;
export interface IntakeInput {
  answers: IntakeAnswers; disclaimerAcknowledged: boolean; locale: IntakeLocale; intent: IntakeIntent;
}
export interface PartnerCategory { id: string; slug: string; labelEn: string; labelEs: string }
export interface IntakeSubmission extends IntakeInput {
  id: string; orgId: string; residentId: string; kind: IntakeKind; state: IntakeState;
  routedCategory: PartnerCategory | null; createdAt: string; updatedAt: string;
}
export interface Actor { id: string; orgId: string; roles: readonly string[] }
export interface IntakeRoute { slug: string; reasonCode: string }
export interface SaveResult { submission: IntakeSubmission; created: boolean }

export interface IntakeRepository {
  save(orgId: string, residentId: string, kind: IntakeKind, input: IntakeInput, route: IntakeRoute | null,
    idempotencyKey: string, requestHash: string, at: string, id?: string): Promise<SaveResult | null>;
  get(orgId: string, residentId: string, id: string): Promise<IntakeSubmission | null>;
}
export interface IntakeAuthorization { canManage(actor: Actor, residentId: string): Promise<boolean> }
export interface IntakeService {
  save(actor: Actor, kind: IntakeKind, value: unknown, idempotencyKey: string, id?: string): Promise<IntakeSubmission>;
  get(actor: Actor, id: string): Promise<IntakeSubmission>;
}
export interface IntakeSql {
  query<Row extends Record<string, unknown>>(text: string, values: readonly (string | boolean | null)[]): Promise<Row[]>;
}
export type IntakeTransaction = <T>(orgId: string, work: (sql: IntakeSql) => Promise<T>) => Promise<T>;
export interface EncryptedAnswers { ciphertext: string; iv: string; tag: string }
export interface NarrativeCipher {
  encrypt(answers: IntakeAnswers, context: string): EncryptedAnswers;
  decrypt(payload: EncryptedAnswers, context: string): IntakeAnswers;
}
