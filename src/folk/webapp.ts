import { Router, type Request, type Response } from "express";
import type { Logger } from "../config/logger.js";
import type { HabitStore } from "./habit-store.js";
import { formatDays } from "./habit-store.js";
import type { MemoryGraph } from "./memory-graph.js";
import { buildMorningBriefing } from "./briefing.js";
import { weekdayInTz } from "./habit-store.js";
import { PACKS, hirePack } from "./packs.js";

/**
 * Telegram WebApp dashboard + JSON API.
 * Mounted at /webapp (HTML) and /api/folk/* (JSON).
 * v1 auth: chatId-scoped — the caller must know the numeric chat id
 * (same trust level as the bot's authorized-chat broadcast).
 */
export function createFolkRouter(habits: HabitStore, memory: MemoryGraph, logger: Logger): Router {
  const log = logger.child({ component: "FolkWebApp" });
  const r = Router();

  r.get("/webapp/", (_req: Request, res: Response) => {
    res.type("html").send(folkWebAppHtml());
  });

  r.get("/api/folk/overview", (req: Request, res: Response) => {
    const chatId = String(req.query.chatId ?? "");
    if (!chatId) { res.status(400).json({ error: "chatId required" }); return; }
    const all = habits.list(chatId);
    const score = habits.score(chatId);
    const pending = habits.pendingFor(chatId).map(({ habit, checkin }) => ({
      habit: habit.name, date: checkin.date, time: checkin.scheduledTime, followups: checkin.followups,
    }));
    res.json({
      habits: all.map((h) => ({
        id: h.id, name: h.name, days: h.schedule.days, daysLabel: formatDays(h.schedule.days),
        times: h.schedule.times, tone: h.tone, proofRequired: h.proofRequired, paused: h.paused,
        streak: h.streak, longestStreak: h.longestStreak, freezes: h.freezes,
        totalCheckins: h.totalCheckins, totalMisses: h.totalMisses,
      })),
      score, pending,
      memories: memory.list(chatId).map((n) => ({ kind: n.kind, label: n.label, detail: n.detail, importance: n.importance })),
      packs: PACKS.map((p) => ({
        id: p.id, emoji: p.emoji, name: p.name, category: p.category, tagline: p.tagline,
        hired: p.habits.length > 0 && p.habits.every((h) => habits.findByName(chatId, h.name)),
      })),
    });
  });

  r.get("/api/folk/briefing", (req: Request, res: Response) => {
    const chatId = String(req.query.chatId ?? "");
    if (!chatId) { res.status(400).json({ error: "chatId required" }); return; }
    const tz = process.env.TIMEZONE ?? "Africa/Accra";
    const { ymd } = weekdayInTz(new Date(), tz);
    res.json({ briefing: buildMorningBriefing({ chatId, date: ymd, habits, memory }) });
  });

  r.post("/api/folk/log", (req: Request, res: Response) => {
    const { chatId, name, status, proof } = (req.body ?? {}) as Record<string, unknown>;
    if (!chatId || !name || !status) { res.status(400).json({ error: "chatId, name, status required" }); return; }
    const h = habits.findByName(String(chatId), String(name));
    if (!h) { res.status(404).json({ error: `No habit named "${name}"` }); return; }
    if (!["done", "missed", "skipped"].includes(String(status))) { res.status(400).json({ error: "status must be done|missed|skipped" }); return; }
    habits.log(h.id, status as "done" | "missed" | "skipped", proof ? String(proof) : undefined);
    const cur = habits.get(h.id)!;
    log.debug({ habitId: h.id, status }, "WebApp log");
    res.json({ ok: true, streak: cur.streak, longestStreak: cur.longestStreak, freezes: cur.freezes });
  });

  r.post("/api/folk/hire", (req: Request, res: Response) => {
    const { chatId, userId, packId } = (req.body ?? {}) as Record<string, unknown>;
    if (!chatId || !packId) { res.status(400).json({ error: "chatId, packId required" }); return; }
    const r2 = hirePack(String(packId), String(chatId), String(userId ?? chatId), habits, memory);
    if (!r2) { res.status(404).json({ error: `No pack "${packId}"` }); return; }
    log.debug({ packId: r2.pack.id }, "WebApp hire");
    res.json({ ok: true, pack: r2.pack.name, created: r2.habitsCreated, skipped: r2.habitsSkipped });
  });

  r.post("/api/folk/remember", (req: Request, res: Response) => {    const { chatId, kind, label, detail } = (req.body ?? {}) as Record<string, unknown>;
    if (!chatId || !label || !detail) { res.status(400).json({ error: "chatId, label, detail required" }); return; }
    const node = memory.remember({
      chatId: String(chatId),
      kind: (kind as "person" | "preference" | "routine" | "goal" | "contact" | "fact") ?? "fact",
      label: String(label), detail: String(detail),
    });
    res.json({ ok: true, id: node.id, kind: node.kind, label: node.label });
  });

  return r;
}

function folkWebAppHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Boop — accountability dashboard</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 16px; max-width: 640px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { opacity: .7; font-size: 13px; margin-bottom: 12px; }
  .card { border: 1px solid #8884; border-radius: 12px; padding: 12px; margin: 10px 0; }
  .row { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
  button { border: 0; border-radius: 10px; padding: 8px 12px; font-weight: 600; cursor: pointer; }
  .done { background: #22c55e; color: white; } .miss { background: #ef4444; color: white; }
  .streak { font-weight: 700; } input, select { padding: 8px; border-radius: 8px; border: 1px solid #8886; width: 100%; margin: 4px 0; }
  pre { white-space: pre-wrap; font-size: 13px; }
</style>
</head>
<body>
<h1>🔥 Boop dashboard</h1>
<div class="sub">Habits, streaks, memory — beyond folk.com: tones, proof, freezes, WebApp control.</div>
<div class="card">
  <div class="row"><strong>Chat</strong><span id="score"></span></div>
  <input id="chatId" placeholder="Telegram chat id (e.g. 123456789)" inputmode="numeric" />
  <button onclick="load()">Load</button>
</div>
<div id="habits"></div>
<div class="card"><strong>🛍️ Mini-folks</strong><div id="packs" class="sub">Load your chat to see the gallery.</div></div>
<div class="card"><strong>🧠 Memory</strong><div id="mem"></div></div>
<div class="card"><strong>☀️ Briefing</strong><pre id="brief"></pre><button onclick="brief()">Refresh briefing</button></div>
<script>
const tg = window.Telegram?.WebApp; if (tg) { tg.ready(); tg.expand(); }
async function load() {
  const chatId = document.getElementById('chatId').value.trim();
  if (!chatId) return alert('Enter your chat id (ask the bot /status or check your habits chat).');
  localStorage.setItem('boop_chat', chatId);
  const r = await fetch('/api/folk/overview?chatId=' + encodeURIComponent(chatId));
  const j = await r.json();
  document.getElementById('score').textContent = '📊 ' + j.score.pct + '% (' + j.score.done + '/' + j.score.scheduled + ')';
  document.getElementById('habits').innerHTML = j.habits.map(h =>
    '<div class="card"><div class="row"><strong>' + h.name + '</strong><span class="streak">🔥' + h.streak + ' (best ' + h.longestStreak + ')</span></div>' +
    '<div class="sub">' + h.daysLabel + ' @ ' + h.times.join(', ') + ' · ' + h.tone + (h.proofRequired ? ' · proof 📸' : '') + (h.paused ? ' · paused' : '') + ' · freezes: ' + h.freezes + '</div>' +
    '<div class="row"><button class="done" onclick="logHabit(\\'' + h.name + '\\',\\'done\\')">DONE</button><button class="miss" onclick="logHabit(\\'' + h.name + '\\',\\'missed\\')">miss</button></div></div>'
  ).join('') || '<div class="card">No habits yet — create one in chat: /habit gym daily 07:00</div>';
  document.getElementById('mem').innerHTML = (j.memories || []).map(m => '<div>• [' + m.kind + '] <strong>' + m.label + '</strong>: ' + m.detail.slice(0, 120) + '</div>').join('') || 'Nothing remembered yet.';
  document.getElementById('packs').innerHTML = (j.packs || []).map(p =>
    '<div class="row" style="margin:6px 0"><span>' + p.emoji + ' <strong>' + p.name + '</strong><br><span style="opacity:.7;font-size:12px">' + p.tagline + '</span></span>' +
    (p.hired ? '<span>✅</span>' : '<button onclick="hire(\\'' + p.id + '\\')">Hire</button>') + '</div>'
  ).join('');
  brief();
}
async function hire(packId) {
  const chatId = document.getElementById('chatId').value.trim();
  await fetch('/api/folk/hire', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId, userId: chatId, packId }) });
  load();
}
async function logHabit(name, status) {
  const chatId = document.getElementById('chatId').value.trim();
  await fetch('/api/folk/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId, name, status }) });
  load();
}
async function brief() {
  const chatId = document.getElementById('chatId').value.trim();
  if (!chatId) return;
  const r = await fetch('/api/folk/briefing?chatId=' + encodeURIComponent(chatId));
  const j = await r.json();
  document.getElementById('brief').textContent = j.briefing || '';
}
(function(){ const c = localStorage.getItem('boop_chat'); if (c) { document.getElementById('chatId').value = c; load(); } })();
</script>
</body>
</html>`;
}
