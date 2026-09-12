import type { CanonicalIndividualExport } from './canonical.ts';
import { canonicalJson } from './canonical.ts';

interface ZipEntry { readonly name: string; readonly bytes: Uint8Array }

export function normalizedCsvZip(payload: CanonicalIndividualExport): Uint8Array {
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [{ name: 'manifest.json', bytes: encoder.encode(canonicalJson(payload.manifest)) }];
  for (const table of payload.manifest.includedTables) {
    const rows = payload.tables[table] ?? [];
    const csv = ['ordinal,payload_json', ...rows.map((row, index) => `${index},${csvCell(canonicalJson(row))}`)].join('\r\n') + '\r\n';
    entries.push({ name: `tables/${table}.csv`, bytes: encoder.encode(csv) });
  }
  return makeStoredZip(entries);
}

/** Small deterministic ZIP reader for contract tests and downstream semantic validation. */
export function readStoredZipEntries(bytes: Uint8Array): ReadonlyMap<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + 4 <= bytes.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = new TextDecoder().decode(bytes.slice(nameStart, nameStart + nameLength));
    result.set(name, bytes.slice(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  return result;
}

function makeStoredZip(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.bytes);
    const local = new Uint8Array(30 + name.byteLength + entry.bytes.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(8, 0, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, entry.bytes.byteLength, true);
    localView.setUint32(22, entry.bytes.byteLength, true);
    localView.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    local.set(entry.bytes, 30 + name.byteLength);
    localParts.push(local);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, entry.bytes.byteLength, true);
    centralView.setUint32(24, entry.bytes.byteLength, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centralParts.push(central);
    offset += local.byteLength;
  }
  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralOffset, true);
  return concat([...localParts, ...centralParts, end]);
}

function csvCell(value: string): string { return `"${value.replaceAll('"', '""')}"`; }

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
  return output;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
