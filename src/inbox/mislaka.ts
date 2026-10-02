/**
 * המסלקה הפנסיונית (pension clearing house) report → the pension & long-term savings page.
 *
 * The report comes as a ZIP: one XML per product in the Finance Ministry's uniform format ("ממשק אחיד", root
 * <Mimshak>), plus PDFs and an .xls summary. File names are <request>_<provider id>_<type>_<timestamp>_<n>.xml,
 * type KGM (provident / study funds), PNN (new pension fund), INP / ING (insurance policies).
 *
 * Per account (Mimshak/YeshutYatzran/Mutzarim/Mutzar/HeshbonotOPolisot/HeshbonOPolisa) we read: provider, plan name,
 * account number, join date, balance, fees, investment tracks, expected pension, deposits, employer.
 * Two things the format doesn't settle for us, so they're checked against each other instead of assumed:
 * - balance: the sum of the balance components (PerutYitrot/TOTAL-CHISACHON-MTZBR) and the sum over the investment
 *   tracks (SCHUM-TZVIRA-BAMASLUL). When both exist and differ, the tracks win and the summary says so.
 * - active or not: a deposit in the last 4 months before the report's value date (status codes aren't relied on).
 * Accounts with no savings (pure risk insurance — already on the insurance page via Har HaBituach) are skipped.
 * Nothing here leaves the computer.
 */
