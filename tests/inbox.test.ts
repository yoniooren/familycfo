import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { processInbox, watchInbox } from '../src/inbox/index.js';
import { frequencyOf, insurerKeyword, parseDates, typeOf } from '../src/inbox/harHabituach.js';
import { parseCsv } from '../src/inbox/readTable.js';
import { testDb } from './helpers.js';

// Invented rows in the exact column layout of the two exports.
const HABITUACH_HEADER = ['תעודת זהות', 'ענף ראשי', 'ענף (משני)', 'סוג מוצר', 'חברה', 'תקופת ביטוח', 'פרטים נוספים',
  'פרמיה בש"ח', 'סוג פרמיה', 'מספר פוליסה', 'סיווג תכנית'];
const HABITUACH_ROWS = [
  ['012345678', 'ביטוח בריאות', 'בריאות', 'ניתוחים בישראל', 'הראל חברה לביטוח בע"מ', '01/01/2024 - 31/12/2026', 'השלמה לשב"ן', 45.3, 'חודשית', '9001', 'פרט'],
  ['012345678', 'ביטוח בריאות', 'בריאות', 'תרופות שלא בסל', 'הראל חברה לביטוח בע"מ', '01/01/2024 - 31/12/2026', null, 12.1, 'חודשית', '9001', 'פרט'],
  ['087654321', 'ביטוח כללי', 'רכב', 'רכב מקיף', 'ביטוח ישיר - אי.די.איי. חברה לביטוח בע"מ', '15/03/2026 - 14/03/2027', 'רכב פרטי', 3200, 'שנתית', 'R-77', 'פרט'],
  ['087654321', 'ביטוח חיים', 'ריסק', 'ריסק למשכנתא', 'מגדל חברה לביטוח בע"מ', '01/06/2020 - 01/06/2045', null, 88, 'חודשית', 'M-1', 'פרט'],
];
const KESEF_HEADER = ['שם גוף מוסדי', 'סוג המוצר', 'טלפון', 'פקס', "דוא''ל (מייל)", 'כתובת משלוח דואר'];
const KESEF_ROWS = [
  ['קרן לדוגמה פנסיה וגמל בע"מ', 'קרן השתלמות - לא פעילה', '03-0000000', '03-0000001', 'info@example.co.il', 'רחוב הדוגמה 1 תל אביב'],
  ['קרן אחרת גמל בע"מ', 'קרן פנסיה - פעילה', '03-0000002', null, 'x@example.co.il', null],
  ['ביטוח לדוגמה בע"מ', 'ביטוח למקרה מוות (ללא חיסכון) ', '03-0000003', null, null, null],
];

async function xlsx(path: string, header: unknown[], rows: unknown[][], { titleRows = 0 } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1', { views: [{ rightToLeft: true }] });
  // the real Har HaBituach layout: a blank row, the title with the export date, a blank row, the header,
  // then the rows in sections ("תחום - …" rows with nothing else)
  if (titleRows) {
    ws.addRow([]);
    ws.addRow([null, "התיק הביטוחי, הופק מאתר 'הר הביטוח' של משרד האוצר, בתאריך", null, null, null, '28/09/2026']);
    ws.addRow([]);
  }
  ws.addRow(header);
  if (titleRows) ws.addRow([null, 'תחום - כללי']);
  for (const r of rows) ws.addRow(r);
  if (titleRows) ws.addRow([null, 'תחום - חיים ואבדן כושר עבודה']);
  await wb.xlsx.writeFile(path);
}
const inbox = () => mkdtempSync(join(tmpdir(), 'fcfo-inbox-'));

describe('Har HaBituach helpers', () => {
  it('parses periods, frequencies, types and the statement keyword', () => {
    expect(parseDates('01/01/2024 - 31/12/2026')).toEqual(['2024-01-01', '2026-12-31']);
    expect(parseDates('1.6.20')).toEqual(['2020-06-01']);
    expect(frequencyOf('שנתית')).toBe('yearly');
    expect(frequencyOf('חד פעמית')).toBe('one_time');
    expect(frequencyOf('חודשית')).toBe('monthly');
    expect(typeOf('ביטוח חיים', 'ריסק', 'ריסק למשכנתא')).toBe('mortgage');
    expect(typeOf('ביטוח כללי', 'רכב', 'רכב מקיף')).toBe('car');
    expect(typeOf('ביטוח בריאות', 'בריאות', 'ניתוחים')).toBe('health');
    expect(typeOf('ביטוח חיים', 'ריסק', 'ריסק')).toBe('life');
    expect(insurerKeyword('הראל חברה לביטוח בע"מ')).toBe('הראל');
    expect(insurerKeyword('ביטוח ישיר - אי.די.איי. חברה לביטוח בע"מ')).toBe('ביטוח ישיר');
    expect(insurerKeyword('איי אי ג\'י ישראל חברה לביטוח')).toBe('AIG');
  });
});

