const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const ragLimits = Object.freeze({
  queryCharacters: 512,
  contentCharacters: 16_000,
  results: 50,
  dimensions: 4_096,
  idempotencyKeyCharacters: 200,
});

export function boundedQuery(value: string): string {
  const query = value.trim();
  if (query.length > ragLimits.queryCharacters) throw new Error(`query must not exceed ${ragLimits.queryCharacters} characters`);
  return query;
}

export function boundedLimit(value = 10): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > ragLimits.results) {
    throw new Error(`limit must be an integer from 1 through ${ragLimits.results}`);
  }
  return value;
}

export function validUuid(value: string, name: string): void {
  if (!uuidPattern.test(value)) throw new Error(`${name} must be a UUID`);
}

export function validIdempotencyKey(value: string): void {
  if (!value || value.length > ragLimits.idempotencyKeyCharacters || /[\r\n\0]/u.test(value)) {
    throw new Error(`idempotency_key must contain 1 through ${ragLimits.idempotencyKeyCharacters} safe characters`);
  }
}

export function validVector(vector: readonly number[] | undefined, reportedDimensions: number): vector is readonly number[] {
  return vector !== undefined && Number.isSafeInteger(reportedDimensions) && reportedDimensions > 0 &&
    reportedDimensions <= ragLimits.dimensions && vector.length === reportedDimensions &&
    vector.every(value => Number.isFinite(value)) && vector.some(value => value !== 0);
}

export function safeScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
