import { describe, expect, it } from 'vitest';
import { CsvDocumentError, csvLimits, parseServicesCsv } from '../../../packages/services/src/index.ts';

const encode = (value: string) => new TextEncoder().encode(value);
const header = 'external_id,name_en,name_es,category_id,description_en,description_es,eligibility_note_en,eligibility_note_es,phone,languages,accessibility,source_updated_at';
const category = '11111111-1111-4111-8111-111111111111';

describe('service CSV parsing', () => {
  // what_bug_this_catches: quoted commas or doubled quotes split a valid listing into fabricated columns.
  it('parses quoted fields and explicit pipe-separated tags', () => {
    const rows = parseServicesCsv(encode(`${header}\nfood-1,"Meals, delivered","Comidas ""en casa""",${category},desc,descripción,note,nota,555-0100,en|es,wheelchair|hearing,2026-09-10T12:00:00Z`));
    expect(rows[0]?.input).toMatchObject({
      externalId: 'food-1', nameEn: 'Meals, delivered', nameEs: 'Comidas "en casa"',
      languages: ['en', 'es'], accessibility: ['wheelchair', 'hearing'],
    });
  });

  // what_bug_this_catches: duplicate identifiers silently overwrite each other or create duplicate directory rows.
  it('rejects every occurrence of an identifier duplicated within a file', () => {
    const row = `same,Meals,Comidas,${category},,,,,,en,,2026-09-10T12:00:00Z`;
    const rows = parseServicesCsv(encode(`${header}\n${row}\n${row}`));
    expect(rows).toHaveLength(2);
    expect(rows.every(item => item.reasons.includes('external_id is duplicated in this file'))).toBe(true);
    expect(rows.every(item => item.input === undefined)).toBe(true);
  });

  // what_bug_this_catches: imported cells execute when a staff member later opens directory data in a spreadsheet.
  it.each(['=1+1', '+cmd', '-2+3', '@SUM(A1:A2)'])('rejects formula-leading value %s', value => {
    const row = `id,${value},Comidas,${category},,,,,,,,2026-09-10T12:00:00Z`;
    expect(parseServicesCsv(encode(`${header}\n${row}`))[0]?.reasons).toContain('name_en begins with a spreadsheet formula character');
  });

  // what_bug_this_catches: malformed encoding is replaced with U+FFFD and stored as apparently valid content.
  it('fails closed on malformed UTF-8 and oversized documents', () => {
    expect(() => parseServicesCsv(Uint8Array.from([0xc3, 0x28]))).toThrow(CsvDocumentError);
    expect(() => parseServicesCsv(new Uint8Array(csvLimits.maxBytes + 1))).toThrow(/exceeds/u);
  });

  // what_bug_this_catches: a typo in the header drops data or missing required fields are synthesized as empty values.
  it('rejects unknown and missing columns at document scope', () => {
    expect(() => parseServicesCsv(encode('external_id,name_en,unknown\na,b,c'))).toThrow(/Unknown columns/u);
    expect(() => parseServicesCsv(encode('external_id,name_en\na,b'))).toThrow(/Missing required columns/u);
  });

  // what_bug_this_catches: a standard UTF-8 BOM changes the first identifier into an unknown header.
  it('accepts a UTF-8 BOM before the first header', () => {
    const minimal = `\uFEFFexternal_id,name_en,name_es,category_id,source_updated_at\na,Meals,Comidas,${category},2026-09-10T12:00:00Z`;
    expect(parseServicesCsv(encode(minimal))[0]?.input?.externalId).toBe('a');
  });
});
