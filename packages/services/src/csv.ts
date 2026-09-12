import type { LocalizedServiceInput } from './types.ts';

export const csvLimits = { maxBytes: 1_000_000, maxRows: 5_000, maxColumns: 20 } as const;
export const csvColumns = [
  'external_id', 'name_en', 'name_es', 'category_id', 'description_en', 'description_es',
  'eligibility_note_en', 'eligibility_note_es', 'phone', 'languages', 'accessibility', 'source_updated_at',
] as const;
const required = new Set(['external_id', 'name_en', 'name_es', 'category_id', 'source_updated_at']);
const formula = /^[\t\r ]*[=+@-]/u;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const languageCode = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
const accessibilityCode = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

export class CsvDocumentError extends Error {}
export interface ParsedCsvRow { row: number; externalId: string | null; input?: LocalizedServiceInput; reasons: string[] }

function decode(source: Uint8Array): string {
  if (source.byteLength > csvLimits.maxBytes) throw new CsvDocumentError(`CSV exceeds ${csvLimits.maxBytes} bytes`);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(source); }
  catch { throw new CsvDocumentError('CSV is not valid UTF-8'); }
}

function rowsFrom(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let closedQuote = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') { quoted = false; closedQuote = true; }
      else cell += char;
    } else if (closedQuote) {
      if (char === ',') { row.push(cell); cell = ''; closedQuote = false; }
      else if (char === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; closedQuote = false; }
      else if (!(char === '\r' && text[index + 1] === '\n')) throw new CsvDocumentError('CSV has characters after a closing quote');
    } else if (char === '"') {
      if (cell.length > 0) throw new CsvDocumentError('CSV has a quote inside an unquoted field');
      quoted = true;
    } else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\n') { row.push(cell.replace(/\r$/u, '')); rows.push(row); row = []; cell = ''; }
    else cell += char;
  }
  if (quoted) throw new CsvDocumentError('CSV has an unterminated quoted field');
  if (cell.length > 0 || row.length > 0 || closedQuote) { row.push(cell.replace(/\r$/u, '')); rows.push(row); }
  return rows;
}

function list(value: string): string[] {
  return value.split('|').map(item => item.trim()).filter(Boolean);
}

export function parseServicesCsv(source: Uint8Array): ParsedCsvRow[] {
  const records = rowsFrom(decode(source));
  const header = records.shift();
  if (!header) throw new CsvDocumentError('CSV requires a header row');
  if (header[0]?.startsWith('\uFEFF')) header[0] = header[0].slice(1);
  if (header.length > csvLimits.maxColumns) throw new CsvDocumentError(`CSV exceeds ${csvLimits.maxColumns} columns`);
  if (records.some(record => record.length > csvLimits.maxColumns)) throw new CsvDocumentError(`CSV exceeds ${csvLimits.maxColumns} columns`);
  if (new Set(header).size !== header.length) throw new CsvDocumentError('CSV header contains duplicate columns');
  const unknown = header.filter(column => !(csvColumns as readonly string[]).includes(column));
  if (unknown.length > 0) throw new CsvDocumentError(`Unknown columns: ${unknown.join(', ')}`);
  const missing = [...required].filter(column => !header.includes(column));
  if (missing.length > 0) throw new CsvDocumentError(`Missing required columns: ${missing.join(', ')}`);
  if (records.length > csvLimits.maxRows) throw new CsvDocumentError(`CSV exceeds ${csvLimits.maxRows} data rows`);

  const values = (record: string[]) => Object.fromEntries(header.map((key, index) => [key, record[index] ?? '']));
  const duplicates = new Map<string, number>();
  for (const record of records) {
    const id = values(record).external_id?.trim();
    if (id) duplicates.set(id, (duplicates.get(id) ?? 0) + 1);
  }
  return records.map((record, index) => {
    const rowNumber = index + 2;
    const fields = values(record);
    const externalId = fields.external_id?.trim() || null;
    const reasons: string[] = [];
    if (record.length !== header.length) reasons.push(`expected ${header.length} columns, received ${record.length}`);
    for (const column of required) if (!fields[column]?.trim()) reasons.push(`${column} is required`);
    for (const [column, value] of Object.entries(fields)) if (formula.test(value)) reasons.push(`${column} begins with a spreadsheet formula character`);
    if (externalId && (duplicates.get(externalId) ?? 0) > 1) reasons.push('external_id is duplicated in this file');
    if (fields.category_id && !uuid.test(fields.category_id)) reasons.push('category_id must be a UUID');
    if (list(fields.languages ?? '').some(code => !languageCode.test(code))) reasons.push('languages contains an invalid code');
    if (list(fields.accessibility ?? '').some(code => !accessibilityCode.test(code))) reasons.push('accessibility contains an invalid code');
    const timestamp = fields.source_updated_at ?? '';
    if (timestamp && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(timestamp)
      || Number.isNaN(Date.parse(timestamp)))) {
      reasons.push('source_updated_at must be an RFC 3339 timestamp');
    }
    if (reasons.length > 0) return { row: rowNumber, externalId, reasons };
    const input: LocalizedServiceInput = {
      categoryId: fields.category_id ?? '', nameEn: fields.name_en ?? '', nameEs: fields.name_es ?? '',
      descriptionEn: fields.description_en ?? '', descriptionEs: fields.description_es ?? '',
      eligibilityNoteEn: fields.eligibility_note_en ?? '', eligibilityNoteEs: fields.eligibility_note_es ?? '',
      phone: fields.phone ?? '', languages: list(fields.languages ?? ''), accessibility: list(fields.accessibility ?? ''),
      sourceUpdatedAt: timestamp,
    };
    if (externalId) input.externalId = externalId;
    return {
      row: rowNumber,
      externalId,
      reasons,
      input,
    };
  });
}