import { configure, Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';
import { mkdirSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import type { DB } from '../db/connection.js';
import { importPensionReport } from '../import/pensionReport.js';
import { REPORTS_DIR } from '../server/routes/insurance.js';
import { elements, unescape } from './xlsxFallback.js';

type Xml = string;
const all = (xml: Xml | undefined, tag: string) => (xml ? elements(xml, tag).map(e => e.inner ?? '') : []);
const one = (xml: Xml | undefined, tag: string) => all(xml, tag)[0];
const text = (xml: Xml | undefined, tag: string): string | null => {
  const v = one(xml, tag);
  const t = v == null ? '' : unescape(v.replace(/<[^>]+>/g, '')).trim();
  return t || null;
};
const num = (xml: Xml | undefined, tag: string): number | null => {
  const t = text(xml, tag);
  if (t == null) return null;
  const n = Number(t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
const sumOf = (xml: Xml | undefined, tag: string) => all(xml, tag)
  .map(v => Number(unescape(v).replace(/,/g, '').trim())).filter(Number.isFinite).reduce((a, b) => a + b, 0);

/** YYYYMMDD (the format's dates), YYYY-MM-DD or DD/MM/YYYY → ISO. */
export function isoDate(v: string | null): string | null {
  if (!v) return null;
  let m = v.match(/^(\d{4})(\d{2})(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = v.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}
const month = (v: string | null) => { const m = v?.match(/^(\d{4})(\d{2})/) ?? v?.match(/^(\d{4})-(\d{2})/); return m ? `${m[1]}-${m[2]}` : null; };
const monthsBetween = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));

/** XML bytes → text, by the encoding its declaration names (windows-1255 is common). */
export function decodeXml(bytes: Uint8Array): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200));
  const enc = head.match(/encoding\s*=\s*["']([\w-]+)["']/i)?.[1]?.toLowerCase() ?? 'utf-8';
  try { return new TextDecoder(enc).decode(bytes).replace(/^﻿/, ''); } catch { return new TextDecoder('utf-8').decode(bytes); }
}

export const isMimshak = (xml: string) => /<(?:[\w.-]+:)?Mimshak[\s>]/.test(xml.slice(0, 2000));

export interface MislakaAccount {
  type: 'pension' | 'keren_hishtalmut' | 'kupat_gemel';
  provider: string; name: string; policyNumber: string; employer: string | null;
  balance: number; balanceCheck: 'match' | 'tracks' | 'components' | 'mismatch';
  status: 'active' | 'inactive'; joinDate: string | null; lastDeposit: string | null; valueDate: string | null;
  feeDeposit: number | null; feeBalance: number | null; expectedAnnuity: number | null; idLast4: string | null;
  tracks: { name: string; share: number; balance: number; returns: [null, null, null, null, null, null, null] }[];
  deposits: [string, string | null, number | null, null, null, null, number][];
  fileType: string;
}

/** The accounts with savings in one Mimshak XML. `fileType` is KGM / PNN / INP / ING from the file name, when known. */
export function parseMimshak(xml: string, fileType = ''): { accounts: MislakaAccount[]; skipped: number; reportDate: string | null } {
  const reportDate = isoDate(text(one(xml, 'KoteretKovetz'), 'TAARICH-BITZUA'));
  const accounts: MislakaAccount[] = [];
  let skipped = 0;
  for (const yatzran of all(xml, 'YeshutYatzran')) {
    const provider = text(yatzran, 'SHEM-YATZRAN') ?? 'לא ידוע';
    for (const mutzar of all(yatzran, 'Mutzar')) {
      const netunei = one(mutzar, 'NetuneiMutzar');
      const employer = text(one(netunei, 'YeshutMaasik'), 'SHEM-MAASIK');
      for (const acc of all(one(mutzar, 'HeshbonotOPolisot'), 'HeshbonOPolisa')) {
        const taktziv = one(acc, 'PirteiTaktziv');
        // balances: the latest Yitrot block
        const yitrot = all(one(taktziv, 'BlockItrot'), 'Yitrot')
          .map(y => ({ y, date: isoDate(text(y, 'TAARICH-ERECH-TZVIROT')) }))
          .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))[0];
        const components = yitrot ? all(yitrot.y, 'PerutYitrot').reduce((s, p) => s + (num(p, 'TOTAL-CHISACHON-MTZBR') ?? 0), 0) : 0;
        const trackRows = all(taktziv, 'PerutMasluleiHashkaa').map(t => ({
          name: text(t, 'SHEM-MASLUL-HASHKAA') ?? 'מסלול', balance: num(t, 'SCHUM-TZVIRA-BAMASLUL') ?? 0,
        })).filter(t => t.balance);
        const tracksTotal = trackRows.reduce((s, t) => s + t.balance, 0);
        let balance: number, balanceCheck: MislakaAccount['balanceCheck'];
        if (components && tracksTotal) {
          const ok = Math.abs(components - tracksTotal) <= Math.max(2, tracksTotal * 0.01);
          balance = tracksTotal; balanceCheck = ok ? 'match' : 'mismatch';
        } else if (tracksTotal) { balance = tracksTotal; balanceCheck = 'tracks'; }
        else { balance = components; balanceCheck = 'components'; }
        if (!(balance > 0)) { skipped++; continue; }

        // deposits since the start of the year (pension), else the last deposit block
        const depositRows = [...all(taktziv, 'PerutHafkadotMetchilatShana'), ...all(one(taktziv, 'PirteiHafkadaAchrona'), 'PerutPirteiHafkadaAchrona')];
        const byKey = new Map<string, [string, string | null, number | null, null, null, null, number]>();
        for (const d of depositRows) {
          const valueDate = isoDate(text(d, 'TAARICH-ERECH-HAFKADA')) ?? isoDate(text(d, 'TAARICH-HAFKADA-ACHARON'));
          if (!valueDate) continue;
          const salaryMonth = month(text(d, 'CHODESH-SACHAR'));
          const amount = num(d, 'TOTAL-HAFKADA') ?? sumOf(d, 'SCHUM-HAFKADA-SHESHULAM');
          const key = `${valueDate}|${salaryMonth ?? ''}`;
          const prev = byKey.get(key);
          if (prev) prev[6] += amount;
          else byKey.set(key, [valueDate, salaryMonth, num(d, 'SACHAR-BERAMAT-HAFKADA'), null, null, null, amount]);
        }
        const deposits = [...byKey.values()].filter(d => d[6]).sort((a, b) => a[0].localeCompare(b[0]));
        const lastDeposit = deposits.at(-1)?.[0] ?? null;
        const valueDate = yitrot?.date ?? reportDate;
        const active = !!(lastDeposit && valueDate && monthsBetween(lastDeposit, valueDate) <= 4);

        const name = text(acc, 'SHEM-TOCHNIT') ?? provider;
        const hotzaot = one(one(taktziv, 'PerutHotzaot'), 'HotzaotBafoalLehodeshDivoach');
        const kupa = all(one(one(acc, 'YitraLefiGilPrisha'), 'Kupot'), 'Kupa').map(k => num(k, 'KITZVAT-HODSHIT-TZFUYA')).find(v => v != null && v > 0) ?? null;
        const id = (text(one(acc, 'NetuneiAmitOmevutach'), 'MISPAR-ZIHUY') ?? '').replace(/\D/g, '');
        const type: MislakaAccount['type'] = /השתלמות/.test(name) ? 'keren_hishtalmut'
          : fileType === 'KGM' && !/פנסי/.test(name) ? 'kupat_gemel' : 'pension';
        accounts.push({
          type, provider, name, policyNumber: text(acc, 'MISPAR-POLISA-O-HESHBON') ?? '', employer,
          balance: Math.round(balance * 100) / 100, balanceCheck, status: active ? 'active' : 'inactive',
          joinDate: isoDate(text(acc, 'TAARICH-HITZTARFUT-MUTZAR')) ?? isoDate(text(acc, 'TAARICH-HITZTARFUT-RISHON')),
          lastDeposit, valueDate,
          feeDeposit: num(hotzaot, 'SHEUR-DMEI-NIHUL-HAFKADA'), feeBalance: num(hotzaot, 'SHEUR-DMEI-NIHUL-TZVIRA'),
          expectedAnnuity: kupa, idLast4: id ? id.slice(-4) : null,
          tracks: trackRows.map(t => ({ name: t.name, share: tracksTotal ? Math.round((t.balance / tracksTotal) * 1000) / 10 : 0, balance: t.balance, returns: [null, null, null, null, null, null, null] })),
          deposits, fileType,
        });
      }
    }
  }
  return { accounts, skipped, reportDate };
}

configure({ useWebWorkers: false });

/** The ZIP is locked and no (or a wrong) password was given. The clearing house locks it with the last 4 digits of the card it charged. */
export class ZipPasswordError extends Error {
  constructor(readonly wrong: boolean) {
    super(wrong ? 'הקוד לא נכון. הקוד הוא 4 הספרות האחרונות של כרטיס האשראי שחויב בהזמנת הדוח'
      : 'קובץ ה-ZIP נעול בקוד. העלו אותו דרך כפתור הוספת הקובץ והקלידו את 4 הספרות האחרונות של כרטיס האשראי שחויב בהזמנת הדוח');
  }
}

/**
 * The XMLs of a Mislaka ZIP (or one XML), the other files kept aside. A locked ZIP (ZipCrypto or AES) needs
 * `password`; it's used only to open the file here and isn't stored anywhere.
 */
export async function readMislaka(fileName: string, bytes: Buffer, password?: string):
  Promise<{ xmls: { name: string; xml: string }[]; extras: { name: string; bytes: Uint8Array }[] }> {
  if (/\.xml$/i.test(fileName)) return { xmls: [{ name: fileName, xml: decodeXml(bytes) }], extras: [] };
  const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(bytes)));
  try {
    const entries = (await reader.getEntries()).filter(e => !e.directory);
    if (entries.some(e => e.encrypted) && !password) throw new ZipPasswordError(false);
    const xmls: { name: string; xml: string }[] = [];
    const extras: { name: string; bytes: Uint8Array }[] = [];
    for (const e of entries) {
      if (!/\.(xml|pdf|xls|xlsx)$/i.test(e.filename)) continue;
      let data: Uint8Array;
      try {
        data = await e.getData!(new Uint8ArrayWriter(), e.encrypted ? { password } : {});
      } catch (err) {
        if (/password|encrypted/i.test(String((err as Error).message))) throw new ZipPasswordError(true);
        throw err;
      }
      const name = basename(e.filename);
      if (/\.xml$/i.test(name)) {
        const xml = decodeXml(data);
        if (isMimshak(xml)) { xmls.push({ name, xml }); continue; }
      }
      if (!/\.xml$/i.test(name)) extras.push({ name, bytes: data });
    }
    return { xmls, extras };
  } finally {
    await reader.close();
  }
}

