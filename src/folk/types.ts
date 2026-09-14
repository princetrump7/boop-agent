/**
 * folk engine — shared types.
 *
 * Better-than-folk extras vs folk.com:
 *  - per-habit accountability tone (gentle → relentless)
 *  - proof-required check-ins + streak freeze
 *  - local-first JSON persistence (works without Convex)
 */

export type HabitTone = "gentle" | "steady" | "firm" | "relentless";

export interface HabitSchedule {
  /** Weekdays 1=Mon … 7=Sun */
  days: number[];
  /** Times "HH:MM" 24h in the user's TIMEZONE */
  times: string[];
}

export interface Habit {
  id: string;
  chatId: string;
  userId: string;
  name: string;
  schedule: HabitSchedule;
  tone: HabitTone;
  proofRequired: boolean;
  paused: boolean;
  streak: number;
  longestStreak: number;
  freezes: number;
  lastCheckinDate: string | null;
  totalCheckins: number;
  totalMisses: number;
  createdAt: number;
  updatedAt: number;
}

export type CheckinStatus = "pending" | "done" | "missed" | "skipped";

export interface HabitCheckin {
  id: string;
  habitId: string;
  chatId: string;
  /** yyyy-mm-dd in TIMEZONE */
  date: string;
  scheduledTime: string;
  status: CheckinStatus;
  proof: string | null;
  sentAt: number;
  respondedAt: number | null;
  followups: number;
}

export type MemoryNodeKind =
  | "person"
  | "preference"
  | "routine"
  | "goal"
  | "contact"
  | "fact";

export interface MemoryNode {
  id: string;
  chatId: string;
  kind: MemoryNodeKind;
  label: string;
  detail: string;
  importance: number;
  accessCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryEdge {
  id: string;
  chatId: string;
  fromId: string;
  toId: string;
  relation: string;
  createdAt: number;
}

export interface FolkDb {
  habits: Habit[];
  checkins: HabitCheckin[];
  memoryNodes: MemoryNode[];
  memoryEdges: MemoryEdge[];
  briefingDays: Record<string, string>;
}
