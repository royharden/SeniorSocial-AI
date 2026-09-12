import type { z } from 'zod';
import { parse, stringify } from 'yaml';
import definitions from './definitions.json' with { type: 'json' };
import document from './document.json' with { type: 'json' };
import presentation from './presentation.json' with { type: 'json' };
import { canonical, compileSchemas, emitSchema, type Json, type SchemaDefinition } from './schema.ts';
import type { ContractTypes } from './types.ts';
export type * from './types.ts';

export type SchemaName = keyof ContractTypes;
export const schemas = Object.freeze(compileSchemas(definitions as Record<string, SchemaDefinition>)) as
  Readonly<{ [Name in SchemaName]: z.ZodType<ContractTypes[Name]> }>;

/** The document is rebuilt from the same live validators used at input boundaries. */
export function generateOpenApiDocument(schemaSet: Readonly<Record<string, z.ZodType>> = schemas): Record<string, Json> {
  const base = structuredClone(document) as unknown as Record<string, Json>;
  const components = base.components as Record<string, Json>;
  components.schemas = Object.fromEntries(Object.entries(schemaSet).map(([name, schema]) => [name, emitSchema(schema)]));
  return base;
}

function leaves(value: Json, path: (string | number)[] = []): string[] {
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => leaves(child, [...path, Array.isArray(value) ? Number(key) : key]));
  }
  return [JSON.stringify(path)];
}

function at(value: Json, path: (string | number)[]): Json {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object') throw new Error('Invalid presentation path');
    const next = (current as Record<string | number, Json>)[key];
    if (next === undefined) throw new Error('Missing presentation path');
    current = next;
  }
  return current;
}

/** Presentation holds punctuation/keys, never schema scalar values. */
export function generateOpenApiYaml(schemaSet: Readonly<Record<string, z.ZodType>> = schemas): string {
  const generated = generateOpenApiDocument(schemaSet);
  const schemaObjects = (generated.components as Record<string, Json>).schemas;
  if (schemaObjects === undefined) throw new Error('Missing generated schemas');
  const actualPaths = leaves(schemaObjects, ['components', 'schemas']).sort();
  const slotPaths = presentation.slots.map(slot => JSON.stringify(slot.path)).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(slotPaths)) {
    // A structural validator change must change the emitted document, not echo stale bytes.
    return stringify(generated);
  }
  const output = presentation.template.replace(/\{\{SCHEMA_VALUE_(\d+)\}\}/g, (_match, index: string) => {
    const slot = presentation.slots[Number(index)];
    if (slot === undefined) throw new Error('Missing presentation slot');
    const value = at(generated, slot.path);
    if (value !== null && typeof value === 'object') throw new Error('Expected presentation scalar');
    if (slot.style === 'empty' && value === null) return '';
    if (slot.style === "'") return `'${String(value).replaceAll("'", "''")}'`;
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
  // A changed scalar may need quoting that its original presentation did not need.
  // Fall back to normal YAML instead of emitting an invalid or semantically stale document.
  try {
    return canonical(parse(output)) === canonical(generated) ? output : stringify(generated);
  } catch {
    return stringify(generated);
  }
}

function stateEnum(name: SchemaName): readonly string[] {
  const generated = emitSchema(schemas[name]);
  const state = (generated.properties as Record<string, SchemaDefinition>).state;
  if (state === undefined || !Array.isArray(state.enum) || state.enum.some(value => typeof value !== 'string')) {
    throw new Error(`Missing state vocabulary: ${name}`);
  }
  return Object.freeze(state.enum as string[]);
}

export const requestStatusVocabulary = Object.freeze({
  ride: stateEnum('RideRequest'),
  assistance: stateEnum('AssistanceRequest'),
});

/** Transport adapters can use this fixed response without exposing Zod issues or input data. */
export function validateInput<Name extends SchemaName>(name: Name, input: unknown):
  | { success: true; data: ContractTypes[Name] }
  | { success: false; problem: { type: string; title: string; status: number } } {
  const result = schemas[name].safeParse(input);
  return result.success
    ? { success: true, data: result.data }
    : { success: false, problem: { type: 'about:blank', title: 'Invalid request', status: 422 } };
}
