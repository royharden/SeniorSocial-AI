import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const fontsDirectory = resolve(root, 'apps/web/app/fonts');
const assetName = 'atkinson-hyperlegible-next-variable.woff2';
const asset = readFileSync(resolve(fontsDirectory, assetName));
const globalStyles = readFileSync(resolve(root, 'apps/web/app/globals.css'), 'utf8');
const uiStyles = readFileSync(resolve(root, 'packages/ui/src/styles.css'), 'utf8');
const provenance = readFileSync(resolve(fontsDirectory, 'README.md'), 'utf8');
const license = readFileSync(resolve(fontsDirectory, 'OFL.txt'), 'utf8');
const stylesheetRoots = [resolve(root, 'apps/web/app'), resolve(root, 'packages/ui')];
const allStyles = stylesheetRoots.flatMap((directory) => readdirSync(directory, {
  encoding: 'utf8',
  recursive: true,
}).filter((entry) => entry.endsWith('.css')).map((entry) => readFileSync(resolve(directory, entry), 'utf8'))).join('\n');

const fontStack = "'Atkinson Hyperlegible Next', 'Atkinson Hyperlegible', 'Segoe UI', system-ui, sans-serif";
const knownWoff2Tags = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca',
  'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea',
  'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL',
  'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat',
  'Gloc', 'Feat', 'Sill',
] as const;

function readUIntBase128(buffer: Buffer, start: number): { readonly next: number; readonly value: number } {
  let value = 0;
  let next = start;
  for (let index = 0; index < 5; index += 1) {
    const byte = buffer[next];
    if (byte === undefined || (index === 0 && byte === 0x80)) throw new Error('Invalid WOFF2 UIntBase128');
    if (value > 0x01ff_ffff) throw new Error('WOFF2 UIntBase128 overflow');
    value = value * 128 + (byte & 0x7f);
    next += 1;
    if ((byte & 0x80) === 0) return { next, value };
  }
  throw new Error('WOFF2 UIntBase128 is too long');
}

function decodeWoff2Tables(buffer: Buffer): ReadonlyMap<string, Buffer> {
  if (buffer.subarray(0, 4).toString('ascii') !== 'wOF2') throw new Error('Not a WOFF2 font');
  const tableCount = buffer.readUInt16BE(12);
  const compressedLength = buffer.readUInt32BE(20);
  let offset = 48;
  const records: Array<{ readonly tag: string; readonly transformed: boolean; readonly length: number }> = [];

  for (let index = 0; index < tableCount; index += 1) {
    const flags = buffer[offset];
    if (flags === undefined) throw new Error('Truncated WOFF2 directory');
    offset += 1;
    const tagIndex = flags & 0x3f;
    const tag = tagIndex === 0x3f ? buffer.subarray(offset, offset + 4).toString('ascii') : knownWoff2Tags[tagIndex];
    if (tagIndex === 0x3f) offset += 4;
    if (tag === undefined) throw new Error(`Unknown WOFF2 tag index ${tagIndex}`);
    const original = readUIntBase128(buffer, offset);
    offset = original.next;
    const transformVersion = flags >>> 6;
    const transformed = tag === 'glyf' || tag === 'loca' ? transformVersion === 0 : transformVersion !== 0;
    const transformedSize = transformed ? readUIntBase128(buffer, offset) : original;
    offset = transformedSize.next;
    records.push({ tag, transformed, length: transformedSize.value });
  }

  const tableData = brotliDecompressSync(buffer.subarray(offset, offset + compressedLength));
  const tables = new Map<string, Buffer>();
  let tableOffset = 0;
  for (const record of records) {
    if (!record.transformed) tables.set(record.tag, tableData.subarray(tableOffset, tableOffset + record.length));
    tableOffset += record.length;
  }
  if (tableOffset !== tableData.byteLength) throw new Error('WOFF2 table directory length mismatch');
  return tables;
}

function requiredTable(tables: ReadonlyMap<string, Buffer>, tag: string): Buffer {
  const table = tables.get(tag);
  if (table === undefined) throw new Error(`Missing untransformed ${tag} table`);
  return table;
}

