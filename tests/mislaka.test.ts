import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { testDb } from './helpers.js';

// Invented values, real tag layout (Mimshak / ממשק אחיד), as in the clearing house's files.
const account = (o: { plan: string; number: string; tracks: [string, number][]; components: number[]; deposits?: [string, string, number][];
  join?: string; feeDep?: number; feeBal?: number; annuity?: number }) => `
  <HeshbonOPolisa>
    <MISPAR-POLISA-O-HESHBON>${o.number}</MISPAR-POLISA-O-HESHBON>
    <SHEM-TOCHNIT>${o.plan}</SHEM-TOCHNIT>
    <STATUS-POLISA-O-CHESHBON>1</STATUS-POLISA-O-CHESHBON>
    <TAARICH-HITZTARFUT-MUTZAR>${o.join ?? '20150301'}</TAARICH-HITZTARFUT-MUTZAR>
    <NetuneiAmitOmevutach><KOD-ZIHUY-LAKOACH>1</KOD-ZIHUY-LAKOACH><MISPAR-ZIHUY>012345678</MISPAR-ZIHUY></NetuneiAmitOmevutach>
    <PirteiTaktziv>
      <BlockItrot><Yitrot><TAARICH-ERECH-TZVIROT>20260531</TAARICH-ERECH-TZVIROT>
        ${o.components.map(c => `<PerutYitrot><KOD-SUG-ITRA>1</KOD-SUG-ITRA><TOTAL-CHISACHON-MTZBR>${c}</TOTAL-CHISACHON-MTZBR></PerutYitrot>`).join('')}
      </Yitrot></BlockItrot>
      <PerutHotzaot><HotzaotBafoalLehodeshDivoach><SHEUR-DMEI-NIHUL-HAFKADA>${o.feeDep ?? 0}</SHEUR-DMEI-NIHUL-HAFKADA><SHEUR-DMEI-NIHUL-TZVIRA>${o.feeBal ?? 0}</SHEUR-DMEI-NIHUL-TZVIRA></HotzaotBafoalLehodeshDivoach></PerutHotzaot>
      ${o.tracks.map(([n, b]) => `<PerutMasluleiHashkaa><SHEM-MASLUL-HASHKAA>${n}</SHEM-MASLUL-HASHKAA><SCHUM-TZVIRA-BAMASLUL>${b}</SCHUM-TZVIRA-BAMASLUL></PerutMasluleiHashkaa>`).join('')}
      ${(o.deposits ?? []).map(([d, m, s]) => `<PerutHafkadotMetchilatShana><TAARICH-ERECH-HAFKADA>${d}</TAARICH-ERECH-HAFKADA><CHODESH-SACHAR>${m}</CHODESH-SACHAR><SCHUM-HAFKADA-SHESHULAM>${s}</SCHUM-HAFKADA-SHESHULAM></PerutHafkadotMetchilatShana>`).join('')}
    </PirteiTaktziv>
    ${o.annuity ? `<YitraLefiGilPrisha><Kupot><Kupa><KITZVAT-HODSHIT-TZFUYA>${o.annuity}</KITZVAT-HODSHIT-TZFUYA></Kupa></Kupot></YitraLefiGilPrisha>` : ''}
  </HeshbonOPolisa>`;
const mimshak = (provider: string, employer: string, accounts: string) => `<?xml version="1.0" encoding="windows-1255"?>
<Mimshak><KoteretKovetz><TAARICH-BITZUA>20260604</TAARICH-BITZUA></KoteretKovetz>
<YeshutYatzran><SHEM-YATZRAN>${provider}</SHEM-YATZRAN><Mutzarim><Mutzar>
  <NetuneiMutzar><SUG-MUTZAR>2</SUG-MUTZAR><YeshutMaasik><SHEM-MAASIK>${employer}</SHEM-MAASIK></YeshutMaasik></NetuneiMutzar>
  <HeshbonotOPolisot>${accounts}</HeshbonotOPolisot>
</Mutzar></Mutzarim></YeshutYatzran></Mimshak>`;

/** Hebrew → windows-1255 bytes (letters U+05D0..U+05EA → 0xE0..0xFA; the rest is ASCII here). */
const cp1255 = (s: string) => Buffer.from([...s].map(ch => { const c = ch.codePointAt(0)!; return c >= 0x5d0 && c <= 0x5ea ? c - 0x5d0 + 0xe0 : c; }));