describe('Har HaBituach: several coverages under one product name', () => {
  it('keeps each row as its own policy with its own premium, and a re-import matches them again', async () => {
    const db = testDb();
    const dir = inbox();
    const rows = [
      ['012345678', 'ביטוח בריאות', 'בריאות', 'בריאות', 'הראל חברה לביטוח בע"מ', '01/01/2024 - 31/12/2026', 'ניתוחים', 40, 'חודשית', '9001', 'פרט'],
      ['012345678', 'ביטוח בריאות', 'בריאות', 'בריאות', 'הראל חברה לביטוח בע"מ', '01/01/2024 - 31/12/2026', 'תרופות', 15, 'חודשית', '9001', 'פרט'],
      ['012345678', 'ביטוח בריאות', 'בריאות', 'בריאות', 'הראל חברה לביטוח בע"מ', '01/01/2024 - 31/12/2026', 'תרופות', 7, 'חודשית', '9001', 'פרט'],
      ['087654321', 'ביטוח בריאות', 'בריאות', 'בריאות', 'הראל חברה לביטוח בע"מ', '01/01/2024 - 31/12/2026', 'ניתוחים', 38, 'חודשית', '9001', 'פרט'],
    ];
    await xlsx(join(dir, 'a.xlsx'), HABITUACH_HEADER, rows);
    const [r] = await processInbox(db, dir);
    expect(r.summary).toContain('4 פוליסות חדשות, 0 עודכנו');
    expect(db.prepare(`SELECT name, insured_details, premium FROM insurance_policies ORDER BY id`).all()).toEqual([
      { name: 'בריאות', insured_details: 'ת.ז. …5678', premium: 40 },
      { name: 'בריאות · תרופות', insured_details: 'ת.ז. …5678', premium: 15 },
      { name: 'בריאות (2)', insured_details: 'ת.ז. …5678', premium: 7 },
      { name: 'בריאות', insured_details: 'ת.ז. …4321', premium: 38 },
    ]);
    await xlsx(join(dir, 'b.xlsx'), HABITUACH_HEADER, rows);
    const [again] = await processInbox(db, dir);
    expect(again.summary).toContain('0 פוליסות חדשות, 4 עודכנו');
  });
});

