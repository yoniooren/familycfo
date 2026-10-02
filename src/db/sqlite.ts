/**
 * A small better-sqlite3-compatible layer over Node's built-in `node:sqlite`.
 *
 * Why: better-sqlite3 ships a native `.node` binary. Windows Smart App Control (and similar application-control
 * policies) block loading such an unsigned binary, so the app couldn't open its database at all. `node:sqlite` is
 * part of Node itself (22.13+ / 23.4+ without a flag), so there is nothing extra to load.
 *
 * Only what this codebase uses is implemented: prepare → all / get / run / iterate / pluck / reader,
 * exec, pragma (statements, no return value), transaction (nestable, via savepoints), close.
 */
import { existsSync } from 'fs';
import { createRequire } from 'module';
import type { DatabaseSync as DatabaseSyncType, StatementSync } from 'node:sqlite';

// node:sqlite prints an ExperimentalWarning on load in some Node versions; it is expected here, so hide that one.
const { DatabaseSync } = (() => {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning?.message;
    if (typeof text === 'string' && text.includes('SQLite')) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
})();

type Params = unknown[];
export interface RunResult { changes: number; lastInsertRowid: number | bigint }

// Rows come back with a null prototype from node:sqlite — copy them into plain objects so they behave like before
// (spreading, equality in tests, JSON).
const plain = (row: unknown) => (row && typeof row === 'object' ? { ...(row as Record<string, unknown>) } : row);

export class Statement<Row = unknown> {
  private plucked = false;
  constructor(private readonly stmt: StatementSync, private readonly bound: Params = []) {}

  /** True when the statement returns rows (SELECT, or anything with a result column). */
  get reader(): boolean {
    return this.stmt.columns().length > 0;
  }

  /** Return the first column's value instead of a row object. */
  pluck(on = true): Statement<any> {
    this.plucked = on;
    return this as Statement<any>;
  }

  bind(...params: Params): Statement<Row> {
    const s = new Statement<Row>(this.stmt, params);
    s.plucked = this.plucked;
    return s;
  }

  private args(params: Params): any[] {
    return (params.length ? params : this.bound) as any[];
  }

  private shape(row: unknown): any {
    if (row === undefined) return undefined;
    if (this.plucked) return Object.values(row as Record<string, unknown>)[0];
    return plain(row);
  }

  all(...params: Params): any[] {
    return this.stmt.all(...this.args(params)).map(r => this.shape(r));
  }

  get(...params: Params): any {
    return this.shape(this.stmt.get(...this.args(params)));
  }

  run(...params: Params): RunResult {
    const r = this.stmt.run(...this.args(params));
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }

  *iterate(...params: Params): IterableIterator<any> {
    for (const row of this.stmt.iterate(...this.args(params))) yield this.shape(row);
  }
}

export interface DatabaseOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
}

export class Database {
  private readonly db: DatabaseSyncType;
  private depth = 0;
  private savepoint = 0;

  constructor(path: string, options: DatabaseOptions = {}) {
    if ((options.fileMustExist || options.readonly) && path !== ':memory:' && !existsSync(path)) {
      throw new Error(`database file not found: ${path}`);
    }
    this.db = new DatabaseSync(path, { readOnly: !!options.readonly });
  }

  prepare<Row = unknown>(sql: string): Statement<Row> {
    const stmt = this.db.prepare(sql);
    // better-sqlite3 ignores object keys the SQL doesn't use; callers rely on passing a whole row object
    stmt.setAllowUnknownNamedParameters(true);
    return new Statement<Row>(stmt);
  }

  exec(sql: string): this {
    this.db.exec(sql);
    return this;
  }

  /** `db.pragma('foreign_keys = ON')` — runs the PRAGMA; returns its rows, if any. */
  pragma(source: string): unknown[] {
    const stmt = this.db.prepare(`PRAGMA ${source}`);
    return stmt.columns().length ? stmt.all().map(plain) : (stmt.run(), []);
  }

  /**
   * Wrap fn in a transaction, like better-sqlite3: returns a function that runs fn inside BEGIN / COMMIT
   * (ROLLBACK on a throw). Called inside another transaction it uses a savepoint, so nesting works.
   */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      const outer = this.depth === 0;
      const name = `sp_${++this.savepoint}`;
      this.db.exec(outer ? 'BEGIN' : `SAVEPOINT ${name}`);
      this.depth++;
      try {
        const result = fn(...args);
        this.depth--;
        this.db.exec(outer ? 'COMMIT' : `RELEASE ${name}`);
        return result;
      } catch (err) {
        this.depth--;
        this.db.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
        throw err;
      }
    };
  }

  close(): void {
    this.db.close();
  }
}

export default Database;
