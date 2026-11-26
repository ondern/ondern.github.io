// In-memory stand-in for a D1 database, backed by Node's built-in SQLite so the Worker's real SQL runs (including RETURNING and
// ON CONFLICT). It implements only what the Worker uses: prepare(sql).bind(...).first() / .run(). Tests and the local dev harness use it.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function makeD1({ failOn } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const d1 = {
    raw: db,
    failOn, // optional RegExp: statements matching it throw, to test D1 outages
    prepare(sql) {
      return {
        bind(...args) {
          const run = () => { if (d1.failOn && d1.failOn.test(sql)) throw new Error('d1 down'); return db.prepare(sql); };
          return {
            first: async () => { const r = run().get(...args); return r === undefined ? null : { ...r }; },
            run: async () => { const r = run().run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
            all: async () => ({ results: run().all(...args).map((r) => ({ ...r })) }),
          };
        },
      };
    },
  };
  return d1;
}
