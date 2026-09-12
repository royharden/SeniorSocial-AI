import fs from "node:fs";

type JsonSchema = Record<string, unknown>;

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateSchema(value: unknown, schema: JsonSchema, at = "$", errors: string[] = []): string[] {
  if (Array.isArray(schema.allOf)) {
    for (const child of schema.allOf as JsonSchema[]) validateSchema(value, child, at, errors);
  }
  if (schema.if && validateSchema(value, schema.if as JsonSchema).length === 0 && schema.then) {
    validateSchema(value, schema.then as JsonSchema, at, errors);
  }
  if (schema.const !== undefined && !sameJson(value, schema.const)) errors.push(`${at} must equal ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => sameJson(candidate, value))) errors.push(`${at} is not an allowed value`);

  const type = schema.type;
  const typeOk = type === undefined
    || (type === "object" && typeof value === "object" && value !== null && !Array.isArray(value))
    || (type === "array" && Array.isArray(value))
    || (type === "string" && typeof value === "string")
    || (type === "number" && typeof value === "number" && Number.isFinite(value))
    || (type === "integer" && Number.isInteger(value))
    || (type === "boolean" && typeof value === "boolean")
    || (type === "null" && value === null);
  if (!typeOk) {
    errors.push(`${at} must be ${typeof type === "string" ? type : "the declared schema type"}`);
    return errors;
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`${at} must have at least ${schema.minLength} characters`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${at} does not match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${at} must be >= ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${at} must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${at} must contain at least ${schema.minItems} items`);
    if (schema.items) value.forEach((item, index) => validateSchema(item, schema.items as JsonSchema, `${at}[${index}]`, errors));
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) if (!(key in record)) errors.push(`${at}.${key} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) if (!(key in properties)) errors.push(`${at}.${key} is not allowed`);
    }
    for (const [key, child] of Object.entries(properties)) if (key in record) validateSchema(record[key], child, `${at}.${key}`, errors);
  }
  return errors;
}

export function loadJsonSchema(pathname: string): JsonSchema {
  return JSON.parse(fs.readFileSync(pathname, "utf8")) as JsonSchema;
}

export function assertSchema(value: unknown, schema: JsonSchema, label: string): void {
  const errors = validateSchema(value, schema);
  if (errors.length > 0) throw new Error(`${label} failed locked-schema validation:\n${errors.join("\n")}`);
}
