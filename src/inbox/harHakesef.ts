/**
 * הר הכסף (Har HaKesef) export → alerts on the insights page.
 *
 * The export lists where the household has money, per institution and product, with contact details — no amounts.
 * Columns: שם גוף מוסדי · סוג המוצר · טלפון · פקס · דוא"ל (מייל) · כתובת משלוח דואר.
 * - an inactive product (…"לא פעיל"…) holds money nobody deposits into → an alert to check its balance / consolidate
 * - active products → one summary alert (their balances come from a pension clearing-house report)
 * - insurance without savings (…"ללא חיסכון"…) holds no money → skipped (Har HaBituach covers it)
 * Alerts are de-duplicated by institution + product, so importing the same export again adds nothing.
 */
import type { DB } from '../db/connection.js';
import { findHeader, type Cell, type Sheet } from './readTable.js';

export const HAR_HAKESEF_HEADERS = ['שם גוף מוסדי', 'סוג המוצר'];

export interface FundRow { institution: string; product: string; phone: string | null; email: string | null; address: string | null }

export function parseHarHakesef(sheet: Sheet): FundRow[] | null {
  const h = findHeader(sheet.rows, HAR_HAKESEF_HEADERS);
  if (!h) return null;
  const at = (r: Cell[], name: string) => { const c = h.col(name); const v = c >= 0 ? r[c] : null; return v == null ? null : String(v).trim() || null; };
  const out: FundRow[] = [];
  for (const r of sheet.rows.slice(h.index + 1)) {
    const institution = at(r, 'שם גוף מוסדי');
    const product = at(r, 'סוג המוצר');
    if (!institution || !product) continue;
    out.push({ institution, product, phone: at(r, 'טלפון'), email: at(r, 'דואל'), address: at(r, 'כתובת') });
  }
  return out;
}

const normalized = (s: string) => s.replace(/\s+/g, ' ').trim();
export const isInactive = (product: string) => /לא\s*פעיל/.test(product);
export const isInsuranceOnly = (product: string) => /ללא\s*חיסכון|ללא\s*חסכון/.test(product);

export function importHarHakesef(db: DB, rows: FundRow[]): { inactive: number; active: number; skipped: number; newAlerts: number } {
  const insert = db.prepare(`INSERT OR IGNORE INTO alerts (type, severity, dedupe_key, title, message, data_json)
    VALUES (@type, @severity, @key, @title, @message, @data)`);
  let newAlerts = 0, inactive = 0, active = 0, skipped = 0;
  const activeList: FundRow[] = [];

  db.transaction(() => {
    for (const r of rows) {
      if (isInsuranceOnly(r.product)) { skipped++; continue; }
      if (!isInactive(r.product)) { active++; activeList.push(r); continue; }
      inactive++;
      const contact = [r.phone && `טלפון ${r.phone}`, r.email && `מייל ${r.email}`].filter(Boolean).join(' · ');
      newAlerts += insert.run({
        type: 'dormant_funds', severity: 'warning',
        key: `har-hakesef:${normalized(r.institution)}|${normalized(r.product)}`,
        title: `${normalized(r.product)} · ${normalized(r.institution)}`,
        message: `מוצר שאין אליו הפקדות — הכסף ממשיך לשלם דמי ניהול. כדאי לברר את היתרה ולשקול לאחד אותו עם מוצר פעיל או למשוך אותו.${contact ? ` ${contact}.` : ''}${r.address ? ` כתובת: ${r.address}.` : ''}`,
        data: JSON.stringify({ source: 'הר הכסף', ...r }),
      }).changes;
    }
    if (activeList.length) {
      const names = activeList.map(r => `${normalized(r.product)} (${normalized(r.institution)})`);
      newAlerts += insert.run({
        type: 'active_funds', severity: 'info',
        key: `har-hakesef:active:${names.slice().sort().join(';')}`,
        title: `${activeList.length} מוצרי חיסכון פעילים בהר הכסף`,
        message: `${names.join(', ')}. היתרות שלהם לא מופיעות בהר הכסף — דוח מהמסלקה הפנסיונית ייבא אותן לדף פנסיה וגמל.`,
        data: JSON.stringify({ source: 'הר הכסף', products: activeList }),
      }).changes;
    }
  })();
  return { inactive, active, skipped, newAlerts };
}
