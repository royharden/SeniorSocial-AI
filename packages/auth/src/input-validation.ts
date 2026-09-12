import definitions from '../../contracts/src/definitions.json' with { type: 'json' };
import type { DemoCodeRequest, MagicLinkRequest, SmsCodeRequest, VerifyRequest } from '../../contracts/src/types';

type AuthInputMap = {
  MagicLinkRequest: MagicLinkRequest;
  SmsCodeRequest: SmsCodeRequest;
  VerifyRequest: VerifyRequest;
  DemoCodeRequest: DemoCodeRequest;
};

const authDefinitions = definitions as Record<keyof AuthInputMap, {
  required: string[];
  properties: Record<string, { type: string; format?: string; enum?: string[] }>;
}>;

export function validateCanonicalAuthInput<Name extends keyof AuthInputMap>(
  name: Name,
  input: unknown,
): { success: true; data: AuthInputMap[Name] } | { success: false } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { success: false };
  const record = input as Record<string, unknown>;
  const definition = authDefinitions[name];
  for (const required of definition.required) if (!(required in record)) return { success: false };
  for (const [key, value] of Object.entries(record)) {
    const property = definition.properties[key];
    if (!property) continue;
    if (property.type === 'string' && typeof value !== 'string') return { success: false };
    if (property.enum && !property.enum.includes(value as string)) return { success: false };
    if (property.format === 'email' && (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value))) {
      return { success: false };
    }
  }
  return { success: true, data: record as AuthInputMap[Name] };
}
