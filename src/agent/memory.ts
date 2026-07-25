import type { Logger } from "../config/logger.js";

/**
 * A single memory entry.
 */
export interface MemoryEntry {
  key: string;
  content: string;
  category?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Memory store interface.
 * In-memory and Convex-backed implementations.
 */
export interface MemoryStore {
  /** Store or update a memory by key */
  set(key: string, content: string, category?: string): Promise<void>;
  /** Retrieve a memory by key */
  get(key: string): Promise<MemoryEntry | undefined>;
  /** Delete a memory by key */
  delete(key: string): Promise<void>;
  /** List all memories, optionally filtered by category */
  list(category?: string): Promise<MemoryEntry[]>;
  /** Format all memories as a prose string for system prompt injection */
  getAllFormatted(): Promise<string>;
}

/**
 * In-memory implementation of MemoryStore.
 * Used when Convex is not configured.
 */
export class InMemoryMemoryStore implements MemoryStore {
  private store = new Map<string, MemoryEntry>();
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ component: "InMemoryMemoryStore" });
  }

  async set(key: string, content: string, category?: string): Promise<void> {
    const now = Date.now();
    const existing = this.store.get(key);

    this.store.set(key, {
      key,
      content,
      category,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });

    this.logger.debug({ key, category }, "Memory set");
  }

  async get(key: string): Promise<MemoryEntry | undefined> {
    return this.store.get(key);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
    this.logger.debug({ key }, "Memory deleted");
  }

  async list(category?: string): Promise<MemoryEntry[]> {
    const entries = Array.from(this.store.values());
    if (category) {
      return entries.filter((e) => e.category === category);
    }
    return entries;
  }

  async getAllFormatted(): Promise<string> {
    const entries = Array.from(this.store.values());
    if (entries.length === 0) return "";

    const sections = new Map<string, string[]>();

    for (const entry of entries) {
      const cat = entry.category ?? "general";
      if (!sections.has(cat)) sections.set(cat, []);
      sections.get(cat)!.push(`- ${entry.key}: ${entry.content}`);
    }

    const parts: string[] = [];
    for (const [category, items] of sections) {
      parts.push(`[${category.toUpperCase()}]\n${items.join("\n")}`);
    }

    return parts.join("\n\n");
  }
}
