// Attempt-2 public adapter allowed by launch packet. No builder source was read.
export interface Validator {
  safeParse(value: unknown): { success: boolean; data?: unknown; error?: unknown };
}
export interface RuntimeContracts {
  schemas: Record<string, Validator>;
  generateOpenApiYaml(): string;
  generateOpenApiDocument(): Record<string, unknown>;
  requestStatusVocabulary: { ride: readonly string[]; assistance: readonly string[] };
}
export async function contracts(): Promise<RuntimeContracts> {
  const entry = '../../../packages/contracts/src/index.ts';
  return (await import(new URL(entry, import.meta.url).href)) as RuntimeContracts;
}
