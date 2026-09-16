import type { Context } from "telegraf";
import type { Logger } from "../config/logger.js";
import { getEnv } from "../config/env.js";
import { sendLongMessage, escapeMarkdown, commandList } from "./formatting.js";
import { extractCommandArgs } from "./commands.js";
import { formatDays, isValidTime, parseDays, TONE_COPY, weekdayInTz } from "../folk/habit-store.js";
import type { HabitStore } from "../folk/habit-store.js";
import type { MemoryGraph } from "../folk/memory-graph.js";
import { buildMorningBriefing, buildWindDown } from "../folk/briefing.js";
import { PACKS, hirePack } from "../folk/packs.js";
import type { HabitTone, MemoryNodeKind } from "../folk/types.js";

const TONES: HabitTone[] = ["gentle", "steady", "firm", "relentless"];
const KINDS: MemoryNodeKind[] = ["person", "preference", "routine", "goal", "contact", "fact"];

type BotLike = {
  command: (name: string, handler: (ctx: Context) => Promise<void>) => void;
  telegram: { sendMessage: (chatId: number | string, text: string, extra?: unknown) => Promise<unknown> };
};

function webAppUrl(): string | null {
  const base = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
  return base ? `${base}/webapp/` : null;
}

/** Register folk.com-parity commands: habits, streaks, briefing, memory graph, WebApp. */
export function registerFolkCommands(
  bot: BotLike,
  habits: HabitStore,
  memory: MemoryGraph,
  logger: Logger,
): void {
  const log = logger.child({ component: "FolkCommands" });

  bot.command("habit", async (ctx: Context) => {
    const args = extractCommandArgs(ctx);
    const chatId = String(ctx.chat?.id ?? "unknown");
    const userId = String(ctx.from?.id ?? "unknown");
    if (!args || args === "help") {
      await sendLongMessage(ctx, `*Habits — I text you first*\n\n${commandList([
        ["/habit <name> <days> <time> [tone] [proof]", "e.g. /habit gym Mon/Wed/Fri 07:00 firm proof"],
        ["/habits", "your lineup with streaks"],
        ["/done <name>", "log it done"],
        ["/missed <name>", "log a miss"],
        ["/pause <name> · /resume <name>", "pause / resume"],
        ["/streak", "streaks + score"],
        ["/briefing", "today's briefing now"],
      ])}\n\nTones: gentle · steady · firm · relentless.`);
      return;
    }
    const parts = args.split(/\s+/);
    const [name, daysRaw, ...rest] = parts;
    if (!name || !daysRaw) {
      await ctx.reply("⚠️ Usage: `/habit <name> <days> <time> [tone] [proof]` — e.g. `/habit gym Mon/Wed/Fri 07:00 relentless proof`", { parse_mode: "Markdown" });
      return;
    }
    const days = parseDays(daysRaw);
    const times = rest.filter(isValidTime);
    const tone = rest.find((r) => (TONES as string[]).includes(r.toLowerCase())) as HabitTone | undefined;
    const proofRequired = rest.some((r) => r.toLowerCase() === "proof");
    if (days.length === 0 || times.length === 0) {
      await ctx.reply("⚠️ I couldn't parse that. Days like `Mon/Wed/Fri` or `daily`, times like `07:00`.", { parse_mode: "Markdown" });
      return;
    }
    const h = habits.create({
      chatId, userId, name,
      schedule: { days, times },
      tone: tone ?? "steady",
      proofRequired,
    });
    log.debug({ habitId: h.id }, "Habit created");
    await sendLongMessage(ctx, `*${escapeMarkdown(h.name)}* is live.\n\n${formatDays(h.schedule.days)} · ${h.schedule.times.join(", ")} · ${h.tone}${h.proofRequired ? " · photo proof" : ""}\n\nI'll text you first — reply DONE when you finish.`);
  });

  bot.command("habits", async (ctx: Context) => {
    const chatId = String(ctx.chat?.id ?? "unknown");
    const all = habits.list(chatId);
    if (all.length === 0) {
      await ctx.reply("No habits yet. Try `/habit gym daily 07:00` — I'll check in on you.", { parse_mode: "Markdown" });
      return;
    }
    const lines = all.map((h) => `• *${escapeMarkdown(h.name)}* — ${formatDays(h.schedule.days)} · ${h.schedule.times.join(", ")} — ${h.streak}d streak${h.paused ? " (paused)" : ""}`);
    await sendLongMessage(ctx, `*Your lineup*\n\n${lines.join("\n")}`);
  });

  const logDone = async (ctx: Context, status: "done" | "missed") => {
    const args = extractCommandArgs(ctx);
    const chatId = String(ctx.chat?.id ?? "unknown");
    const [name, ...proofParts] = args.split(/\s+/);
    if (!name) {
      await ctx.reply(`⚠️ Usage: \`/${status} <habit name>\``, { parse_mode: "Markdown" });
      return;
    }
    const h = habits.findByName(chatId, name);
    if (!h) {
      await ctx.reply(`⚠️ No habit named "${name}". See /habits.`);
      return;
    }
    habits.log(h.id, status, proofParts.join(" ") || undefined);
    const cur = habits.get(h.id)!;
    await ctx.reply(
      status === "done"
        ? `Logged. *${cur.name}* — *${cur.streak}d* streak (best ${cur.longestStreak}).`
        : `Missed. *${cur.name}* — streak ${cur.streak}d, ${cur.freezes} freezes left. Tomorrow.`,
      { parse_mode: "Markdown" },
    );
  };

  bot.command("done", async (ctx) => logDone(ctx, "done"));
  bot.command("missed", async (ctx) => logDone(ctx, "missed"));

  bot.command("pause", async (ctx: Context) => {
    const chatId = String(ctx.chat?.id ?? "unknown");
    const name = extractCommandArgs(ctx);
    const h = habits.findByName(chatId, name);
    if (!h) { await ctx.reply("⚠️ Which habit? `/pause <name>`", { parse_mode: "Markdown" }); return; }
    habits.pause(h.id, true);
    await ctx.reply(`*${h.name}* paused. I'll stay quiet until you /resume it.`, { parse_mode: "Markdown" });
  });

  bot.command("resume", async (ctx: Context) => {
    const chatId = String(ctx.chat?.id ?? "unknown");
    const name = extractCommandArgs(ctx);
    const h = habits.findByName(chatId, name);
    if (!h) { await ctx.reply("⚠️ Which habit? `/resume <name>`", { parse_mode: "Markdown" }); return; }
    habits.pause(h.id, false);
    await ctx.reply(`*${h.name}* resumed — back on.`, { parse_mode: "Markdown" });
  });

  bot.command("streak", async (ctx: Context) => {
    const chatId = String(ctx.chat?.id ?? "unknown");
    const all = habits.list(chatId);
    const s = habits.score(chatId);
    if (all.length === 0) { await ctx.reply("No streaks yet — create one with /habit."); return; }
    const lines = all.map((h) => `• *${escapeMarkdown(h.name)}* — ${h.streak}d (best ${h.longestStreak})`);
    await sendLongMessage(ctx, `*Streaks — ${s.pct}% on track* (${s.done}/${s.scheduled} this week)\n\n${lines.join("\n")}`);
  });

  bot.command("briefing", async (ctx: Context) => {
    const chatId = String(ctx.chat?.id ?? "unknown");
    const tz = getEnv().TIMEZONE ?? "Africa/Accra";
    const { ymd } = weekdayInTz(new Date(), tz);
    const text = buildMorningBriefing({
      chatId, date: ymd, habits, memory,
      name: ctx.from?.first_name,
    });
    await sendLongMessage(ctx, text);
  });

  bot.command("remember", async (ctx: Context) => {
    const args = extractCommandArgs(ctx);
    const chatId = String(ctx.chat?.id ?? "unknown");
    // /remember <kind> <label> : <detail>
    const m = args.match(/^(\w+)\s+([^:]+):([\s\S]+)$/);
    if (!m) {
      await ctx.reply("⚠️ Usage: `/remember <kind> <label> : <detail>` — e.g. `/remember goal marathon : run it in under 4h`", { parse_mode: "Markdown" });
      return;
    }
    const kind = (KINDS as string[]).includes(m[1].toLowerCase()) ? (m[1].toLowerCase() as MemoryNodeKind) : "fact";
    const node = memory.remember({ chatId, kind, label: m[2].trim(), detail: m[3].trim() });
    await ctx.reply(`Remembered: *${node.label}*. I'll use it in check-ins.`, { parse_mode: "Markdown" });
  });

  bot.command("recall", async (ctx: Context) => {
    const chatId = String(ctx.chat?.id ?? "unknown");
    const q = extractCommandArgs(ctx);
    const hits = memory.search(chatId, q);
    if (hits.length === 0) { await ctx.reply("Nothing remembered yet — send /remember to teach me about you."); return; }
    await sendLongMessage(ctx, `*Remembered*\n\n${hits.map((n) => `• *${escapeMarkdown(n.label)}*: ${escapeMarkdown(n.detail.slice(0, 200))}`).join("\n")}`);
  });

  bot.command("forget", async (ctx: Context) => {
    const chatId = String(ctx.chat?.id ?? "unknown");
    const label = extractCommandArgs(ctx);
    if (!label) { await ctx.reply("⚠️ Usage: `/forget <label>`", { parse_mode: "Markdown" }); return; }
    const ok = memory.forget(chatId, label);
    await ctx.reply(ok ? `🗑️ Forgot "${label}".` : `Nothing stored as "${label}".`);
  });

    bot.command("packs", async (ctx: Context) => {
    const args = extractCommandArgs(ctx).toLowerCase();
    const packs = args ? PACKS.filter((p) => p.category === args) : PACKS;
    if (packs.length === 0) {
      await ctx.reply("⚠️ No packs in that category. Try /packs to see them all.");
      return;
    }
    const lines = packs.map((p) => `${p.emoji} *${p.name}* — \`/hire ${p.id}\`\n${p.tagline}`);
    await sendLongMessage(ctx, `*Coaches — hire one, it starts texting you*\n\n${lines.join("\n\n")}`);
  });

  bot.command("hire", async (ctx: Context) => {
    const packId = extractCommandArgs(ctx).split(/\s+/)[0] ?? "";
    const chatId = String(ctx.chat?.id ?? "unknown");
    const userId = String(ctx.from?.id ?? "unknown");
    if (!packId) {
      await ctx.reply("⚠️ Usage: `/hire <pack>` — e.g. `/hire workout`. See /packs.", { parse_mode: "Markdown" });
      return;
    }
    const r = hirePack(packId, chatId, userId, habits, memory);
    if (!r) {
      await ctx.reply(`⚠️ No pack "${packId}". See /packs.`);
      return;
    }
    log.debug({ packId: r.pack.id }, "Pack hired");
    const lines = [
      `*${r.pack.name}* hired. ${r.pack.tagline}`,
      ...r.habitsCreated.map((h) => `• ${h} — I'll text you first`),
      ...r.habitsSkipped.map((h) => `• ${h} already active`),
    ];
    await sendLongMessage(ctx, lines.join("\n"));
  });

  bot.command("boop", async (ctx: Context) => {    const url = webAppUrl();
    if (!url) {
      await ctx.reply("Dashboard isn't configured yet (PUBLIC_URL). Meanwhile /habits, /streak and /briefing work right here.");
      return;
    }
    await ctx.reply("Your dashboard:", {
      reply_markup: { inline_keyboard: [[{ text: "Open dashboard", web_app: { url } }]] },
    } as unknown as Parameters<Context["reply"]>[1]);
  });
}