describe('inbox', () => {
  it('imports a Har HaBituach export into policies, and a newer one updates them without touching user edits', async () => {
    const db = testDb();
    const dir = inbox();
    await xlsx(join(dir, 'har-habituach.xlsx'), HABITUACH_HEADER, HABITUACH_ROWS, { titleRows: 2 });
    const [r] = await processInbox(db, dir);
    expect(r).toMatchObject({ ok: true, kind: 'הר הביטוח' });

    const policies = db.prepare(`SELECT * FROM insurance_policies ORDER BY id`).all() as Record<string, any>[];
    expect(policies).toHaveLength(4);
    expect(policies[0]).toMatchObject({
      name: 'ניתוחים בישראל', type: 'health', insurer: 'הראל חברה לביטוח בע"מ', policy_number: '9001',
      insured_details: 'ת.ז. …5678', premium: 45.3, premium_frequency: 'monthly', match_pattern: 'הראל',
      start_date: '2024-01-01', end_date: '2026-12-31', coverage: 'השלמה לשב"ן',
    });
    expect(policies[2]).toMatchObject({ type: 'car', premium: 3200, premium_frequency: 'yearly', match_pattern: 'ביטוח ישיר' });
    expect(policies[3]).toMatchObject({ type: 'mortgage' });
    expect(policies[0].notes).toContain('הר הביטוח (2026-09-28)'); // the export's own date
    // the full ID number is never stored
    expect(JSON.stringify(policies)).not.toContain('012345678');

    // the user renames the car policy, sets its owner and the statement text
    db.prepare(`UPDATE insurance_policies SET name = 'ביטוח הרכב', insured_member_id = 1, match_pattern = 'ביטוח ישיר רכב' WHERE policy_number = 'R-77'`).run();

    const newer = HABITUACH_ROWS.map(r => [...r]);
    newer[2][7] = 3500;
    newer[2][5] = '15/03/2027 - 14/03/2028';
    await xlsx(join(dir, 'har-habituach-2027.xlsx'), HABITUACH_HEADER, newer);
    const [r2] = await processInbox(db, dir);
    expect(r2.ok).toBe(true);
    expect(db.prepare(`SELECT COUNT(*) FROM insurance_policies`).pluck().get()).toBe(4);
    expect(db.prepare(`SELECT name, insured_member_id, match_pattern, premium, end_date FROM insurance_policies WHERE policy_number = 'R-77'`).get())
      .toEqual({ name: 'ביטוח הרכב', insured_member_id: 1, match_pattern: 'ביטוח ישיר רכב', premium: 3500, end_date: '2028-03-14' });

    expect(readdirSync(join(dir, 'processed'))).toHaveLength(2);
  });

  it('turns a Har HaKesef export into alerts: inactive savings to check, one summary of active ones', async () => {
    const db = testDb();
    const dir = inbox();
    await xlsx(join(dir, 'hc-result-data.xlsx'), KESEF_HEADER, KESEF_ROWS);
    const [r] = await processInbox(db, dir);
    expect(r).toMatchObject({ ok: true, kind: 'הר הכסף' });
    const alerts = db.prepare(`SELECT type, severity, title, message FROM alerts WHERE type IN ('dormant_funds','active_funds') ORDER BY id`).all() as Record<string, string>[];
    expect(alerts.map(a => a.type)).toEqual(['dormant_funds', 'active_funds']);
    expect(alerts[0].title).toBe('קרן השתלמות - לא פעילה · קרן לדוגמה פנסיה וגמל בע"מ');
    expect(alerts[0].message).toContain('03-0000000');
    expect(alerts[0].message).toContain('info@example.co.il');

    // the same export again adds nothing
    await xlsx(join(dir, 'again.xlsx'), KESEF_HEADER, KESEF_ROWS);
    const [again] = await processInbox(db, dir);
    expect(again.summary).toContain('אין התראות חדשות');
    expect(db.prepare(`SELECT COUNT(*) FROM alerts WHERE type IN ('dormant_funds','active_funds')`).pluck().get()).toBe(2);
  });

  it('reads a windows-1255 CSV', async () => {
    const db = testDb();
    const dir = inbox();
    const csv = [KESEF_HEADER, ...KESEF_ROWS].map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    // encode as windows-1255 (Hebrew letters U+05D0..U+05EA → 0xE0..0xFA)
    const bytes = Buffer.from([...csv].map(ch => {
      const cp = ch.codePointAt(0)!;
      return cp >= 0x5d0 && cp <= 0x5ea ? cp - 0x5d0 + 0xe0 : cp;
    }));
    writeFileSync(join(dir, 'hk.csv'), bytes);
    const [r] = await processInbox(db, dir);
    expect(r).toMatchObject({ ok: true, kind: 'הר הכסף' });
    expect(parseCsv('a,"b,""c"""\r\n1,2')).toEqual([['a', 'b,"c"'], ['1', '2']]);
  });

  it('moves an unrecognized or unsupported file to failed/ with the reason, and ignores downloads in progress', async () => {
    const db = testDb();
    const dir = inbox();
    await xlsx(join(dir, 'other.xlsx'), ['עמודה', 'אחרת'], [['1', '2']]);
    writeFileSync(join(dir, 'report.pdf'), 'x');
    writeFileSync(join(dir, 'file.xlsx.crdownload'), 'x');
    const results = await processInbox(db, dir);
    expect(results.map(r => r.ok)).toEqual([false, false]);
    const failed = readdirSync(join(dir, 'failed'));
    expect(failed.filter(f => f.endsWith('.txt'))).toHaveLength(2);
    expect(readFileSync(join(dir, 'failed', failed.find(f => f.includes('other') && f.endsWith('.txt'))!), 'utf-8')).toContain('לא זוהה');
    expect(existsSync(join(dir, 'file.xlsx.crdownload'))).toBe(true);
    expect(db.prepare(`SELECT COUNT(*) FROM alerts WHERE type = 'inbox_failed'`).pluck().get()).toBe(2);
  });

  it('watches the folder and imports a file dropped while it runs', async () => {
    const db = testDb();
    const dir = inbox();
    const stop = watchInbox(db, dir, () => undefined);
    try {
      await xlsx(join(dir, 'dropped.xlsx'), KESEF_HEADER, KESEF_ROWS);
      for (let i = 0; i < 40 && !existsSync(join(dir, 'processed')); i++) await new Promise(r => setTimeout(r, 250));
      expect(readdirSync(join(dir, 'processed'))).toHaveLength(1);
    } finally {
      stop();
    }
  }, 15000);
});
