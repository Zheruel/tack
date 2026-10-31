// Persistence. SQLite holds metadata; each thread's transcript is an append-only JSONL file.
// Only finished items are written (one line each), never streaming deltas.

import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { Effort, Access, Item, Project, Provider, Question, Queued, Thread } from "../shared/protocol";
import type { AgentTaskRecord } from "./agent-types";

// A thread's native session with one provider, and how much of the transcript it has seen.
export interface NativeSession {
  id?: string;
  seen?: number;
  toolsVersion?: number;
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
    if (!cols.includes("questions")) this.db.run("ALTER TABLE threads ADD COLUMN questions TEXT");
    // Sub-agent threads point at the thread whose agent started them.
    if (!cols.includes("parent_id")) this.db.run("ALTER TABLE threads ADD COLUMN parent_id TEXT");
    // Messages the user queued behind a running turn.
    if (!cols.includes("queue")) this.db.run("ALTER TABLE threads ADD COLUMN queue TEXT");
    if (!cols.includes("queue_held")) this.db.run("ALTER TABLE threads ADD COLUMN queue_held INTEGER");
    if (!cols.includes("stop_requested")) this.db.run("ALTER TABLE threads ADD COLUMN stop_requested INTEGER NOT NULL DEFAULT 0");
    if (!cols.includes("prs")) this.db.run("ALTER TABLE threads ADD COLUMN prs TEXT");
    // The project's git branch as of the thread's last turn.
    if (!cols.includes("branch")) this.db.run("ALTER TABLE threads ADD COLUMN branch TEXT");
    // "default" was an alias for Opus; threads now name the model explicitly.
    this.db.run("UPDATE threads SET model = 'opus' WHERE model = 'default'");
    this.db.run(`CREATE TABLE IF NOT EXISTS agent_tasks (
      child_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      parent_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      request_key TEXT,
      payload TEXT NOT NULL,
      PRIMARY KEY (child_id, generation))`);
    this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS agent_tasks_request
      ON agent_tasks(parent_id, request_key) WHERE request_key IS NOT NULL AND generation = 1`);
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

  createThread(projectId: string, provider: Provider, model: string, effort: Effort, child?: { parentId: string; title: string; access: Access }): Thread {
    const now = Date.now();
    const t: Thread = {
      id: crypto.randomUUID(),
      projectId,
      title: child?.title ?? "New thread",
      provider,
      model,
      effort,
      access: child?.access ?? "full",
      status: "idle",
      parentId: child?.parentId,
      settled: false,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .query(
        "INSERT INTO threads (id, project_id, title, provider, model, effort, access, session_id, created_at, updated_at, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)",
      )
      .run(t.id, projectId, t.title, t.provider, t.model, t.effort, t.access, now, now, t.parentId ?? null);
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

  setQuestions(id: string, questions: Question[] | null) {
    this.db.query("UPDATE threads SET questions = ? WHERE id = ?").run(questions ? JSON.stringify(questions) : null, id);
  }

  queue(id: string): Queued[] {
    const row = this.db.query<{ queue: string | null }, [string]>("SELECT queue FROM threads WHERE id = ?").get(id);
    return row?.queue ? JSON.parse(row.queue) : [];
  }

  queueHeld(id: string): boolean | undefined {
    const row = this.db.query<{ queue_held: number | null }, [string]>("SELECT queue_held FROM threads WHERE id = ?").get(id);
    return row?.queue_held == null ? undefined : row.queue_held === 1;
  }

  setQueue(id: string, queue: Queued[], held?: boolean) {
    const value = queue.length ? JSON.stringify(queue) : null;
    if (held === undefined) this.db.query("UPDATE threads SET queue = ? WHERE id = ?").run(value, id);
    else this.db.query("UPDATE threads SET queue = ?, queue_held = ? WHERE id = ?").run(value, held ? 1 : 0, id);
  }

  stopped(id: string): boolean {
    return this.db.query<{ stop_requested: number }, [string]>("SELECT stop_requested FROM threads WHERE id = ?").get(id)?.stop_requested === 1;
  }

  setStopped(id: string, stopped: boolean) {
    this.db.query("UPDATE threads SET stop_requested = ? WHERE id = ?").run(stopped ? 1 : 0, id);
  }

  agentTasks(): AgentTaskRecord[] {
    return this.db.query<{ payload: string }, []>("SELECT payload FROM agent_tasks ORDER BY child_id, generation").all().map((row) => JSON.parse(row.payload));
  }

  saveAgentTask(task: AgentTaskRecord): void {
    this.db.query(`INSERT INTO agent_tasks (child_id, parent_id, generation, request_key, payload)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(child_id, generation) DO UPDATE SET
        parent_id = excluded.parent_id, request_key = excluded.request_key, payload = excluded.payload`)
      .run(task.id, task.parentId, task.generation, task.requestKey ?? null, JSON.stringify(task));
  }

  saveAgentState(tasks: AgentTaskRecord[], queues: { threadId: string; queue: Queued[]; held: boolean }[]): void {
    this.db.transaction(() => {
      for (const task of tasks) this.saveAgentTask(task);
      for (const { threadId, queue, held } of queues) this.setQueue(threadId, queue, held);
    })();
  }

  addPr(id: string, url: string): boolean {
    const prs = this.thread(id)?.prs ?? [];
    if (prs.includes(url)) return false;
    this.db.query("UPDATE threads SET prs = ? WHERE id = ?").run(JSON.stringify([...prs, url]), id);
    return true;
  }

  setBranch(id: string, branch: string | null): boolean {
    if ((this.thread(id)?.branch ?? null) === branch) return false;
    this.db.query("UPDATE threads SET branch = ? WHERE id = ?").run(branch, id);
    return true;
  }

  setContext(id: string, context: { used: number; window: number }) {
    this.db.query("UPDATE threads SET context = ? WHERE id = ?").run(JSON.stringify(context), id);
  }

  deleteThread(id: string) {
    this.db.transaction(() => {
      this.db.query("DELETE FROM agent_tasks WHERE child_id = ? OR parent_id = ?").run(id, id);
      this.db.query("DELETE FROM threads WHERE id = ?").run(id);
    })();
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

  // Case-insensitive substring over what the user and assistant wrote, newest threads first.
  // Titles are matched in the UI; this finds the rest.
  searchThreads(query: string, limit = 40): { threadId: string; snippet: string; role: "user" | "assistant" }[] {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const hits: { threadId: string; snippet: string; role: "user" | "assistant" }[] = [];
    for (const t of this.threads()) {
      if (t.parentId) continue;
      for (const item of this.items(t.id)) {
        if (item.kind !== "user" && item.kind !== "assistant") continue;
        const at = item.text.toLowerCase().indexOf(q);
        if (at < 0) continue;
        const from = Math.max(0, at - 40);
        const text = item.text.slice(from, at + q.length + 80).replace(/\s+/g, " ").trim();
        hits.push({ threadId: t.id, snippet: `${from > 0 ? "…" : ""}${text}`, role: item.kind });
        break;
      }
      if (hits.length >= limit) break;
    }
    return hits;
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
    questions: r.questions ? JSON.parse(r.questions) : undefined,
    parentId: r.parent_id ?? undefined,
    prs: r.prs ? JSON.parse(r.prs) : undefined,
    branch: r.branch ?? undefined,
    settled: r.settled === null ? Date.now() - r.updated_at > AUTO_SETTLE_MS : r.settled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
