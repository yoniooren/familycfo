/**
 * The inbox: drop an exported file into data/inbox/ (INBOX_DIR overrides) and it's recognized by its header row
 * and imported into the right place. Nothing leaves the computer — each kind of file has its own reader.
 *
 *   הר הביטוח export (.xlsx / .csv) → policies on the insurance page
 *   הר הכסף export   (.xlsx / .csv) → alerts on the insights page (inactive savings to check)
 *
 * After a file is handled it moves to inbox/processed/ (or inbox/failed/ with a .txt saying why), and an alert
 * says what was imported. The API server watches the folder while it runs; `npm run inbox` processes it once.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, watch, writeFileSync } from 'fs';
import { basename, extname, join, resolve } from 'path';
import type { DB } from '../db/connection.js';
import { today } from '../analytics/common.js';
import { readTable } from './readTable.js';
import { exportDateOf, importHarHabituach, parseHarHabituach } from './harHabituach.js';
import { importHarHakesef, parseHarHakesef } from './harHakesef.js';
import { isMain } from '../isMain.js';
import { importMislaka, readMislaka } from './mislaka.js';

export const INBOX_DIR = resolve(process.env.INBOX_DIR ?? join('data', 'inbox'));

export interface InboxResult { file: string; ok: boolean; kind?: string; summary: string; locked?: boolean }

/** Files still being written / downloaded, editor lock files, our own folders and notes. */
const ignored = (name: string) => /^[.~]|\.(crdownload|part|partial|tmp|download)$/i.test(name) || /^~\$/.test(name);

function stamp(name: string): string {
  const d = new Date();
  const t = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  return `${t}_${name}`;
}

function note(db: DB, ok: boolean, file: string, summary: string): void {
  db.prepare(`INSERT OR IGNORE INTO alerts (type, severity, dedupe_key, title, message) VALUES (?, ?, ?, ?, ?)`).run(
    ok ? 'inbox_imported' : 'inbox_failed', ok ? 'info' : 'warning', `inbox:${Date.now()}:${file}`,
    ok ? `יובא מתיבת הקבצים: ${file}` : `לא ניתן היה לייבא: ${file}`, summary);
}

/** True when another program holds the file so it can't be moved (Excel keeps an open workbook locked on Windows). */
function locked(path: string): boolean {
  try {
    const fd = openSync(path, 'r+');
    closeSync(fd);
    return false;
  } catch (err) {
    return ['EBUSY', 'EPERM', 'EACCES'].includes((err as NodeJS.ErrnoException).code ?? '');
  }
}

/** Recognize and import one file. Throws with a Hebrew explanation when it can't. */
export async function importFile(db: DB, path: string): Promise<{ kind: string; summary: string }> {
  const asOf = today();
  if (/\.(zip|xml)$/i.test(path)) {
    const { xmls, extras } = await readMislaka(basename(path), readFileSync(path));
    if (!xmls.length) throw new Error('לא נמצאו בקובץ קבצי XML של המסלקה הפנסיונית (ממשק אחיד)');
    const r = importMislaka(db, xmls, extras, asOf);
    if (!r.accounts.length) throw new Error(`זוהה כדוח של המסלקה, אבל לא נמצאו בו מוצרים עם חיסכון (${r.skipped} בלי יתרה)`);
    const active = r.accounts.filter(a => a.status === 'active').length;
    const fmt = (n: number) => `₪${Math.round(n).toLocaleString('he-IL')}`;
    return {
      kind: 'המסלקה הפנסיונית',
      summary: `${r.accounts.length} מוצרים (${active} פעילים, ${r.accounts.length - active} לא פעילים), סה"כ ${fmt(r.total)} נכון ל-${r.asOf}`
        + ` · ${r.created} חדשים — בדף פנסיה וגמל`
        + (r.skipped ? ` · ${r.skipped} פוליסות בלי חיסכון לא יובאו` : '')
        + (r.mismatch ? ` · שימו לב: ב-${r.mismatch} מוצרים סכום הרכיבים לא תאם לסכום המסלולים, נלקח סכום המסלולים — כדאי להשוות ל-PDF` : ''),
    };
  }
  const sheets = await readTable(path);
  for (const sheet of sheets) {
    const policies = parseHarHabituach(sheet);
    if (policies) {
      if (!policies.length) throw new Error('זוהה כקובץ של הר הביטוח, אבל אין בו שורות');
      const r = importHarHabituach(db, policies, exportDateOf(sheet) ?? asOf);
      return { kind: 'הר הביטוח', summary: `${policies.length} שורות: ${r.created} פוליסות חדשות, ${r.updated} עודכנו — בדף ביטוחים` };
    }
    const funds = parseHarHakesef(sheet);
    if (funds) {
      if (!funds.length) throw new Error('זוהה כקובץ של הר הכסף, אבל אין בו שורות');
      const r = importHarHakesef(db, funds);
      return {
        kind: 'הר הכסף',
        summary: `${funds.length} מוצרים: ${r.inactive} לא פעילים, ${r.active} פעילים, ${r.skipped} ביטוחים בלי חיסכון · ${r.newAlerts ? `${r.newAlerts} התראות חדשות במסך התובנות` : 'אין התראות חדשות (כבר יובא)'}`,
      };
    }
  }
  throw new Error('הקובץ לא זוהה — לא נמצאה בו שורת כותרות של הר הביטוח או של הר הכסף');
}

