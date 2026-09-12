import type { CreateServiceInput, PatchServiceInput, ServiceLocale } from '@seniorsocial/services';
import { ServiceInputError } from '../../services/_response';

const maxJsonBytes = 64 * 1024;
const string = (value: unknown, name: string, required = false): string | undefined => {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || (required && value.trim() === '')) throw new ServiceInputError(`${name} must be a string`);
  return value;
};
const strings = (value: unknown, name: string): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ServiceInputError(`${name} must be a string array`);
  const result: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'string') throw new ServiceInputError(`${name} must be a string array`);
    result.push(item);
  }
  return result;
};

async function serviceBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new ServiceInputError('content-type must be application/json');
  }
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > maxJsonBytes) throw new ServiceInputError('request body is too large');
  const source = await request.text();
  if (new TextEncoder().encode(source).byteLength > maxJsonBytes) throw new ServiceInputError('request body is too large');
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new ServiceInputError('request body must be valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ServiceInputError('request body must be an object');
  return value as Record<string, unknown>;
}

function optionalFields(input: Record<string, unknown>): PatchServiceInput {
  const externalId = string(input.external_id, 'external_id');
  const descriptionEn = string(input.description_en, 'description_en');
  const descriptionEs = string(input.description_es, 'description_es');
  const eligibilityNoteEn = string(input.eligibility_note_en, 'eligibility_note_en');
  const eligibilityNoteEs = string(input.eligibility_note_es, 'eligibility_note_es');
  const phone = string(input.phone, 'phone');
  const languages = strings(input.languages, 'languages');
  const accessibility = strings(input.accessibility, 'accessibility');
  const categoryId = string(input.category_id, 'category_id');
  const nameEn = string(input.name_en, 'name_en');
  const nameEs = string(input.name_es, 'name_es');
  const sourceUpdatedAt = string(input.source_updated_at, 'source_updated_at');
  return {
    ...(categoryId === undefined ? {} : { categoryId }),
    ...(nameEn === undefined ? {} : { nameEn }),
    ...(nameEs === undefined ? {} : { nameEs }),
    ...(sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt }),
    ...(externalId === undefined ? {} : { externalId }),
    ...(descriptionEn === undefined ? {} : { descriptionEn }),
    ...(descriptionEs === undefined ? {} : { descriptionEs }),
    ...(eligibilityNoteEn === undefined ? {} : { eligibilityNoteEn }),
    ...(eligibilityNoteEs === undefined ? {} : { eligibilityNoteEs }),
    ...(phone === undefined ? {} : { phone }),
    ...(languages === undefined ? {} : { languages }),
    ...(accessibility === undefined ? {} : { accessibility }),
  };
}

export async function createServiceInput(request: Request): Promise<CreateServiceInput> {
  const body = await serviceBody(request);
  return {
    ...optionalFields(body),
    categoryId: string(body.category_id, 'category_id', true) ?? '',
    nameEn: string(body.name_en, 'name_en', true) ?? '',
    nameEs: string(body.name_es, 'name_es', true) ?? '',
    sourceUpdatedAt: string(body.source_updated_at, 'source_updated_at', true) ?? '',
  };
}

/** An empty PATCH is meaningful: it explicitly approves an imported draft without changing its fields. */
export async function patchServiceInput(request: Request): Promise<PatchServiceInput> {
  return optionalFields(await serviceBody(request));
}

export function requestLocale(request: Request): ServiceLocale {
  const locale = new URL(request.url).searchParams.get('locale') ?? 'en';
  if (locale !== 'en' && locale !== 'es') throw new ServiceInputError('locale must be en or es');
  return locale;
}