function readUtf16Be(buffer: Buffer): string {
  const swapped = Buffer.alloc(buffer.byteLength);
  for (let offset = 0; offset < buffer.byteLength; offset += 2) {
    swapped[offset] = buffer[offset + 1] ?? 0;
    swapped[offset + 1] = buffer[offset] ?? 0;
  }
  return swapped.toString('utf16le');
}

function embeddedFamilyNames(nameTable: Buffer): ReadonlySet<string> {
  const count = nameTable.readUInt16BE(2);
  const stringsOffset = nameTable.readUInt16BE(4);
  const names = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const record = 6 + index * 12;
    const platform = nameTable.readUInt16BE(record);
    const nameId = nameTable.readUInt16BE(record + 6);
    if (![1, 4, 16].includes(nameId)) continue;
    const length = nameTable.readUInt16BE(record + 8);
    const offset = stringsOffset + nameTable.readUInt16BE(record + 10);
    const encoded = nameTable.subarray(offset, offset + length);
    names.add(platform === 0 || platform === 3 ? readUtf16Be(encoded) : encoded.toString('latin1'));
  }
  return names;
}

function fixed16_16(table: Buffer, offset: number): number {
  return table.readInt32BE(offset) / 65_536;
}

function variationAxis(fvar: Buffer, wantedTag: string) {
  const axesOffset = fvar.readUInt16BE(4);
  const axisCount = fvar.readUInt16BE(8);
  const axisSize = fvar.readUInt16BE(10);
  for (let index = 0; index < axisCount; index += 1) {
    const offset = axesOffset + index * axisSize;
    if (fvar.subarray(offset, offset + 4).toString('ascii') === wantedTag) {
      return {
        default: fixed16_16(fvar, offset + 8),
        maximum: fixed16_16(fvar, offset + 12),
        minimum: fixed16_16(fvar, offset + 4),
      };
    }
  }
  return undefined;
}

function format4Glyph(cmap: Buffer, offset: number, codePoint: number): number {
  const length = cmap.readUInt16BE(offset + 2);
  const segmentCount = cmap.readUInt16BE(offset + 6) / 2;
  const endCodes = offset + 14;
  const startCodes = endCodes + segmentCount * 2 + 2;
  const deltas = startCodes + segmentCount * 2;
  const rangeOffsets = deltas + segmentCount * 2;
  for (let index = 0; index < segmentCount; index += 1) {
    const start = cmap.readUInt16BE(startCodes + index * 2);
    const end = cmap.readUInt16BE(endCodes + index * 2);
    if (codePoint < start || codePoint > end) continue;
    const delta = cmap.readInt16BE(deltas + index * 2);
    const rangeOffset = cmap.readUInt16BE(rangeOffsets + index * 2);
    if (rangeOffset === 0) return (codePoint + delta) & 0xffff;
    const glyphOffset = rangeOffsets + index * 2 + rangeOffset + (codePoint - start) * 2;
    if (glyphOffset + 2 > offset + length) return 0;
    const glyph = cmap.readUInt16BE(glyphOffset);
    return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
  }
  return 0;
}

function format12Glyph(cmap: Buffer, offset: number, codePoint: number): number {
  const groupCount = cmap.readUInt32BE(offset + 12);
  for (let index = 0; index < groupCount; index += 1) {
    const group = offset + 16 + index * 12;
    const start = cmap.readUInt32BE(group);
    const end = cmap.readUInt32BE(group + 4);
    if (codePoint >= start && codePoint <= end) return cmap.readUInt32BE(group + 8) + codePoint - start;
  }
  return 0;
}

function mapsCodePoint(cmap: Buffer, codePoint: number): boolean {
  const subtableCount = cmap.readUInt16BE(2);
  for (let index = 0; index < subtableCount; index += 1) {
    const record = 4 + index * 8;
    const platform = cmap.readUInt16BE(record);
    const encoding = cmap.readUInt16BE(record + 2);
    if (platform !== 0 && !(platform === 3 && (encoding === 1 || encoding === 10))) continue;
    const offset = cmap.readUInt32BE(record + 4);
    const format = cmap.readUInt16BE(offset);
    const glyph = format === 4 ? format4Glyph(cmap, offset, codePoint)
      : format === 12 ? format12Glyph(cmap, offset, codePoint) : 0;
    if (glyph !== 0) return true;
  }
  return false;
}

