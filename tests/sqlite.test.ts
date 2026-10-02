import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { Database } from '../src/db/sqlite.js';

const fresh = () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)`);
  return db;
};
const count = (db: Database) => db.prepare(`SELECT COUNT(*) FROM t`).pluck().get();

describe('sqlite compatibility layer', () => {
  it('runs, reads and plucks like better-sqlite3', () => {
    const db = fresh();
    const r = db.prepare(`INSERT INTO t (name) VALUES (@name)`).run({ name: 'a', unused: 1 });
    expect(r).toEqual({ changes: 1, lastInsertRowid: 1 });
    expect(db.prepare(`SELECT * FROM t WHERE id = ?`).get(1)).toEqual({ id: 1, name: 'a' });
    expect(db.prepare(`SELECT * FROM t WHERE id = ?`).get(99)).toBeUndefined();
    expect(db.prepare(`SELECT name FROM t`).pluck().all()).toEqual(['a']);
    expect([...db.prepare(`SELECT id FROM t`).pluck().iterate()]).toEqual([1]);
    expect(db.prepare(`SELECT 1`).reader).toBe(true);
    expect(db.prepare(`DELETE FROM t`).reader).toBe(false);
  });

  it('commits a transaction and rolls it back on a throw', () => {
    const db = fresh();
    const insert = db.transaction((n: string) => db.prepare(`INSERT INTO t (name) VALUES (?)`).run(n).changes);
    expect(insert('a')).toBe(1);
    expect(() => db.transaction(() => { db.prepare(`INSERT INTO t (name) VALUES ('b')`).run(); throw new Error('x'); })()).toThrow('x');
    expect(count(db)).toBe(1);
  });

  it('nests transactions with savepoints', () => {
    const db = fresh();
    db.transaction(() => {
      db.prepare(`INSERT INTO t (name) VALUES ('outer')`).run();
      expect(() => db.transaction(() => { db.prepare(`INSERT INTO t (name) VALUES ('inner')`).run(); throw new Error('inner'); })()).toThrow();
      db.transaction(() => db.prepare(`INSERT INTO t (name) VALUES ('inner2')`).run())();
    })();
    expect(db.prepare(`SELECT name FROM t ORDER BY id`).pluck().all()).toEqual(['outer', 'inner2']);
  });

  it('opens read-only and refuses writes; fileMustExist refuses a missing file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'fcfo-')), 'x.db');
    const rw = new Database(path);
    rw.exec(`CREATE TABLE t (id INTEGER)`);
    rw.close();
    const ro = new Database(path, { readonly: true });
    expect(() => ro.exec(`INSERT INTO t VALUES (1)`)).toThrow();
    expect(() => new Database(join(tmpdir(), 'does-not-exist.db'), { fileMustExist: true })).toThrow();
  });

  it('runs pragmas', () => {
    const db = fresh();
    db.pragma('foreign_keys = ON');
    expect(db.pragma('foreign_keys')).toEqual([{ foreign_keys: 1 }]);
  });
});
