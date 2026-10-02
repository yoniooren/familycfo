/**
 * הר הביטוח (Har HaBituach) export → policies on the insurance page.
 *
 * Columns: תעודת זהות · ענף ראשי · ענף (משני) · סוג מוצר · חברה · תקופת ביטוח · פרטים נוספים · פרמיה בש"ח ·
 * סוג פרמיה · מספר פוליסה · סיווג תכנית. One row per coverage; one policy number can have several rows
 * (several coverages, or several insured people), so a policy here = insurer + policy number + product + insured.
 *
 * Re-importing a newer export updates premium, dates and details, and never touches what the user set by hand
 * (name, type, insured member, the charge-matching text, notes they wrote). The ID number itself isn't stored —
 * only its last 4 digits, to tell the household's people apart.
 */
import type { DB } from '../db/connection.js';
import { findHeader, type Cell, type Sheet } from './readTable.js';

export const HAR_HABITUACH_HEADERS = ['חברה', 'מספר פוליסה', 'פרמיה', 'סוג מוצר'];

export interface PolicyRow {
  idLast4: string | null;
  mainBranch: string | null;
  subBranch: string | null;
  product: string | null;
  insurer: string;
  policyNumber: string | null;
  startDate: string | null;
  endDate: string | null;
  details: string | null;
  premium: number | null;
  premiumFrequency: 'monthly' | 'yearly' | 'one_time';
  frequencyText: string | null;
  planType: string | null;
}

const str = (v: Cell) => (v == null ? null : String(v).trim() || null);

