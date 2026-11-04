import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
export class Store {
  db: DatabaseSync;
  constructor(public root = path.resolve(process.env.AXYS_DATA_DIR || "var")) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(root, "axys.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.db.exec(
      readFileSync(new URL("../migrations/001.sql", import.meta.url), "utf8"),
    );
    this.db.exec(
      readFileSync(
        new URL("../migrations/002-video-queue.sql", import.meta.url),
        "utf8",
      ),
    );
  }
  get<T>(kind: string, tenant: string, id: string): T | undefined {
    const r = this.db
      .prepare("SELECT data FROM records WHERE kind=? AND tenant=? AND id=?")
      .get(kind, tenant, id) as { data: string } | undefined;
    return r ? JSON.parse(r.data) : undefined;
  }
  put(kind: string, tenant: string, id: string, data: unknown) {
    this.db
      .prepare(
        "INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(kind,tenant,id) DO UPDATE SET data=excluded.data",
      )
      .run(kind, tenant, id, JSON.stringify(data));
  }
  list<T>(kind: string, tenant: string): T[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM records WHERE kind=? AND tenant=? ORDER BY rowid DESC LIMIT 100",
        )
        .all(kind, tenant) as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  del(kind: string, tenant: string, id: string) {
    this.db
      .prepare("DELETE FROM records WHERE kind=? AND tenant=? AND id=?")
      .run(kind, tenant, id);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
