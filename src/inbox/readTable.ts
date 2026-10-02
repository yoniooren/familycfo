/**
 * Read a spreadsheet the user dropped into the inbox (.xlsx or .csv) as plain rows of cells, and find a header row.
 * Cells are strings, numbers, or ISO dates (YYYY-MM-DD) for date cells. Hebrew CSVs from Israeli sites are often
 * windows-1255, so a CSV that isn't valid UTF-8 is decoded as that.
 */
import { readFileSync } from 'fs';
import { extname } from 'path';
import ExcelJS from 'exceljs';

export type Cell = string | number | null;
export interface Sheet { name: string; rows: Cell[][] }

const iso = (d: Date) => d.toISOString().slice(0, 10);

function cellValue(v: ExcelJS.CellValue): Cell {
  if (v == null) return null;
  if (v instanceof Date) return iso(v);
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map(r => r.text).join('').trim() || null;
    if ('result' in v) return cellValue(v.result as ExcelJS.CellValue); // formula
    if ('text' in v) return String(v.text).trim() || null; // hyperlink
  }
  return String(v).trim() || null;
}

async function readXlsx(path: string): Promise<Sheet[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  return wb.worksheets.map(ws => {
    const rows: Cell[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      const cells: Cell[] = [];
      for (let c = 1; c <= ws.columnCount; c++) cells.push(cellValue(row.getCell(c).value));
      rows[n - 1] = cells;
    });
    return { name: ws.name, rows: Array.from(rows, r => r ?? []) };
  });
}

/** Minimal RFC 4180 CSV (quotes, doubled quotes, newlines inside quotes); `,` or `;` or tab, whichever the first line uses. */
export function parseCsv(text: string): Cell[][] {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const sep = [',', ';', '\t'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows: Cell[][] = [];
  let row: Cell[] = [], field = '', quoted = false;
  const push = () => { const t = field.trim(); row.push(t === '' ? null : t); field = ''; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) push();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      push(); rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { push(); rows.push(row); }
  return rows;
}

function decode(buf: Buffer): string {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf).replace(/^﻿/, '');
  return utf8.includes('�') ? new TextDecoder('windows-1255').decode(buf) : utf8;
}

export async function readTable(path: string): Promise<Sheet[]> {
  const ext = extname(path).toLowerCase();
  if (ext === '.xlsx') return readXlsx(path);
  if (ext === '.csv') return [{ name: 'csv', rows: parseCsv(decode(readFileSync(path))) }];
  if (ext === '.xls') throw new Error('קובץ ‎.xls הישן לא נתמך — פתחו אותו ב-Excel ושמרו בשם כ-‎.xlsx');
  throw new Error(`סוג קובץ שלא נתמך: ${ext || '(ללא סיומת)'} — אפשר ‎.xlsx או ‎.csv`);
}

/** Header text compared loosely: no quotes / geresh variants, single spaces. */
export const normHeader = (v: Cell) => String(v ?? '').replace(/["'״׳`]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Find the first row (in the first 30) whose cells include every required header (each matched by `includes`).
 * Returns the row index and a column lookup by required header.
 */
export function findHeader(rows: Cell[][], required: string[]): { index: number; col: (name: string) => number } | null {
  const want = required.map(normHeader);
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const cells = (rows[i] ?? []).map(normHeader);
    const cols = want.map(w => cells.findIndex(c => c.includes(w)));
    if (cols.every(c => c >= 0)) {
      const all = cells;
      return { index: i, col: (name: string) => all.findIndex(c => c.includes(normHeader(name))) };
    }
  }
  return null;
}