/** "01/02/2024 - 31/01/2025", "1.2.2024", an Excel date (already ISO) … → ISO dates found, in order. */
export function parseDates(v: Cell): string[] {
  if (v == null) return [];
  const s = String(v);
  const out: string[] = [];
  for (const m of s.matchAll(/(\d{4})-(\d{2})-(\d{2})|(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/g)) {
    if (m[1]) { out.push(`${m[1]}-${m[2]}-${m[3]}`); continue; }
    const y = m[6].length === 2 ? `20${m[6]}` : m[6];
    out.push(`${y}-${m[5].padStart(2, '0')}-${m[4].padStart(2, '0')}`);
  }
  return out;
}

export function parseAmount(v: Cell): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/[₪,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function frequencyOf(v: Cell): PolicyRow['premiumFrequency'] {
  const s = String(v ?? '');
  if (/שנת/.test(s)) return 'yearly';
  if (/חד[\s-]*פעמ/.test(s)) return 'one_time';
  return 'monthly';
}

/** Insurance type from the branch / product names. Order matters: a mortgage life policy is `mortgage`. */
export function typeOf(...texts: (string | null)[]): string {
  const t = texts.filter(Boolean).join(' ');
  const rules: [RegExp, string][] = [
    [/משכנת/, 'mortgage'],
    [/סיעוד/, 'nursing'],
    [/מחלות\s*קשות|מחלה\s*קשה/, 'critical_illness'],
    [/אובדן\s*כושר|א\.?כ\.?ע/, 'disability'],
    [/רכב|חובה|מקיף|צד\s*ג/, 'car'],
    [/דירה|מבנה|תכולה|בית/, 'home'],
    [/נסיע|חו["״]?ל/, 'travel'],
    [/בריאות|ניתוח|תרופ|השתל|אמבולטור|רפוא/, 'health'],
    [/חיים|מוות|ריסק/, 'life'],
    [/כלב|חתול|חיית/, 'pet'],
  ];
  return rules.find(([re]) => re.test(t))?.[1] ?? 'other';
}

/** The name that appears on card / bank statements, to match a policy's charges: "הראל חברה לביטוח בע"מ" → "הראל". */
export function insurerKeyword(insurer: string): string {
  if (/איי\s*אי\s*ג|AIG/i.test(insurer)) return 'AIG';
  const words = insurer.replace(/["״]/g, '').split(/\s+/).filter(w => !/^(חברה|לביטוח|ביטוח|בעמ|בע.?מ|ישראל|בע)$/.test(w));
  if (/^ביטוח\s+ישיר/.test(insurer)) return 'ביטוח ישיר';
  return words[0] ?? insurer;
}

/** The export's own date ("התיק הביטוחי, הופק ... בתאריך" | 02/10/2026), above the header row. */
export function exportDateOf(sheet: Sheet): string | null {
  const h = findHeader(sheet.rows, HAR_HABITUACH_HEADERS);
  for (const row of sheet.rows.slice(0, h?.index ?? 10)) {
    if (!row.some(c => typeof c === 'string' && c.includes('הופק'))) continue;
    for (const c of row) { const d = parseDates(c)[0]; if (d) return d; }
  }
  return null;
}

export function parseHarHabituach(sheet: Sheet): PolicyRow[] | null {
  const h = findHeader(sheet.rows, HAR_HABITUACH_HEADERS);
  if (!h) return null;
  const col = (name: string) => h.col(name);
  const at = (r: Cell[], name: string) => { const c = col(name); return c >= 0 ? r[c] ?? null : null; };
  const out: PolicyRow[] = [];
  for (const r of sheet.rows.slice(h.index + 1)) {
    const insurer = str(at(r, 'חברה'));
    if (!insurer) continue;
    const id = str(at(r, 'תעודת זהות'))?.replace(/\D/g, '') ?? '';
    const dates = parseDates(at(r, 'תקופת ביטוח'));
    out.push({
      idLast4: id ? id.slice(-4) : null,
      mainBranch: str(at(r, 'ענף ראשי')),
      subBranch: str(at(r, 'משני')),
      product: str(at(r, 'סוג מוצר')),
      insurer,
      policyNumber: str(at(r, 'מספר פוליסה')),
      startDate: dates[0] ?? null,
      endDate: dates[1] ?? null,
      details: str(at(r, 'פרטים נוספים')),
      premium: parseAmount(at(r, 'פרמיה בש')),
      premiumFrequency: frequencyOf(at(r, 'סוג פרמיה')),
      frequencyText: str(at(r, 'סוג פרמיה')),
      planType: str(at(r, 'סיווג תכנית')),
    });
  }
  return out;
}

const insuredLabel = (last4: string | null) => (last4 ? `ת.ז. …${last4}` : null);
const nameOf = (r: PolicyRow) => r.product || r.subBranch || r.mainBranch || 'פוליסה';

/**
 * A name per row that is unique within its policy (insurer + number + insured). Har HaBituach lists several coverages
 * of one policy under the same product name; each must stay its own row, or one would overwrite the other's premium.
 * The first row keeps the plain product name (so files imported before this stay matched); a later one with the same
 * name gets its details ("· …") or a number. The file's order is stable, so a re-import gives the same names.
 */
export function uniqueNames(rows: PolicyRow[]): string[] {
  const used = new Set<string>();
  const group = (r: PolicyRow) => `${r.insurer}|${r.policyNumber ?? ''}|${r.idLast4 ?? ''}`;
  return rows.map(r => {
    const base = nameOf(r);
    const key = (name: string) => `${group(r)}|${name}`;
    let name = base;
    if (used.has(key(name)) && r.details) name = `${base} · ${r.details}`;
    if (used.has(key(name)) && r.subBranch && r.subBranch !== base) name = `${base} · ${r.subBranch}`;
    for (let n = 2; used.has(key(name)); n++) name = `${base} (${n})`;
    used.add(key(name));
    return name;
  });
}

export function importHarHabituach(db: DB, rows: PolicyRow[], asOf: string): { created: number; updated: number } {
  let created = 0, updated = 0;
  db.transaction(() => {
    const names = uniqueNames(rows);
    for (const [i, r] of rows.entries()) {
      const name = names[i];
      const insured = insuredLabel(r.idLast4);
      const sourceNote = [
        [r.mainBranch, r.subBranch].filter(Boolean).join(' / '),
        r.planType && `סיווג: ${r.planType}`,
        r.frequencyText && !/חודש|שנת|חד/.test(r.frequencyText) ? `סוג פרמיה: ${r.frequencyText}` : null,
        `מקור: הר הביטוח (${asOf})`,
      ].filter(Boolean).join(' · ');
      const found = db.prepare(`SELECT id FROM insurance_policies WHERE insurer = ? AND policy_number IS ? AND name = ?
        AND insured_details IS ?`).get(r.insurer, r.policyNumber, name, insured) as { id: number } | undefined
        // a policy the user renamed: the same insurer + number + insured, if that's the only one
        ?? (r.policyNumber ? (() => {
          const same = db.prepare(`SELECT id FROM insurance_policies WHERE insurer = ? AND policy_number = ? AND insured_details IS ?`)
            .all(r.insurer, r.policyNumber, insured) as { id: number }[];
          return same.length === 1 && rows.filter(x => x.insurer === r.insurer && x.policyNumber === r.policyNumber && x.idLast4 === r.idLast4).length === 1
            ? same[0] : undefined;
        })() : undefined);
      const data = {
        premium: r.premium, premium_frequency: r.premiumFrequency, start_date: r.startDate, end_date: r.endDate,
        coverage: r.details, archived: 0,
      };
      if (found) {
        db.prepare(`UPDATE insurance_policies SET premium = @premium, premium_frequency = @premium_frequency,
          start_date = COALESCE(@start_date, start_date), end_date = COALESCE(@end_date, end_date),
          coverage = COALESCE(@coverage, coverage), archived = @archived, updated_at = CURRENT_TIMESTAMP WHERE id = @id`)
          .run({ ...data, id: found.id });
        updated++;
      } else {
        db.prepare(`INSERT INTO insurance_policies (name, type, insurer, policy_number, insured_details, premium, premium_frequency,
          match_pattern, start_date, end_date, coverage, notes, archived)
          VALUES (@name, @type, @insurer, @policy_number, @insured_details, @premium, @premium_frequency,
          @match_pattern, @start_date, @end_date, @coverage, @notes, @archived)`).run({
          ...data, name, type: typeOf(r.mainBranch, r.subBranch, r.product), insurer: r.insurer, policy_number: r.policyNumber,
          insured_details: insured, match_pattern: insurerKeyword(r.insurer), notes: sourceNote,
        });
        created++;
      }
    }
  })();
  return { created, updated };
}

