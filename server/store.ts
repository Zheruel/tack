// Persistence. SQLite holds metadata; each thread's transcript is an append-only JSONL file.
// Only finished items are written (one line each), never streaming deltas.

import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { Effort, Access, Item, Project, Provider, Thread } from "../shared/protocol";

// A thread's native session with one provider, and how much of the transcript it has seen.
export interface NativeSession {
  id?: string;
  seen?: number;
}

export class Store {
  private db: Database;
  private transcripts: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.transcripts = join(dataDir, "threads");
    mkdirSync(this.transcripts, { recursive: true });
    this.db = new Database(join(dataDir, "tack.db"), { create: true, strict: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      effort TEXT NOT NULL,
      access TEXT NOT NULL,
      session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL)`);
    this.db.run("CREATE INDEX IF NOT EXISTS threads_project ON threads(project_id, updated_at)");
    const cols = this.db.query<{ name: string }, []>("PRAGMA table_info(threads)").all().map((c) => c.name);
    // null: follow the auto rule; 1: settled by hand; 0: kept open by hand.
    if (!cols.includes("settled")) this.db.run("ALTER TABLE threads ADD COLUMN settled INTEGER");
    if (!cols.includes("sessions")) {
      this.db.run("ALTER TABLE threads ADD COLUMN sessions TEXT NOT NULL DEFAULT '{}'");
      // Older threads only knew Claude, and Claude has seen all of them.
      for (const r of this.db.query<{ id: string; session_id: string }, []>("SELECT id, session_id FROM threads WHERE session_id IS NOT NULL").all())
        this.db
          .query("UPDATE threads SET sessions = ? WHERE id = ?")
          .run(JSON.stringify({ claude: { id: r.session_id, seen: this.items(r.id).length } }), r.id);
    }
    if (!cols.includes("context")) this.db.run("ALTER TABLE threads ADD COLUMN context TEXT");
    // "default" was an alias for Opus; threads now name the model explicitly.
    this.db.run("UPDATE threads SET model = 'opus' WHERE model = 'default'");
    this.db.run("PRAGMA foreign_keys = ON");
  }

  projects(): Project[] {
    return this.db
      .query<any, []>("SELECT * FROM projects ORDER BY created_at")
      .all()
      .map((r) => ({ id: r.id, name: r.name, path: r.path, createdAt: r.created_at }));
  }

  addProject(path: string): Project {
    const existing = this.db.query<any, [string]>("SELECT * FROM projects WHERE path = ?").get(path);
    if (existing) return { id: existing.id, name: existing.name, path, createdAt: existing.created_at };
    const project = { id: crypto.randomUUID(), name: basename(path), path, createdAt: Date.now() };
    this.db.query("INSERT INTO projects VALUES (?, ?, ?, ?)").run(project.id, project.name, path, project.createdAt);
    return project;
  }

  project(id: string): Project | undefined {
    return this.projects().find((p) => p.id === id);
  }

  removeProject(id: string): string[] {
    const threadIds = this.db
      .query<{ id: string }, [string]>("SELECT id FROM threads WHERE project_id = ?")
      .all(id)
      .map((r) => r.id);
    for (const t of threadIds) this.deleteThread(t);
    this.db.query("DELETE FROM projects WHERE id = ?").run(id);
    return threadIds;
  }

  threads(): Thread[] {
    return this.db.query<any, []>("SELECT * FROM threads ORDER BY updated_at DESC").all().map(toThread);
  }

  thread(id: string): Thread | undefined {
    const r = this.db.query<any, [string]>("SELECT * FROM threads WHERE id = ?").get(id);
    return r ? toThread(r) : undefined;
  }

  createThread(projectId: string, provider: Provider, model: string, effort: Effort): Thread {
    const now = Date.now();
    const t: Thread = {
      id: crypto.randomUUID(),
      projectId,
      title: "New thread",
      provider,
      model,
      effort,
      access: "full",
      status: "idle",
      settled: false,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .query(
        "INSERT INTO threads (id, project_id, title, provider, model, effort, access, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
      )
      .run(t.id, projectId, t.title, t.provider, t.model, t.effort, t.access, now, now);
    return t;
  }

  updateThread(id: string, patch: { title?: string; provider?: Provider; model?: string; effort?: Effort; access?: Access }) {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      this.db.query(`UPDATE threads SET ${k} = ? WHERE id = ?`).run(v, id);
    }
  }

  touch(id: string) {
    this.db.query("UPDATE threads SET updated_at = ? WHERE id = ?").run(Date.now(), id);
  }

  settle(id: string, settled: boolean | null) {
    this.db.query("UPDATE threads SET settled = ? WHERE id = ?").run(settled === null ? null : settled ? 1 : 0, id);
  }

  session(id: string, provider: Provider): NativeSession {
    const row = this.db.query<{ sessions: string }, [string]>("SELECT sessions FROM threads WHERE id = ?").get(id);
    return (JSON.parse(row?.sessions ?? "{}") as Partial<Record<Provider, NativeSession>>)[provider] ?? {};
  }

  setSession(id: string, provider: Provider, patch: NativeSession) {
    const row = this.db.query<{ sessions: string }, [string]>("SELECT sessions FROM threads WHERE id = ?").get(id);
    if (!row) return;
    const all = JSON.parse(row.sessions);
    all[provider] = { ...all[provider], ...patch };
    this.db.query("UPDATE threads SET sessions = ? WHERE id = ?").run(JSON.stringify(all), id);
  }

  setContext(id: string, context: { used: number; window: number }) {
    this.db.query("UPDATE threads SET context = ? WHERE id = ?").run(JSON.stringify(context), id);
  }

  deleteThread(id: string) {
    this.db.query("DELETE FROM threads WHERE id = ?").run(id);
    rmSync(this.file(id), { force: true });
  }

  // Later lines with the same id replace earlier ones (e.g. a tool item getting its output).
  items(threadId: string): Item[] {
    const file = this.file(threadId);
    if (!existsSync(file)) return [];
    const byId = new Map<string, Item>();
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      const item = JSON.parse(line) as Item;
      byId.set(item.id, item);
    }
    return [...byId.values()];
  }

  appendItem(threadId: string, item: Item) {
    appendFileSync(this.file(threadId), JSON.stringify(item) + "\n");
  }

  private file(threadId: string) {
    return join(this.transcripts, `${threadId}.jsonl`);
  }
}

const AUTO_SETTLE_MS = 3 * 24 * 60 * 60_000;

function toThread(r: any): Thread {
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    provider: r.provider,
    model: r.model,
    effort: r.effort,
    access: r.access,
    status: "idle",
    context: r.context ? JSON.parse(r.context) : undefined,
    settled: r.settled === null ? Date.now() - r.updated_at > AUTO_SETTLE_MS : r.settled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
