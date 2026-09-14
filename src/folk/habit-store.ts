import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../config/logger.js";
import type { CheckinStatus, FolkDb, Habit, HabitCheckin, HabitSchedule, HabitTone } from "./types.js";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function weekdayInTz(d: Date, tz: string): { weekday: number; ymd: string; hhmm: string } {
  const dateFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const timeFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const weekdayFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" });
  const map: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const parts = dateFmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "01";
  const ymd = `${get("year")}-${get("month")}-${get("day")}`;
  return { weekday: map[weekdayFmt.format(d)] ?? 0, ymd, hhmm: timeFmt.format(d) };
}

export function parseDays(input: string): number[] {
  const s = input.trim().toLowerCase();
  if (s === "daily" || s === "everyday" || s === "every day") return [1, 2, 3, 4, 5, 6, 7];
  if (s === "weekdays") return [1, 2, 3, 4, 5];
  if (s === "weekends") return [6, 7];
  const out = new Set<number>();
  const tokMap: Record<string, number> = {
    mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
    thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5,
    sat: 6, saturday: 6, sun: 7, sunday: 7,
  };
  for (const tok of s.split(/[,/\s]+/).filter(Boolean)) {
    if (/^[1-7]$/.test(tok)) { out.add(Number(tok)); continue; }
    const n = tokMap[tok];
    if (n) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

export function formatDays(days: number[]): string {
  if (days.length === 7) return "daily";
  if (days.length === 5 && days.every((d, i) => d === [1, 2, 3, 4, 5][i])) return "weekdays";
  if (days.length === 2 && days[0] === 6 && days[1] === 7) return "weekends";
  return days.map((d) => DAY_NAMES[d - 1]).join("/");
}

export function isValidTime(t: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
}

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function emptyDb(): FolkDb {
  return { habits: [], checkins: [], memoryNodes: [], memoryEdges: [], briefingDays: {} };
}

/**
 * Local-first habit + check-in store.
 * JSON file persistence (FOLK_DB_PATH, default folk.db.json).
 * Convex tables mirror this shape for cloud persistence (see convex/schema.ts).
 */
export class HabitStore {
  private db: FolkDb;
  private dbPath: string | null;
  private logger: Logger;

  constructor(logger: Logger, dbPath?: string | null) {
    this.logger = logger.child({ component: "HabitStore" });
    this.dbPath = dbPath ?? null;
    this.db = emptyDb();
    if (this.dbPath) this.load();
  }

  private load(): void {
    try {
      if (!this.dbPath || !existsSync(this.dbPath)) return;
      const raw = readFileSync(this.dbPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<FolkDb>;
      this.db = { ...emptyDb(), ...parsed };
    } catch (err) {
      this.logger.warn({ err }, "Folk DB load failed — starting empty");
      this.db = emptyDb();
    }
  }

  private save(): void {
    if (!this.dbPath) return;
    try {
      mkdirSync(dirname(this.dbPath), { recursive: true });
      writeFileSync(this.dbPath, JSON.stringify(this.db, null, 2), "utf8");
    } catch (err) {
      this.logger.warn({ err }, "Folk DB save failed");
    }
  }

  create(input: {
    chatId: string;
    userId: string;
    name: string;
    schedule: HabitSchedule;
    tone?: HabitTone;
    proofRequired?: boolean;
  }): Habit {
    const now = Date.now();
    const habit: Habit = {
      id: uid("habit"),
      chatId: input.chatId,
      userId: input.userId,
      name: input.name.trim(),
      schedule: { days: [...input.schedule.days].sort(), times: [...input.schedule.times].sort() },
      tone: input.tone ?? "steady",
      proofRequired: input.proofRequired ?? false,
      paused: false,
      streak: 0,
      longestStreak: 0,
      freezes: 1,
      lastCheckinDate: null,
      totalCheckins: 0,
      totalMisses: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.db.habits.push(habit);
    this.save();
    return habit;
  }

  list(chatId: string): Habit[] {
    return this.db.habits.filter((h) => h.chatId === chatId);
  }

  get(habitId: string): Habit | undefined {
    return this.db.habits.find((h) => h.id === habitId);
  }

  findByName(chatId: string, name: string): Habit | undefined {
    const n = name.trim().toLowerCase();
    return this.db.habits.find((h) => h.chatId === chatId && h.name.toLowerCase() === n);
  }

  pause(habitId: string, paused: boolean): Habit | undefined {
    const h = this.get(habitId);
    if (!h) return undefined;
    h.paused = paused;
    h.updatedAt = Date.now();
    this.save();
    return h;
  }

  remove(habitId: string): boolean {
    const i = this.db.habits.findIndex((h) => h.id === habitId);
    if (i < 0) return false;
    this.db.habits.splice(i, 1);
    this.db.checkins = this.db.checkins.filter((c) => c.habitId !== habitId);
    this.save();
    return true;
  }

  /** Check-ins due to SEND right now (no record yet for this date+time and time passed). */
  dueToSend(now: Date, tz: string): Array<{ habit: Habit; date: string; time: string }> {
    const { weekday, ymd, hhmm } = weekdayInTz(now, tz);
    const out: Array<{ habit: Habit; date: string; time: string }> = [];
    for (const h of this.db.habits) {
      if (h.paused) continue;
      if (!h.schedule.days.includes(weekday)) continue;
      for (const t of h.schedule.times) {
        if (t > hhmm) continue;
        const exists = this.db.checkins.some(
          (c) => c.habitId === h.id && c.date === ymd && c.scheduledTime === t,
        );
        if (!exists) out.push({ habit: h, date: ymd, time: t });
      }
    }
    return out;
  }

  markSent(habitId: string, date: string, time: string): HabitCheckin {
    const h = this.get(habitId);
    if (!h) throw new Error(`Unknown habit ${habitId}`);
    const existing = this.db.checkins.find(
      (c) => c.habitId === habitId && c.date === date && c.scheduledTime === time,
    );
    if (existing) return existing;
    const c: HabitCheckin = {
      id: uid("checkin"),
      habitId,
      chatId: h.chatId,
      date,
      scheduledTime: time,
      status: "pending",
      proof: null,
      sentAt: Date.now(),
      respondedAt: null,
      followups: 0,
    };
    this.db.checkins.push(c);
    this.save();
    return c;
  }

  /** Pending check-ins needing a follow-up nudge (older than followupMinutes, tone-gated). */
  dueFollowups(nowMs: number, followupMinutes: number): HabitCheckin[] {
    return this.db.checkins.filter((c) => {
      if (c.status !== "pending") return false;
      const h = this.get(c.habitId);
      if (!h || h.paused) return false;
      if (h.tone === "gentle" && c.followups >= 1) return false;
      if (h.tone === "steady" && c.followups >= 2) return false;
      if (c.followups >= 3) return false;
      return nowMs - c.sentAt >= followupMinutes * 60_000;
    });
  }

  bumpFollowup(checkinId: string): void {
    const c = this.db.checkins.find((x) => x.id === checkinId);
    if (!c) return;
    c.followups += 1;
    this.save();
  }

  log(habitId: string, status: CheckinStatus, proof?: string): HabitCheckin | undefined {
    const h = this.get(habitId);
    if (!h) return undefined;
    // Resolve the latest pending check-in if there is one;
    // otherwise record a fresh ad-hoc entry so every manual log counts.
    const pending = this.db.checkins
      .filter((c) => c.habitId === habitId && c.status === "pending")
      .sort((a, b) => b.sentAt - a.sentAt)[0];
    let checkin: HabitCheckin;
    if (pending) {
      pending.status = status;
      pending.respondedAt = Date.now();
      if (proof) pending.proof = proof.slice(0, 500);
      checkin = pending;
    } else {
      const now = new Date();
      checkin = {
        id: uid("checkin"),
        habitId,
        chatId: h.chatId,
        date: now.toISOString().slice(0, 10),
        scheduledTime: "manual",
        status,
        proof: proof?.slice(0, 500) ?? null,
        sentAt: Date.now(),
        respondedAt: Date.now(),
        followups: 0,
      };
      this.db.checkins.push(checkin);
    }
    if (status === "done") {
      const prev = h.lastCheckinDate;
      const consecutive = prev !== null && isConsecutiveDay(prev, checkin.date);
      h.streak = prev === checkin.date ? h.streak : consecutive || prev === null ? h.streak + 1 : 1;
      h.longestStreak = Math.max(h.longestStreak, h.streak);
      h.lastCheckinDate = checkin.date;
      h.totalCheckins += 1;
    } else if (status === "missed") {
      h.totalMisses += 1;
      if (h.freezes > 0) {
        h.freezes -= 1; // streak freeze saves the streak once
      } else {
        h.streak = 0;
      }
    }
    h.updatedAt = Date.now();
    this.save();
    return checkin;
  }

  pendingFor(chatId: string): Array<{ checkin: HabitCheckin; habit: Habit }> {
    const out: Array<{ checkin: HabitCheckin; habit: Habit }> = [];
    for (const c of this.db.checkins) {
      if (c.chatId !== chatId || c.status !== "pending") continue;
      const h = this.get(c.habitId);
      if (h) out.push({ checkin: c, habit: h });
    }
    return out.sort((a, b) => a.checkin.sentAt - b.checkin.sentAt);
  }

  /** 7-day accountability score for a chat (0-100). */
  score(chatId: string): { pct: number; done: number; scheduled: number } {
    const done = this.db.checkins.filter(
      (c) => c.chatId === chatId && (c.status === "done" || c.status === "missed"),
    );
    const ok = done.filter((c) => c.status === "done").length;
    if (done.length === 0) return { pct: 100, done: 0, scheduled: 0 };
    return { pct: Math.round((ok / done.length) * 100), done: ok, scheduled: done.length };
  }

  wasBriefed(ymd: string, chatId: string): boolean {
    return this.db.briefingDays[`${chatId}:${ymd}`] === "sent";
  }

  markBriefed(ymd: string, chatId: string): void {
    this.db.briefingDays[`${chatId}:${ymd}`] = "sent";
    this.save();
  }

  chatIds(): string[] {
    return [...new Set(this.db.habits.map((h) => h.chatId))];
  }

  export(): FolkDb {
    return JSON.parse(JSON.stringify(this.db)) as FolkDb;
  }
}

function isConsecutiveDay(prevYmd: string, curYmd: string): boolean {
  const prev = new Date(`${prevYmd}T12:00:00Z`).getTime();
  const cur = new Date(`${curYmd}T12:00:00Z`).getTime();
  return Math.round((cur - prev) / 86_400_000) === 1;
}

export const TONE_COPY: Record<Habit["tone"], { nudge: string; followup: string }> = {
  gentle: {
    nudge: "no pressure — just checking in 🌱",
    followup: "still here when you're ready 💛",
  },
  steady: {
    nudge: "time to check in — you've got this 💪",
    followup: "quick nudge: did you get to it?",
  },
  firm: {
    nudge: "check-in time. No excuses — send proof 📸",
    followup: "still waiting. Don't break the chain ⛓️",
  },
  relentless: {
    nudge: "NOW. You said you'd do this. Proof. ⏰",
    followup: "I'm not letting this slide. Reply DONE with proof 🔥",
  },
};
