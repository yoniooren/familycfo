/**
 * A tolerant .xlsx reader, used when exceljs can't open a file.
 *
 * exceljs looks for the workbook only at the fixed path `xl/workbook.xml` and expects unprefixed XML. Files that
 * aren't written by Excel (e.g. government sites' exports) may put parts elsewhere or use namespace prefixes
 * (`<x:sheet>`), and exceljs then fails with "Cannot read properties of undefined (reading 'sheets')".
 * This reader follows the package's own relationships (`_rels/.rels` → workbook → sheets / shared strings / styles)
 * and parses the XML loosely, prefix or not. It reads values only: strings, numbers, booleans, and dates
 * (numbers whose cell style is a date format) as ISO dates.
 */
import JSZip from 'jszip';
import type { Cell, Sheet } from './readTable.js';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e] ?? m);

/** Elements by local name, any (or no) namespace prefix: [attributes, inner XML (undefined when self-closing)]. */
function elements(xml: string, local: string): { attrs: Record<string, string>; inner: string | undefined }[] {
  const re = new RegExp(`<(?:[\\w.-]+:)?${local}(?=[\\s/>])([^>]*?)(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?${local}>)`, 'g');
  const out: { attrs: Record<string, string>; inner: string | undefined }[] = [];
  for (const m of xml.matchAll(re)) {
    const attrs: Record<string, string> = {};
    for (const a of m[1].matchAll(/([\w.:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      const name = a[1].includes(':') ? a[1].split(':').pop()! : a[1];
      attrs[a[1]] = attrs[name] ??= unescape(a[3] ?? a[4] ?? '');
    }
    out.push({ attrs, inner: m[2] });
  }
  return out;
}
/** All <t> text inside (rich text runs included), phonetic runs (<rPh>) left out. */
const textOf = (xml: string | undefined) =>
  xml == null ? '' : elements(xml.replace(/<(?:[\w.-]+:)?rPh\b[\s\S]*?<\/(?:[\w.-]+:)?rPh>/g, ''), 't').map(t => unescape(t.inner ?? '')).join('');

function resolvePath(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}
const relsPathOf = (part: string) => { const i = part.lastIndexOf('/'); return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`; };

/** Built-in number formats that are dates, and custom ones whose code has d / m / y outside quotes and brackets. */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
const isDateCode = (code: string) => /[dmy]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''));

function excelDate(serial: number, date1904: boolean): string {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  return new Date(epoch + Math.round(serial * 86400000)).toISOString().slice(0, 10);
}

function columnIndex(ref: string | undefined): number | null {
  const m = ref?.match(/^([A-Z]+)/i);
  if (!m) return null;
  return [...m[1].toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
}

export async function readXlsxTolerant(buffer: Buffer): Promise<Sheet[]> {
  const zip = await JSZip.loadAsync(buffer);
  const byLower = new Map(Object.keys(zip.files).map(n => [n.replace(/^\//, '').toLowerCase(), n]));
  const read = async (path: string) => {
    const name = byLower.get(path.replace(/^\//, '').toLowerCase());
    return name ? zip.file(name)!.async('string') : null;
  };
  const rels = async (part: string) => {
    const xml = await read(relsPathOf(part));
    return xml ? elements(xml, 'Relationship').map(r => ({ id: r.attrs.Id, type: r.attrs.Type ?? '', target: resolvePath(part, r.attrs.Target ?? '') })) : [];
  };

  // the workbook: whatever the package says is the office document, else any *workbook*.xml
  const rootRels = await rels('');
  let workbookPath = rootRels.find(r => /\/officeDocument$/.test(r.type))?.target
    ?? [...byLower.keys()].find(n => /(^|\/)workbook[^/]*\.xml$/.test(n));
  if (!workbookPath) throw new Error('בקובץ אין חוברת עבודה (workbook) — ייתכן שהוא לא קובץ Excel תקין');
  workbookPath = workbookPath.replace(/^\//, '');
  const workbookXml = (await read(workbookPath))!;
  const date1904 = elements(workbookXml, 'workbookPr').some(w => /^(1|true)$/i.test(w.attrs.date1904 ?? ''));
  const wbRels = await rels(workbookPath);

  const sharedPath = wbRels.find(r => /\/sharedStrings$/.test(r.type))?.target;
  const sharedXml = sharedPath ? await read(sharedPath) : null;
  const shared = sharedXml ? elements(sharedXml, 'si').map(si => textOf(si.inner)) : [];

  const stylesPath = wbRels.find(r => /\/styles$/.test(r.type))?.target;
  const stylesXml = stylesPath ? await read(stylesPath) : null;
  const dateStyles = new Set<number>();
  if (stylesXml) {
    const custom = new Map(elements(stylesXml, 'numFmt').map(f => [Number(f.attrs.numFmtId), f.attrs.formatCode ?? '']));
    const cellXfs = elements(stylesXml, 'cellXfs')[0]?.inner ?? '';
    elements(cellXfs, 'xf').forEach((xf, i) => {
      const id = Number(xf.attrs.numFmtId ?? 0);
      if (BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && isDateCode(custom.get(id)!))) dateStyles.add(i);
    });
  }

  const sheets: Sheet[] = [];
  for (const s of elements(workbookXml, 'sheet')) {
    const relId = s.attrs['r:id'] ?? s.attrs.id;
    const path = wbRels.find(r => r.id === relId)?.target;
    const xml = path ? await read(path) : null;
    if (!xml) continue;
    const rows: Cell[][] = [];
    let nextRow = 0;
    for (const row of elements(xml, 'row')) {
      const r = row.attrs.r ? Number(row.attrs.r) - 1 : nextRow;
      nextRow = r + 1;
      const cells: Cell[] = [];
      let nextCol = 0;
      for (const c of elements(row.inner ?? '', 'c')) {
        const col = columnIndex(c.attrs.r) ?? nextCol;
        nextCol = col + 1;
        const v = elements(c.inner ?? '', 'v')[0]?.inner;
        const t = c.attrs.t ?? 'n';
        let value: Cell = null;
        if (t === 's') value = v != null ? shared[Number(v)] ?? null : null;
        else if (t === 'inlineStr') value = textOf(elements(c.inner ?? '', 'is')[0]?.inner);
        else if (t === 'str' || t === 'e') value = v != null ? unescape(v) : null;
        else if (t === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
        else if (v != null && v.trim() !== '') {
          const n = Number(v);
          value = Number.isFinite(n) ? (dateStyles.has(Number(c.attrs.s ?? -1)) ? excelDate(n, date1904) : n) : unescape(v);
        }
        if (typeof value === 'string') value = value.trim() || null;
        cells[col] = value;
      }
      rows[r] = Array.from(cells, x => x ?? null);
    }
    sheets.push({ name: s.attrs.name ?? `Sheet${sheets.length + 1}`, rows: Array.from(rows, x => x ?? []) });
  }
  if (!sheets.length) throw new Error('לא נמצאו גיליונות בקובץ');
  return sheets;
}

/** For diagnosing a file that still can't be read: its structure only (part names, root elements), no cell values. */
export async function describeXlsx(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const lines: string[] = [];
  for (const name of Object.keys(zip.files).sort()) {
    const f = zip.files[name];
    if (f.dir) continue;
    const head = name.endsWith('.xml') || name.endsWith('.rels') ? (await f.async('string')).slice(0, 4000) : '';
    const root = head.match(/<([\w.:-]+)[\s>]/g)?.find(t => !t.startsWith('<?'))?.slice(1, -1) ?? '';
    const tags = [...new Set([...head.matchAll(/<([\w.:-]+)[\s/>]/g)].map(m => m[1]))].slice(0, 12).join(' ');
    lines.push(`${name}${root ? `  root=${root}` : ''}${tags ? `  tags: ${tags}` : ''}`);
  }
  return lines.join('\n');
}
