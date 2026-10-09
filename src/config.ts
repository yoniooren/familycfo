import { existsSync, readFileSync } from 'fs';
import { CompanyTypes, SCRAPERS } from 'israeli-bank-scrapers';
import type { Config } from './scraper.js';

/** The bank logins file (git-ignored) — read on demand by whoever scrapes. `ACCOUNTS_FILE` overrides the path. */
export const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || 'accounts.json';

/** Names people write for a company → its israeli-bank-scrapers id. */
const ALIASES: Record<string, string> = {
  cal: 'visaCal', visacal: 'visaCal', visa: 'visaCal', 'visa-cal': 'visaCal', 'כאל': 'visaCal',
  poalim: 'hapoalim', 'פועלים': 'hapoalim', 'הפועלים': 'hapoalim', leumicard: 'max', 'מקס': 'max', 'ישראכרט': 'isracard',
  'דיסקונט': 'discount', 'לאומי': 'leumi', 'מזרחי': 'mizrahi', 'אמקס': 'amex', americanexpress: 'amex',
};

/** What's wrong with the accounts file, in Hebrew, without ever printing a credential value. */
export function validateConfig(config: Config): string[] {
  const problems: string[] = [];
  if (!config || !Array.isArray(config.accounts)) return ['בקובץ חסרה הרשימה "accounts"'];
  const ids = Object.keys(CompanyTypes);
  config.accounts.forEach((a, i) => {
    const where = `רשומה ${i + 1}`;
    const id = (a as { companyId?: unknown }).companyId;
    if (typeof id !== 'string' || !id) { problems.push(`${where}: חסר "companyId"`); return; }
    if (!ids.includes(id)) {
      const guess = ids.find(x => x.toLowerCase() === id.toLowerCase()) ?? ALIASES[id.toLowerCase().replace(/\s+/g, '')];
      problems.push(`${where}: "${id}" הוא לא שם חברה מוכר${guess ? ` — התכוונת ל-"${guess}"?` : ''} (אפשר: ${ids.join(', ')})`);
      return;
    }
    const needed = (SCRAPERS as Record<string, { loginFields: string[] }>)[id]?.loginFields ?? [];
    const creds = a.credentials ?? {};
    const missing = needed.filter(f => typeof creds[f] !== 'string' || !creds[f]);
    if (missing.length) problems.push(`${where} (${id}): חסרים השדות ${missing.map(f => `"${f}"`).join(', ')} בתוך "credentials"`);
  });
  return problems;
}

export function loadConfig(): Config {
  if (!existsSync(ACCOUNTS_FILE)) {
    throw new Error(`${ACCOUNTS_FILE} not found — copy accounts.example.json to ${ACCOUNTS_FILE} and fill in your bank logins`);
  }
  let config: Config;
  try {
    config = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf-8'));
  } catch (err) {
    throw new Error(`${ACCOUNTS_FILE} הוא לא JSON תקין: ${(err as Error).message.replace(/"[^"]{6,}"/g, '"…"')}`);
  }
  const problems = validateConfig(config);
  if (problems.length) throw new Error(`יש בעיה ב-${ACCOUNTS_FILE}:\n- ${problems.join('\n- ')}`);
  return config;
}
