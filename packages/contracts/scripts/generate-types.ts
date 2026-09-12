import { writeFileSync } from 'node:fs';
import { generateOpenApiDocument } from '../src/index.ts';
import type { Json, SchemaDefinition } from '../src/schema.ts';

function schemaObject(value: Json | undefined): SchemaDefinition {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected generated schema object');
  }
  return value;
}

const definitions = schemaObject(schemaObject(generateOpenApiDocument().components).schemas);
function typeOf(schema: SchemaDefinition): string {
  if (typeof schema.$ref === 'string') return schema.$ref.slice('#/components/schemas/'.length);
  if (Array.isArray(schema.enum)) return schema.enum.map(value => JSON.stringify(value)).join(' | ');
  if (Array.isArray(schema.type)) return schema.type.map(type => typeOf({ ...schema, type })).join(' | ');
  if (schema.type === 'object') {
    const properties = schemaObject(schema.properties ?? {});
    const required = schema.required;
    if (required !== undefined && !Array.isArray(required)) throw new Error('Expected generated required list');
    const entries = Object.entries(properties).map(([name, field]) =>
      `${JSON.stringify(name)}${required?.includes(name) ? '' : '?'}: ${typeOf(schemaObject(field))};`);
    if (schema.additionalProperties !== false) entries.push('[key: string]: unknown;');
    return `{ ${entries.join(' ')} }`;
  }
  if (schema.type === 'array') return `Array<${typeOf(schemaObject(schema.items))}>`;
  if (schema.type === 'integer' || schema.type === 'number') return 'number';
  if (schema.type === 'string' || schema.type === 'boolean' || schema.type === 'null') return schema.type;
  throw new Error(`Unsupported generated type: ${JSON.stringify(schema.type)}`);
}
const source = [
  '// Generated from live Zod schemas by scripts/generate-types.ts. Do not edit by hand.',
  ...Object.entries(definitions).map(([name, schema]) => `export type ${name} = ${typeOf(schemaObject(schema))};`),
  'export interface ContractTypes {',
  ...Object.keys(definitions).map(name => `  ${name}: ${name};`),
  '}',
  '',
].join('\n');
writeFileSync(new URL('../src/types.ts', import.meta.url), source);
process.stdout.write(`Generated ${Object.keys(definitions).length} primary DTO types from live validators.\n`);