const fileTypeOf = (name: string) => name.match(/_(KGM|PNN|INP|ING|[A-Z]{3})_\d{8,}/)?.[1] ?? '';

/** Import a Mislaka report into assets (one per account with savings) and keep its PDFs under data/reports/. */
export function importMislaka(db: DB, xmls: { name: string; xml: string }[], extras: { name: string; bytes: Uint8Array }[], fallbackDate: string) {
  const accounts: MislakaAccount[] = [];
  let skipped = 0;
  let reportDate: string | null = null;
  for (const f of xmls) {
    const r = parseMimshak(f.xml, fileTypeOf(f.name));
    accounts.push(...r.accounts);
    skipped += r.skipped;
    if (r.reportDate && (!reportDate || r.reportDate > reportDate)) reportDate = r.reportDate;
  }
  const asOf = accounts.map(a => a.valueDate).filter((d): d is string => !!d).sort().at(-1) ?? reportDate ?? fallbackDate;

  let file: string | undefined;
  if (extras.length) {
    const dir = join(REPORTS_DIR, `${asOf}-mislaka`);
    mkdirSync(dir, { recursive: true });
    for (const e of extras) writeFileSync(join(dir, e.name), e.bytes);
    file = `${asOf}-mislaka/${extras.find(e => /\.pdf$/i.test(e.name) && !/_PDF_/.test(e.name))?.name ?? extras[0].name}`;
  }
  const total = accounts.reduce((s, a) => s + a.balance, 0);
  const result = accounts.length ? importPensionReport(db, {
    asOf, member: null, source: 'המסלקה הפנסיונית', file,
    summary: {
      totalSavings: Math.round(total * 100) / 100,
      byProductType: (['pension', 'keren_hishtalmut', 'kupat_gemel'] as const).map(t => ({
        name: { pension: 'פנסיה וביטוח', keren_hishtalmut: 'קרנות השתלמות', kupat_gemel: 'קופות גמל' }[t],
        amount: Math.round(accounts.filter(a => a.type === t).reduce((s, a) => s + a.balance, 0)),
        pct: total ? Math.round((accounts.filter(a => a.type === t).reduce((s, a) => s + a.balance, 0) / total) * 1000) / 10 : 0,
      })).filter(x => x.amount),
      byProvider: [...new Set(accounts.map(a => a.provider))].map(name => {
        const amount = accounts.filter(a => a.provider === name).reduce((sum, a) => sum + a.balance, 0);
        return { name, amount: Math.round(amount), pct: total ? Math.round((amount / total) * 1000) / 10 : 0 };
      }).sort((a, b) => b.amount - a.amount),
    },
    products: accounts.map(a => ({
      type: a.type, name: a.name, provider: a.provider, policyNumber: a.policyNumber || `${a.provider}-${a.name}`, balance: a.balance,
      feeDeposit: a.feeDeposit, feeBalance: a.feeBalance, employer: a.employer, status: a.status, joinDate: a.joinDate,
      lastDeposit: a.lastDeposit, expectedAnnuity: a.expectedAnnuity, tracks: a.tracks, deposits: a.deposits,
    })),
  }) : { assets: 0, created: 0, deposits: 0, policies: 0 };

  const mismatch = accounts.filter(a => a.balanceCheck === 'mismatch').length;
  return { accounts, skipped, asOf, total, mismatch, ...result };
}
