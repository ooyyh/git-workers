/**
 * Minimal in-memory D1 mock for the in-process admin test. Implements just
 * enough of the D1 API (prepare/bind/run/all/first) to exercise the admin
 * CRUD against an in-memory SQLite-ish store backed by node's better-sqlite3
 * if available, else a tiny hand-rolled evaluator.
 *
 * Uses node's built-in SQL via a *very* small subset evaluator: we only need
 * CREATE TABLE, INSERT, SELECT, UPDATE, DELETE for the admin flows.
 */

// Hand-rolled: store rows per table, evaluate the limited SQL the app emits.
class MockD1 {
  private tables = new Map<string, { cols: string[]; rows: Map<string, any> }>();
  private autoinc = new Map<string, number>();

  prepare(sql: string) {
    return new MockStmt(this, sql);
  }
  exec() { /* noop */ }

  // execute helpers used by MockStmt
  _run(sql: string, binds: any[]): any {
    const norm = sql.trim().replace(/\s+/g, " ");
    if (/^CREATE TABLE/i.test(norm)) {
      const m = norm.match(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*)\)/i);
      if (m && !this.tables.has(m[1])) {
        this.tables.set(m[1], { cols: m[2].split(",").map((c) => c.trim().split(/\s+/)[0]).filter(Boolean), rows: new Map() });
      }
      return { meta: {} };
    }
    if (/^CREATE INDEX/i.test(norm)) return { meta: {} };
    if (/^INSERT INTO/i.test(norm)) {
      const m = norm.match(/INSERT INTO (\w+)\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i);
      if (!m) throw new Error("unsupported insert: " + norm);
      const table = m[1];
      const cols = m[2].split(",").map((c) => c.trim());
      const t = this.tables.get(table);
      if (!t) throw new Error("no table " + table);
      let id = binds.length; // id is last bind when AUTOINCREMENT omitted in INSERT
      const idn = (this.autoinc.get(table) ?? 0) + 1;
      this.autoinc.set(table, idn);
      const row: any = {};
      cols.forEach((c, i) => (row[c] = binds[i]));
      row.id = idn;
      row.created_at = row.created_at || new Date().toISOString();
      row.updated_at = row.updated_at || new Date().toISOString();
      t.rows.set(String(idn), row);
      void id;
      return { meta: {} };
    }
    if (/^UPDATE/i.test(norm)) {
      const m = norm.match(/UPDATE (\w+) SET ([\s\S]*?) WHERE (.*)$/i);
      if (!m) throw new Error("unsupported update: " + norm);
      const table = m[1];
      const t = this.tables.get(table);
      if (!t) return { meta: {} };
      const sets = m[2].replace(/updated_at = datetime\('now'\)/i, "updated_at = __NOW__").split(",").map((s) => s.trim());
      const setPairs: [string, any][] = [];
      let bi = 0;
      for (const s of sets) {
        const sm = s.match(/^(\w+)\s*=\s*\?$/);
        if (sm) setPairs.push([sm[1], binds[bi++]]);
        else if (s.includes("__NOW__")) setPairs.push(["updated_at", new Date().toISOString()]);
      }
      // WHERE id = ? (last bind)
      const whereId = binds[bi];
      const r = t.rows.get(String(whereId));
      if (r) for (const [k, v] of setPairs) r[k] = v;
      return { meta: {} };
    }
    if (/^DELETE FROM/i.test(norm)) {
      const m = norm.match(/DELETE FROM (\w+) WHERE (\w+)\s*=\s*\?/i);
      if (!m) throw new Error("unsupported delete: " + norm);
      const t = this.tables.get(m[1]);
      if (!t) return { meta: {} };
      const id = binds[0];
      const r = t.rows.get(String(id));
      if (r) {
        // ON DELETE RESTRICT: if repos reference this storage, reject
        if (m[1] === "storages") {
          const repos = this.tables.get("repos");
          if (repos) {
            for (const row of repos.rows.values()) {
              if (String(row.storage_id) === String(id)) throw new Error("FOREIGN KEY constraint failed: storage in use");
            }
          }
        }
        t.rows.delete(String(id));
      }
      return { meta: {} };
    }
    throw new Error("unsupported SQL: " + norm);
  }

  _query(sql: string, binds: any[]): { results: any[] } {
    const norm = sql.trim().replace(/\s+/g, " ");
    // SELECT ... FROM <table> [JOIN ...] [WHERE ...] [ORDER BY ...]
    const fromM = norm.match(/SELECT\s+([\s\S]*?)\s+FROM\s+(\w+)/i);
    if (!fromM) throw new Error("unsupported select: " + norm);
    const table = fromM[2];
    // handle "r.*, s.name AS storage_name FROM repos r LEFT JOIN storages s ON ..."
    const joinM = norm.match(/LEFT JOIN\s+(\w+)\s+\w+\s+ON\s+\w+\.(\w+)\s*=\s*\w+\.(\w+)/i);
    let whereCol: string | null = null;
    const whereM = norm.match(/WHERE\s+\w+\.?(\w*)\s*=\s*\?/i);
    if (whereM) {
      whereCol = whereM[1] || "name";
    }
    const orderM = norm.match(/ORDER BY\s+([\w.]+)\s*(DESC)?/i);
    const orderCol = orderM ? (orderM[1].split(".").pop() ?? "name") : null;

    const main = this.tables.get(table);
    if (!main) return { results: [] };
    let rows = [...main.rows.values()];
    // join
    const joinedTable = joinM ? this.tables.get(joinM[1]) : null;
    // filter
    if (whereCol && binds.length) {
      const wv = binds[0];
      rows = rows.filter((r) => String(r[whereCol!]) === String(wv));
    }
    // attach joined storage_name
    if (joinedTable) {
      rows = rows.map((r) => {
        const sr = [...joinedTable.rows.values()].find((s) => String(s.id) === String(r.storage_id));
        return { ...r, storage_name: sr ? sr.name : null };
      });
    }
    // select columns
    const selectAll = /\*/.test(fromM[1]);
    // ORDER BY
    if (orderCol) {
      rows.sort((a, b) => String(a[orderCol!]).localeCompare(String(b[orderCol!])));
    }
    return { results: selectAll ? rows : rows.map((r) => ({ ...r })) };
  }

  _first(sql: string, binds: any[]): any {
    const { results } = this._query(sql, binds);
    return results[0] ?? null;
  }
}

class MockStmt {
  private binds: any[] = [];
  private db: MockD1;
  private sql: string;
  constructor(db: MockD1, sql: string) {
    this.db = db;
    this.sql = sql;
  }
  bind(...args: any[]) {
    this.binds.push(...args);
    return this;
  }
  run() {
    return this.db._run(this.sql, this.binds);
  }
  all() {
    return this.db._query(this.sql, this.binds);
  }
  first() {
    return this.db._first(this.sql, this.binds);
  }
}

export function createMockD1(): any {
  return new MockD1();
}