/**
 * Import one file and file it away: processed/ when it was imported, failed/ (+ a .txt with the reason) when not.
 * `name` is the file name shown to the user and kept in the moved file's name.
 */
export async function handleFile(db: DB, dir: string, path: string, name: string): Promise<InboxResult> {
  // open in Excel (Windows locks it): leave it for the next round instead of importing it twice
  if (locked(path)) return { file: name, ok: false, summary: 'הקובץ פתוח בתוכנה אחרת — ייובא אחרי שייסגר', locked: true };
  try {
    const r = await importFile(db, path);
    mkdirSync(join(dir, 'processed'), { recursive: true });
    renameSync(path, join(dir, 'processed', stamp(name)));
    note(db, true, name, `${r.kind}: ${r.summary}`);
    return { file: name, ok: true, kind: r.kind, summary: r.summary };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const failed = join(dir, 'failed');
    mkdirSync(failed, { recursive: true });
    const moved = stamp(name);
    renameSync(path, join(failed, moved));
    writeFileSync(join(failed, `${moved}.txt`), `${reason}\n`, 'utf-8');
    note(db, false, name, reason);
    return { file: name, ok: false, summary: reason };
  }
}

/** Process every file waiting in the inbox. */
export async function processInbox(db: DB, dir = INBOX_DIR): Promise<InboxResult[]> {
  mkdirSync(dir, { recursive: true });
  const results: InboxResult[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (ignored(name) || !statSync(path).isFile() || extname(name).toLowerCase() === '.txt') continue;
    results.push(await handleFile(db, dir, path, name));
  }
  return results;
}

/**
 * Watch the inbox while the server runs. A new file is processed once its size has stopped changing
 * (a browser download or a copy may still be in progress).
 */
export function watchInbox(db: DB, dir = INBOX_DIR, log: (s: string) => void = console.log): () => void {
  mkdirSync(dir, { recursive: true });
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  const sizes = new Map<string, number>();

  const settled = () => {
    let stable = true;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (ignored(name) || !existsSync(p) || !statSync(p).isFile()) continue;
      const size = statSync(p).size;
      if (sizes.get(name) !== size) stable = false;
      sizes.set(name, size);
    }
    return stable;
  };
  const run = async () => {
    if (running) return schedule();
    if (!settled()) return schedule();
    running = true;
    try {
      const results = await processInbox(db, dir);
      for (const r of results) if (!r.locked) log(`inbox: ${r.file} — ${r.ok ? `${r.kind}: ${r.summary}` : `failed: ${r.summary}`}`);
      if (results.some(r => r.locked)) setTimeout(schedule, 10_000); // try again once it's closed
    } catch (err) {
      log(`inbox: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
      sizes.clear();
    }
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { run(); }, 1500); };

  const watcher = watch(dir, (_event, name) => { if (name && !ignored(basename(String(name)))) schedule(); });
  schedule(); // files already waiting
  return () => { clearTimeout(timer); watcher.close(); };
}

// `npm run inbox` — process what's waiting, once; `npm run inbox -- --inspect <file.xlsx>` prints a file's structure
// (part names and XML tags, no values) for diagnosing one that can't be read
if (isMain(import.meta.url) && process.argv[2] === '--inspect') {
  const { readFileSync } = await import('fs');
  const { describeXlsx } = await import('./xlsxFallback.js');
  console.log(await describeXlsx(readFileSync(process.argv[3])));
} else if (isMain(import.meta.url)) {
  const { getDb } = await import('../db/connection.js');
  const results = await processInbox(getDb());
  if (!results.length) console.log(`Nothing in ${INBOX_DIR}`);
  for (const r of results) console.log(`${r.ok ? '✓' : r.locked ? '…' : '✗'} ${r.file} — ${r.ok ? `${r.kind}: ` : ''}${r.summary}`);
}