const tables = decodeWoff2Tables(asset);

describe('WP-007 self-hosted accessible font', () => {
  it('ships the exact pinned upstream WOFF2 and its open-font license', () => {
    // what_bug_this_catches: a placeholder, corrupt download, or silently replaced font passes a filename-only assertion.
    expect(readdirSync(fontsDirectory).sort()).toEqual([
      'OFL.txt',
      'README.md',
      assetName,
    ]);
    expect(asset.byteLength).toBe(48_188);
    expect(asset.subarray(0, 4).toString('ascii')).toBe('wOF2');
    expect(createHash('sha256').update(asset).digest('hex')).toBe(
      'abde1ad5cf78b9ac575ef90d991f2e9101eb0b3b6668bde9a00e2e1e27d99afd',
    );
    expect(license).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(license).toContain('Copyright 2020-2024 The Atkinson Hyperlegible Next Project Authors');
  });

  it('maps the local variable face to every upright UI weight', () => {
    // what_bug_this_catches: token text names Atkinson while the browser has no local face or synthesizes the 600/700 UI weights.
    const faceBlocks = [...globalStyles.matchAll(/@font-face\s*\{([^}]*)\}/gu)].map((match) => match[1]);
    expect(faceBlocks).toHaveLength(1);
    const face = faceBlocks[0] ?? '';
    expect(face).toMatch(/font-family:\s*'Atkinson Hyperlegible Next';/u);
    expect(face).toMatch(/font-style:\s*normal;/u);
    expect(face).toMatch(/font-weight:\s*200 800;/u);
    expect(face).toMatch(/src:\s*url\('\.\/fonts\/atkinson-hyperlegible-next-variable\.woff2'\) format\('woff2'\);/u);
    expect(embeddedFamilyNames(requiredTable(tables, 'name'))).toContain('Atkinson Hyperlegible Next');
    expect(variationAxis(requiredTable(tables, 'fvar'), 'wght')).toEqual({
      default: 400,
      maximum: 800,
      minimum: 200,
    });
    for (const weight of [400, 600, 700]) {
      expect(weight).toBeGreaterThanOrEqual(200);
      expect(weight).toBeLessThanOrEqual(800);
    }
    expect(globalStyles).toContain(`body {\n  font-family: ${fontStack};\n}`);
    expect(globalStyles).toContain(`font: 700 max(1.125rem, var(--ss-body-size)) / 1.3 ${fontStack};`);
    expect(uiStyles).toContain(`font-family: ${fontStack};`);
  });

  it('records pinned cmap evidence for required Spanish characters', () => {
    // what_bug_this_catches: a Latin-basic-only replacement keeps English green while Spanish falls back glyph by glyph.
    const cmap = requiredTable(tables, 'cmap');
    const requiredCodePoints = [0x00a1, 0x00bf, 0x00e1, 0x00e9, 0x00ed, 0x00f1, 0x00f3, 0x00fa, 0x00fc];
    for (const codePoint of requiredCodePoints) expect(mapsCodePoint(cmap, codePoint)).toBe(true);
    expect(provenance).toContain('362 encoded code points');
    for (const codePoint of ['U+00A1', 'U+00BF', 'U+00E1', 'U+00E9', 'U+00ED', 'U+00F1', 'U+00F3', 'U+00FA', 'U+00FC']) {
      expect(provenance).toContain(codePoint);
    }
    expect(provenance).toContain('Expected output: `362 []`');
  });

  it('contains no external font request in any web or UI stylesheet', () => {
    // what_bug_this_catches: a later Google Fonts/CDN import leaks a network dependency despite keeping the local file.
    expect(allStyles).not.toMatch(/fonts\.(?:googleapis|gstatic)\.com/iu);
    expect(allStyles).not.toMatch(/@import\s+(?:url\()?['"]?https?:\/\//iu);
    expect(allStyles).not.toMatch(/src:\s*(?:url\()?['"]?https?:\/\//iu);
  });
});
