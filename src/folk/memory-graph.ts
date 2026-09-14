import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../config/logger.js";
import type { FolkDb, MemoryEdge, MemoryNode, MemoryNodeKind } from "./types.js";

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Persistent memory graph — folk.com parity + better:
 * typed nodes (person/preference/routine/goal/contact/fact) with
 * edges (relations), importance + access tracking, substring recall.
 * Shares the same JSON file as HabitStore when wired via store.ts.
 */
export class MemoryGraph {
  private nodes: MemoryNode[] = [];
  private edges: MemoryEdge[] = [];
  private dbPath: string | null;
  private logger: Logger;

  constructor(logger: Logger, dbPath?: string | null) {
    this.logger = logger.child({ component: "MemoryGraph" });
    this.dbPath = dbPath ?? null;
    if (this.dbPath) this.load();
  }

  private load(): void {
    try {
      if (!this.dbPath || !existsSync(this.dbPath)) return;
      const parsed = JSON.parse(readFileSync(this.dbPath, "utf8")) as Partial<FolkDb>;
      this.nodes = parsed.memoryNodes ?? [];
      this.edges = parsed.memoryEdges ?? [];
    } catch (err) {
      this.logger.warn({ err }, "MemoryGraph load failed — starting empty");
    }
  }

  private save(): void {
    if (!this.dbPath) return;
    try {
      const parsed = existsSync(this.dbPath)
        ? (JSON.parse(readFileSync(this.dbPath, "utf8")) as Partial<FolkDb>)
        : {};
      const merged: FolkDb = {
        habits: parsed.habits ?? [],
        checkins: parsed.checkins ?? [],
        memoryNodes: this.nodes,
        memoryEdges: this.edges,
        briefingDays: parsed.briefingDays ?? {},
      };
      mkdirSync(dirname(this.dbPath), { recursive: true });
      writeFileSync(this.dbPath, JSON.stringify(merged, null, 2), "utf8");
    } catch (err) {
      this.logger.warn({ err }, "MemoryGraph save failed");
    }
  }

  /** Used by HabitStore-shared persistence: inject full db slice. */
  hydrate(db: FolkDb): void {
    this.nodes = db.memoryNodes ?? [];
    this.edges = db.memoryEdges ?? [];
  }

  remember(input: {
    chatId: string;
    kind: MemoryNodeKind;
    label: string;
    detail: string;
    importance?: number;
  }): MemoryNode {
    const now = Date.now();
    const key = input.label.trim().toLowerCase();
    const existing = this.nodes.find(
      (n) => n.chatId === input.chatId && n.label.toLowerCase() === key && n.kind === input.kind,
    );
    if (existing) {
      existing.detail = input.detail;
      existing.importance = input.importance ?? existing.importance;
      existing.updatedAt = now;
      this.save();
      return existing;
    }
    const node: MemoryNode = {
      id: uid("mem"),
      chatId: input.chatId,
      kind: input.kind,
      label: input.label.trim(),
      detail: input.detail.slice(0, 2000),
      importance: Math.min(1, Math.max(0, input.importance ?? 0.5)),
      accessCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.nodes.push(node);
    this.save();
    return node;
  }

  link(chatId: string, fromLabel: string, toLabel: string, relation: string): MemoryEdge | undefined {
    const from = this.find(chatId, fromLabel);
    const to = this.find(chatId, toLabel);
    if (!from || !to) return undefined;
    const edge: MemoryEdge = {
      id: uid("edge"),
      chatId,
      fromId: from.id,
      toId: to.id,
      relation: relation.slice(0, 120),
      createdAt: Date.now(),
    };
    this.edges.push(edge);
    this.save();
    return edge;
  }

  find(chatId: string, label: string): MemoryNode | undefined {
    const n = this.nodes.find(
      (x) => x.chatId === chatId && x.label.toLowerCase() === label.trim().toLowerCase(),
    );
    if (n) {
      n.accessCount += 1;
      n.updatedAt = Date.now();
    }
    return n;
  }

  search(chatId: string, query: string, limit = 10): MemoryNode[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.nodes.filter((n) => n.chatId === chatId).slice(0, limit);
    const scored = this.nodes
      .filter((n) => n.chatId === chatId)
      .map((n) => {
        const hay = `${n.label} ${n.detail} ${n.kind}`.toLowerCase();
        const hits = q.split(/\s+/).filter((t) => hay.includes(t)).length;
        return { n, hits, score: hits * 2 + n.importance };
      })
      .filter((s) => s.hits > 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.n);
  }

  forget(chatId: string, label: string): boolean {
    const i = this.nodes.findIndex(
      (n) => n.chatId === chatId && n.label.toLowerCase() === label.trim().toLowerCase(),
    );
    if (i < 0) return false;
    const [removed] = this.nodes.splice(i, 1);
    this.edges = this.edges.filter((e) => e.fromId !== removed.id && e.toId !== removed.id);
    this.save();
    return true;
  }

  list(chatId: string): MemoryNode[] {
    return this.nodes.filter((n) => n.chatId === chatId);
  }

  formatted(chatId: string, limit = 30): string {
    const nodes = this.list(chatId)
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit);
    if (nodes.length === 0) return "";
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const lines = nodes.map((n) => {
      const rels = this.edges
        .filter((e) => e.fromId === n.id && byId.has(e.toId))
        .map((e) => `${e.relation} → ${byId.get(e.toId)?.label}`)
        .join("; ");
      return `- [${n.kind}] ${n.label}: ${n.detail}${rels ? ` (${rels})` : ""}`;
    });
    return `MEMORY GRAPH\n${lines.join("\n")}`;
  }
}