export interface FolkTickDeps {
  habits: HabitStore;
  memory: MemoryGraph;
  send: (chatId: string, text: string) => Promise<void>;
  logger: Logger;
}

/** Proactive tick — called by the scheduler every ~60s. Sends check-ins first. */
export async function runFolkTick(now: Date, deps: FolkTickDeps): Promise<void> {
  const env = getEnv();
  const tz = env.TIMEZONE ?? "Africa/Accra";
  const followupMin = Number(process.env.FOLLOWUP_MINUTES ?? 120);
  const briefingHour = Number(process.env.BRIEFING_HOUR ?? 7);
  const windDownRaw = process.env.WIND_DOWN_HOUR;
  const windDownHour = windDownRaw === undefined || windDownRaw === "" ? null : Number(windDownRaw);
  const { ymd } = weekdayInTz(now, tz);

  // 1. Due check-ins → text first
  for (const { habit, date, time } of deps.habits.dueToSend(now, tz)) {
    deps.habits.markSent(habit.id, date, time);
    const copy = TONE_COPY[habit.tone];
    const proof = habit.proofRequired ? " Send a photo." : "";
    await deps.send(
      habit.chatId,
      `*${habit.name}* — ${copy.nudge}${proof}\n\n${habit.streak}d streak. Reply \`/done ${habit.name}\` when finished.`,
    ).catch((err) => deps.logger.warn({ err, habitId: habit.id }, "Check-in send failed"));
  }

  // 2. Follow-up nudges for unanswered check-ins
  for (const c of deps.habits.dueFollowups(now.getTime(), followupMin)) {
    const h = deps.habits.get(c.habitId);
    if (!h) continue;
    deps.habits.bumpFollowup(c.id);
    await deps.send(h.chatId, `*${h.name}* — ${TONE_COPY[h.tone].followup} (${h.streak}d streak on the line)`).catch(
      (err) => deps.logger.warn({ err, checkinId: c.id }, "Follow-up send failed"),
    );
  }

  // 3. Morning briefing (once per chat per day)
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "-1");
    if (hour === briefingHour) {
      for (const chatId of deps.habits.chatIds()) {
        if (deps.habits.wasBriefed(ymd, chatId)) continue;
        deps.habits.markBriefed(ymd, chatId);
        await deps.send(chatId, buildMorningBriefing({ chatId, date: ymd, habits: deps.habits, memory: deps.memory })).catch(
          (err) => deps.logger.warn({ err, chatId }, "Briefing send failed"),
        );
      }
    }
    // 4. Wind-down (optional, once per day — reuse briefing guard key with suffix)
    if (windDownHour !== null && hour === windDownHour) {
      for (const chatId of deps.habits.chatIds()) {
        const key = `${ymd}-winddown`;
        if (deps.habits.wasBriefed(key, chatId)) continue;
        deps.habits.markBriefed(key, chatId);
        await deps.send(chatId, buildWindDown(deps.habits, chatId)).catch(
          (err) => deps.logger.warn({ err, chatId }, "Wind-down send failed"),
        );
      }
    }
  } catch (err) {
    deps.logger.warn({ err }, "Briefing tick failed");
  }
}
