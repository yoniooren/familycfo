import { mkdtempSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Fastify from 'fastify';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { testDb } from './helpers.js';

describe('POST /api/inbox', () => {
  it('imports an uploaded file right away, files it in processed/, and keeps a safe name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fcfo-up-'));
    process.env.INBOX_DIR = dir;
    const { inboxRoutes, safeUploadName } = await import('../src/server/routes/inbox.js');
    const { insuranceRoutes } = await import('../src/server/routes/insurance.js');
    const db = testDb();
    const app = Fastify();
    insuranceRoutes(app, db); // registers the raw-body parser
    inboxRoutes(app, db);
    await app.ready();

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['שם גוף מוסדי', 'סוג המוצר', 'טלפון']);
    ws.addRow(['קרן לדוגמה בע"מ', 'קופת גמל - לא פעילה', '03-0000000']);
    const body = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await app.inject({ method: 'POST', url: `/api/inbox?name=${encodeURIComponent('..\\..\\hc.xlsx')}`,
      headers: { 'content-type': 'application/octet-stream' }, payload: body });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, kind: 'הר הכסף', file: 'hc.xlsx' });
    expect(readdirSync(join(dir, 'processed'))[0]).toMatch(/_hc\.xlsx$/);
    expect(readdirSync(dir).filter(f => f.startsWith('.upload'))).toEqual([]);

    const bad = await app.inject({ method: 'POST', url: '/api/inbox?name=x.docx', headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('x') });
    expect(bad.json()).toMatchObject({ ok: false });
    expect(safeUploadName('a/b\\c:d?.xlsx')).toBe('c_d_.xlsx');
  });
});
