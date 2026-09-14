import type { Logger } from "../config/logger.js";
import { HabitStore } from "./habit-store.js";
import { MemoryGraph } from "./memory-graph.js";

let habitStore: HabitStore | null = null;
let memoryGraph: MemoryGraph | null = null;

function folkDbPath(): string | null {
  const p = process.env.FOLK_DB_PATH?.trim();
  if (p) return p;
  return "folk.db.json";
}

/** Shared singletons so tools, commands, scheduler and webapp see the same state. */
export function getHabitStore(logger: Logger): HabitStore {
  if (!habitStore) habitStore = new HabitStore(logger, folkDbPath());
  return habitStore;
}

export function getMemoryGraph(logger: Logger): MemoryGraph {
  if (!memoryGraph) memoryGraph = new MemoryGraph(logger, folkDbPath());
  return memoryGraph;
}

/** Test-only: reset singletons. */
export function resetFolkStores(): void {
  habitStore = null;
  memoryGraph = null;
}