async function report(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('11111111_512237744_PNN_202606041504_1.xml', cp1255(mimshak('מגדל מקפת', 'חברה בעמ', account({
    plan: 'מקפת אישית', number: 'P-100', tracks: [['כללי', 150000], ['מניות', 50000]], components: [120000, 80000], feeDep: 1.5, feeBal: 0.15, annuity: 9500,
    deposits: [['20260410', '202603', 2000], ['20260410', '202603', 1500], ['20260512', '202604', 3500]],
  }))));
  zip.file('11111111_512065202_KGM_202606041504_2.xml', cp1255(mimshak('כלל פנסיה וגמל', 'מעסיק קודם', account({
    plan: 'כלל השתלמות כללי', number: 'H-200', tracks: [['כללי', 42000]], components: [42000], join: '20180101',
    deposits: [['20210105', '202012', 800]],
  }))));
  zip.file('11111111_520024647_ING_202606041504_3.xml', cp1255(mimshak('מנורה', '', account({ plan: 'ריסק', number: 'R-300', tracks: [], components: [] }))));
  zip.file('11111111_202606041504.pdf', '%PDF-1.4 fake');
  zip.file('11111111_202606041504.xls', 'xls');
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

describe('Mislaka report in the inbox', () => {
  it('imports each account with savings into pension & savings, keeps the PDFs, and re-imports idempotently', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fcfo-m-'));
    const reports = mkdtempSync(join(tmpdir(), 'fcfo-r-'));
    process.env.INBOX_DIR = dir;
    process.env.REPORTS_DIR = reports;
    const { processInbox } = await import('../src/inbox/index.js');
    const db = testDb();
    writeFileSync(join(dir, 'mislaka.zip'), await report());

    const [r] = await processInbox(db, dir);
    expect(r).toMatchObject({ ok: true, kind: 'המסלקה הפנסיונית' });
    expect(r.summary).toContain('2 מוצרים (1 פעילים, 1 לא פעילים)');
    expect(r.summary).toContain('1 פוליסות בלי חיסכון');
    expect(r.summary).not.toContain('שימו לב');

    const assets = db.prepare(`SELECT a.*, s.value, s.date FROM assets a JOIN asset_snapshots s ON s.asset_id = a.id ORDER BY a.id`).all() as Record<string, any>[];
    expect(assets).toHaveLength(2);
    expect(assets[0]).toMatchObject({ type: 'pension', provider: 'מגדל מקפת', policy_number: 'P-100', employer: 'חברה בעמ', status: 'active',
      value: 200000, date: '2026-05-31', fee_deposit_pct: 1.5, fee_balance_pct: 0.15, expected_annuity: 9500, join_date: '2015-03-01', owner_member_id: null });
    expect(JSON.parse(assets[0].details).tracks.map((t: any) => [t.name, t.share])).toEqual([['כללי', 75], ['מניות', 25]]);
    expect(assets[1]).toMatchObject({ type: 'keren_hishtalmut', provider: 'כלל פנסיה וגמל', status: 'inactive', value: 42000, liquidity_date: '2024-01-01' });
    expect(db.prepare(`SELECT salary_month, total FROM asset_deposits WHERE asset_id = ? ORDER BY value_date`).all(assets[0].id))
      .toEqual([{ salary_month: '2026-03', total: 3500 }, { salary_month: '2026-04', total: 3500 }]);
    expect(existsSync(join(reports, '2026-05-31-mislaka', '11111111_202606041504.pdf'))).toBe(true);

    // the user sets the owner; a re-import keeps it and adds nothing
    db.prepare(`UPDATE assets SET owner_member_id = 1`).run();
    writeFileSync(join(dir, 'again.zip'), await report());
    const [again] = await processInbox(db, dir);
    expect(again.summary).toContain('0 חדשים');
    expect(db.prepare(`SELECT COUNT(*) FROM assets`).pluck().get()).toBe(2);
    expect(db.prepare(`SELECT COUNT(*) FROM asset_snapshots`).pluck().get()).toBe(2);
    expect(db.prepare(`SELECT COUNT(*) FROM pension_reports`).pluck().get()).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) FROM assets WHERE owner_member_id = 1`).pluck().get()).toBe(2);
    expect(readdirSync(join(dir, 'processed'))).toHaveLength(2);
  });

  it('flags an account whose components and tracks disagree, and uses the tracks', async () => {
    const { parseMimshak } = await import('../src/inbox/mislaka.js');
    const xml = mimshak('הראל', '', account({ plan: 'הראל השתלמות', number: 'X', tracks: [['כללי', 1000]], components: [1000, 1000] }));
    const { accounts } = parseMimshak(xml, 'KGM');
    expect(accounts[0]).toMatchObject({ balance: 1000, balanceCheck: 'mismatch', type: 'keren_hishtalmut' });
  });
});
