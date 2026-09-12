import { z } from 'zod';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type SchemaDefinition = { [key: string]: Json };
type Metadata = {
  annotations: SchemaDefinition;
  requiredOrder?: string[];
  reference?: string;
  enumSyntax?: boolean;
  nullable?: boolean;
  integer?: boolean;
  implicitProperties?: boolean;
  unique?: boolean;
  format?: string;
  formatPattern?: Json;
};
const metadata = new WeakMap<object, Metadata>();
const keywords = new Set([
  '$ref', 'type', 'properties', 'required', 'items', 'enum', 'format',
  'additionalProperties', 'minItems', 'maxItems', 'uniqueItems',
  'minLength', 'maxLength', 'minimum', 'description',
]);
// These null-valued legacy annotations occur in the adopted YAML's flow maps.
// They are not validation keywords. New unknown keywords fail compilation.
const legacyAnnotations = new Set([
  'optional', 'never required to save', 'legal advice',
  'eligibility determination and dispatch requests', 'never booked', 'worker',
  'migrations - readiness fails if any is down so Railway cannot report a false Active',
]);

function object(value: Json | undefined, context: string): SchemaDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected schema object: ${context}`);
  }
  return value;
}

/** JSON structural equality: object property order does not change uniqueItems. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** Compile only the adopted keyword subset; never silently discard a constraint. */
export function compileSchemas(definitions: Record<string, SchemaDefinition>): Record<string, z.ZodType> {
  const compiled: Record<string, z.ZodType> = {};
  function compile(definition: SchemaDefinition): z.ZodType {
    const info: Metadata = { annotations: {} };
    for (const [key, value] of Object.entries(definition)) {
      if (key === 'description' || (legacyAnnotations.has(key) && value === null)) {
        info.annotations[key] = value;
      } else if (!keywords.has(key)) {
        throw new Error(`Unsupported schema keyword: ${key}`);
      }
    }
    if (typeof definition.$ref === 'string') {
      const prefix = '#/components/schemas/';
      if (!definition.$ref.startsWith(prefix)) throw new Error('Unsupported external schema reference');
      const name = definition.$ref.slice(prefix.length);
      if (!Object.hasOwn(definitions, name)) throw new Error(`Unknown schema reference: ${name}`);
      if (Object.keys(definition).some(key => key !== '$ref' && key !== 'description')) {
        throw new Error('Unsupported validation sibling of $ref');
      }
      info.reference = definition.$ref;
      const result = z.lazy(() => {
        const referenced = compiled[name];
        if (referenced === undefined) throw new Error(`Missing compiled schema: ${name}`);
        return referenced;
      });
      metadata.set(result, info);
      return result;
    }

    let kind = definition.type;
    if (Array.isArray(kind)) {
      if (kind.length !== 2 || kind[1] !== 'null' || (kind[0] !== 'string' && kind[0] !== 'integer')) {
        throw new Error('Unsupported schema type union');
      }
      info.nullable = true;
      kind = kind[0];
    }
    if (typeof kind !== 'string') throw new Error('Expected primitive schema type name');
    const applicable: Record<string, string[]> = {
      properties: ['object'], required: ['object'], additionalProperties: ['object'],
      items: ['array'], minItems: ['array'], maxItems: ['array'], uniqueItems: ['array'],
      minLength: ['string'], maxLength: ['string'], format: ['string'],
      minimum: ['number', 'integer'], enum: ['string'],
    };
    for (const [key, kinds] of Object.entries(applicable)) {
      if (Object.hasOwn(definition, key) && !kinds.includes(kind)) {
        throw new Error(`Unsupported ${key} on ${kind}`);
      }
    }
    for (const key of ['minItems', 'maxItems', 'minLength', 'maxLength']) {
      const value = definition[key];
      if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 0)) {
        throw new Error(`Invalid schema bound: ${key}`);
      }
    }
    if (definition.minimum !== undefined && (typeof definition.minimum !== 'number' || !Number.isFinite(definition.minimum))) {
      throw new Error('Invalid minimum');
    }
    if (definition.enum !== undefined && !Array.isArray(definition.enum)) throw new Error('Invalid enum');
    let result: z.ZodType;
    if (kind === 'object') {
      const properties = definition.properties === undefined ? {} : object(definition.properties, 'properties');
      const required = definition.required === undefined ? [] : definition.required;
      if (!Array.isArray(required) || required.some(key => typeof key !== 'string' || !Object.hasOwn(properties, key))) {
        throw new Error('Required property has no definition');
      }
      const shape: Record<string, z.ZodType> = {};
      for (const [key, child] of Object.entries(properties)) {
        const field = compile(object(child, key));
        shape[key] = required.includes(key) ? field : field.optional();
      }
      if (definition.additionalProperties !== undefined && definition.additionalProperties !== false) {
        throw new Error('Unsupported additionalProperties constraint');
      }
      result = definition.additionalProperties === false ? z.strictObject(shape) : z.looseObject(shape);
      info.requiredOrder = required as string[];
      info.implicitProperties = definition.properties === undefined;
    } else if (kind === 'array') {
      let array = z.array(compile(object(definition.items, 'items')));
      if (typeof definition.minItems === 'number') array = array.min(definition.minItems);
      if (typeof definition.maxItems === 'number') array = array.max(definition.maxItems);
      if (definition.uniqueItems !== undefined && definition.uniqueItems !== true) {
        throw new Error('Unsupported uniqueItems value');
      }
      info.unique = definition.uniqueItems === true;
      // The registered uniqueItems annotation below describes this exact runtime check.
      result = info.unique ? array.refine(values => new Set(values.map(canonical)).size === values.length,
        { message: 'Duplicate items' }) : array;
    } else if (kind === 'string') {
      let string: z.ZodString | z.ZodGUID | z.ZodISODateTime | z.ZodEmail;
      switch (definition.format) {
        case undefined: case 'binary': string = z.string(); break;
        case 'uuid': string = z.guid(); break;
        case 'date-time': string = z.iso.datetime({ offset: true }); break;
        case 'email': string = z.email(); break;
        default: throw new Error(`Unsupported string format: ${JSON.stringify(definition.format)}`);
      }
      if (typeof definition.minLength === 'number') string = string.min(definition.minLength);
      if (typeof definition.maxLength === 'number') string = string.max(definition.maxLength);
      if (typeof definition.format === 'string') {
        info.format = definition.format;
        const pattern = z.toJSONSchema(string).pattern;
        if (pattern !== undefined) info.formatPattern = pattern;
      }
      result = string;
    } else if (kind === 'integer' || kind === 'number') {
      let number = z.number();
      // multipleOf(1) enforces JSON integer semantics without inventing safe-integer bounds.
      if (kind === 'integer') number = number.multipleOf(1);
      if (typeof definition.minimum === 'number') number = number.min(definition.minimum);
      result = number;
      info.integer = kind === 'integer';
    } else if (kind === 'boolean') {
      result = z.boolean();
    } else {
      throw new Error(`Unsupported schema type: ${kind}`);
    }
    if (Array.isArray(definition.enum)) {
      if (definition.enum.length === 0 || definition.enum.some(value => typeof value !== 'string' && value !== null)) {
        throw new Error('Unsupported enum value');
      }
      if (kind !== 'string' || definition.format !== undefined || definition.minLength !== undefined || definition.maxLength !== undefined) {
        throw new Error('Unsupported constrained enum combination');
      }
      if (definition.enum.includes(null) !== !!info.nullable) throw new Error('Enum/type nullability mismatch');
      result = z.literal(definition.enum as [string | null, ...(string | null)[]]);
      info.enumSyntax = true;
    } else if (info.nullable) {
      // Record primitive normalization before wrapping so format checks remain visible.
      metadata.set(result, { ...info, nullable: false });
      result = result.nullable();
    }
    metadata.set(result, info);
    return result;
  }
  for (const [name, definition] of Object.entries(definitions)) compiled[name] = compile(definition);
  return compiled;
}

/** Derive validation facets from live Zod nodes, retaining only serialization annotations. */
export function emitSchema(schema: z.ZodType): SchemaDefinition {
  const emitted = z.toJSONSchema(schema, {
    io: 'input',
    override: context => {
      const info = metadata.get(context.zodSchema);
      const node = context.jsonSchema as SchemaDefinition;
      if (!info) return;
      if (info.reference) {
        for (const key of Object.keys(node)) delete node[key];
        node.$ref = info.reference;
        Object.assign(node, info.annotations);
        return;
      }
      if (info.enumSyntax && Object.hasOwn(node, 'const')) {
        const value = node.const;
        if (value === undefined) throw new Error('Missing emitted enum constant');
        node.enum = [value];
        delete node.const;
      }
      if (info.enumSyntax && Array.isArray(node.enum)) {
        node.type = node.enum.includes(null) ? ['string', 'null'] : 'string';
      }
      if (info.integer && node.multipleOf === 1) {
        node.type = 'integer';
        delete node.multipleOf;
      }
      if (info.format === 'binary') node.format = 'binary';
      if (info.formatPattern !== undefined && node.pattern === info.formatPattern) delete node.pattern;
      if (info.unique) node.uniqueItems = true;
      if (node.type === 'object') {
        // JSON Schema's omitted additionalProperties and {} both mean unconstrained.
        if (node.additionalProperties && typeof node.additionalProperties === 'object' &&
            Object.keys(node.additionalProperties).length === 0) delete node.additionalProperties;
        if (info.implicitProperties && node.properties && Object.keys(node.properties).length === 0) delete node.properties;
        if (Array.isArray(node.required) && info.requiredOrder) {
          const current = node.required.map(key => {
            if (typeof key !== 'string') throw new Error('Expected emitted required property name');
            return key;
          });
          const requiredOrder = info.requiredOrder;
          node.required = [...requiredOrder.filter(key => current.includes(key)),
            ...current.filter(key => !requiredOrder.includes(key))];
          if (node.required.length === 0) delete node.required;
        }
      }
      if (info.nullable && !info.enumSyntax && Array.isArray(node.anyOf) && node.anyOf.length === 2) {
        const [value, nil] = node.anyOf;
        if (value && nil && typeof value === 'object' && !Array.isArray(value) &&
            typeof nil === 'object' && !Array.isArray(nil) && nil.type === 'null') {
          delete node.anyOf;
          Object.assign(node, value, { type: [value.type, 'null'] });
        }
      }
      Object.assign(node, info.annotations);
    },
  }) as SchemaDefinition;
  delete emitted.$schema;
  return emitted;
}
