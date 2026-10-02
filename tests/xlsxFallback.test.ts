import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { readTable } from '../src/inbox/readTable.js';
import { describeXlsx, readXlsxTolerant } from '../src/inbox/xlsxFallback.js';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PR = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** An .xlsx as some non-Excel generators write it: parts under custom paths and/or `x:`-prefixed XML. */
async function oddXlsx({ prefix = 'x:', workbook = 'xl/workbook.xml' } = {}): Promise<Buffer> {
  const p = prefix;
  const xmlns = p ? `xmlns:${p.slice(0, -1)}="${NS}"` : `xmlns="${NS}"`;
  const dir = workbook.split('/').slice(0, -1).join('/');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
    <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>
    <Override PartName="/${workbook}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="${PR}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="/${workbook}"/></Relationships>`);
  zip.file(workbook, `<?xml version="1.0"?><${p}workbook ${xmlns} xmlns:r="${R}"><${p}sheets><${p}sheet name="נתונים" sheetId="1" r:id="rIdS"/></${p}sheets></${p}workbook>`);
  zip.file(`${dir}/_rels/${workbook.split('/').pop()}.rels`, `<?xml version="1.0"?><Relationships xmlns="${PR}">
    <Relationship Id="rIdS" Type="${R}/worksheet" Target="data/s1.xml"/>
    <Relationship Id="rIdT" Type="${R}/sharedStrings" Target="strings.xml"/>
    <Relationship Id="rIdY" Type="${R}/styles" Target="styles.xml"/></Relationships>`);
  zip.file(`${dir}/strings.xml`, `<?xml version="1.0"?><${p}sst ${xmlns}>
    <${p}si><${p}t>חברה</${p}t></${p}si><${p}si><${p}t>מספר פוליסה</${p}t></${p}si><${p}si><${p}r><${p}t>הראל </${p}t></${p}r><${p}r><${p}t>ביטוח &amp; פיננסים</${p}t></${p}r></${p}si></${p}sst>`);
  zip.file(`${dir}/styles.xml`, `<?xml version="1.0"?><${p}styleSheet ${xmlns}><${p}numFmts count="1"><${p}numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></${p}numFmts>
    <${p}cellXfs count="2"><${p}xf numFmtId="0"/><${p}xf numFmtId="164"/></${p}cellXfs></${p}styleSheet>`);
  zip.file(`${dir}/data/s1.xml`, `<?xml version="1.0"?><${p}worksheet ${xmlns}><${p}sheetData>
    <${p}row r="2"><${p}c r="A2" t="s"><${p}v>0</${p}v></${p}c><${p}c r="C2" t="s"><${p}v>1</${p}v></${p}c><${p}c r="D2" t="inlineStr"><${p}is><${p}t>תאריך</${p}t></${p}is></${p}c></${p}row>
    <${p}row r="3"><${p}c r="A3" t="s"><${p}v>2</${p}v></${p}c><${p}c r="C3" t="str"><${p}v>9001</${p}v></${p}c><${p}c r="D3" s="1"><${p}v>45292</${p}v></${p}c><${p}c r="E3"><${p}v>45.3</${p}v></${p}c></${p}row>
    </${p}sheetData></${p}worksheet>`);
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

const expected = [
  [],
  ['חברה', null, 'מספר פוליסה', 'תאריך'],
  ['הראל ביטוח & פיננסים', null, '9001', '2024-01-01', 45.3],
];

describe('tolerant xlsx reader', () => {
  for (const variant of [{ prefix: 'x:' }, { prefix: '', workbook: 'xl/wb/book.xml' }, { prefix: 'x:', workbook: 'content/workbook.xml' }]) {
    it(`reads a file exceljs can't (${JSON.stringify(variant)})`, async () => {
      const buf = await oddXlsx(variant);
      const dir = mkdtempSync(join(tmpdir(), 'fcfo-x-'));
      writeFileSync(join(dir, 'f.xlsx'), buf);
      // the same failure as the real export: exceljs finds no workbook / sheets
      const wb = new ExcelJS.Workbook();
      const viaExceljs = await wb.xlsx.readFile(join(dir, 'f.xlsx')).then(() => wb.worksheets.length).catch(() => -1);
      expect(viaExceljs).toBeLessThanOrEqual(0);

      const sheets = await readXlsxTolerant(buf);
      expect(sheets[0].name).toBe('נתונים');
      expect(sheets[0].rows).toEqual(expected);
      // and readTable (what the inbox uses) falls back to it
      expect((await readTable(join(dir, 'f.xlsx')))[0].rows).toEqual(expected);
    });
  }

  it('reads a normal Excel file the same way exceljs does', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['חברה', 'פרמיה בש"ח', 'תאריך']);
    ws.addRow(['מגדל', 88, new Date(Date.UTC(2026, 2, 15))]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    expect((await readXlsxTolerant(buf))[0].rows).toEqual([['חברה', 'פרמיה בש"ח', 'תאריך'], ['מגדל', 88, '2026-03-15']]);
  });

  it('describes a file by its structure, without values', async () => {
    const text = await describeXlsx(await oddXlsx({ prefix: 'x:' }));
    expect(text).toContain('xl/workbook.xml  root=x:workbook');
    expect(text).not.toContain('הראל');
    expect(text).not.toContain('9001');
  });

  it('reads an "xlsx" that is really an HTML table', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fcfo-h-'));
    writeFileSync(join(dir, 'h.xlsx'), '<html><body><table><tr><th>שם גוף מוסדי</th><th>סוג המוצר</th></tr><tr><td>קרן &amp; גמל</td><td>קופת גמל - לא פעילה</td></tr></table></body></html>');
    expect((await readTable(join(dir, 'h.xlsx')))[0].rows).toEqual([['שם גוף מוסדי', 'סוג המוצר'], ['קרן & גמל', 'קופת גמל - לא פעילה']]);
  });
});
