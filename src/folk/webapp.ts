import { Router, type Request, type Response } from "express";
import type { Logger } from "../config/logger.js";
import type { HabitStore } from "./habit-store.js";
import type { MemoryGraph } from "./memory-graph.js";
import { buildMorningBriefing } from "./briefing.js";
import { weekdayInTz } from "./habit-store.js";
import { PACKS, hirePack } from "./packs.js";

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
    const days = weekStreakData(chatId, habits);
    res.json({ habits: all, score, pending, memories: memory.list(chatId), packs: PACKS.map((p) => ({ id: p.id, emoji: p.emoji, name: p.name, category: p.category, tagline: p.tagline, hired: p.habits.length > 0 && p.habits.every((h) => habits.findByName(chatId, h.name)) })), days });
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
    res.json({ ok: true, streak: cur.streak, longestStreak: cur.longestStreak, freezes: cur.freezes, score: habits.score(String(chatId)) });
  });

  r.post("/api/folk/hire", (req: Request, res: Response) => {
    const { chatId, userId, packId } = (req.body ?? {}) as Record<string, unknown>;
    if (!chatId || !packId) { res.status(400).json({ error: "chatId, packId required" }); return; }
    const r2 = hirePack(String(packId), String(chatId), String(userId ?? chatId), habits, memory);
    if (!r2) { res.status(404).json({ error: `No pack "${packId}"` }); return; }
    log.debug({ packId: r2.pack.id }, "WebApp hire");
    res.json({ ok: true, pack: r2.pack.name, created: r2.habitsCreated, skipped: r2.habitsSkipped });
  });

  r.post("/api/folk/remember", (req: Request, res: Response) => {
    const { chatId, kind, label, detail } = (req.body ?? {}) as Record<string, unknown>;
    if (!chatId || !label || !detail) { res.status(400).json({ error: "chatId, label, detail required" }); return; }
    const node = memory.remember({ chatId: String(chatId), kind: (kind as "person" | "preference" | "routine" | "goal" | "contact" | "fact") ?? "fact", label: String(label), detail: String(detail) });
    res.json({ ok: true, id: node.id, kind: node.kind, label: node.label });
  });

  r.delete("/api/folk/remember/:label", (req: Request, res: Response) => {
    const chatId = String(req.query.chatId ?? "");
    if (!chatId) { res.status(400).json({ error: "chatId required" }); return; }
    memory.forget(chatId, typeof req.params.label === "string" ? req.params.label : req.params.label[0] ?? "");
    res.json({ ok: true });
  });

  r.post("/api/folk/pause", (req: Request, res: Response) => {
    const { chatId, name, paused } = (req.body ?? {}) as Record<string, unknown>;
    if (!chatId || !name) { res.status(400).json({ error: "chatId, name required" }); return; }
    const h = habits.findByName(String(chatId), String(name));
    if (!h) { res.status(404).json({ error: `No habit named "${name}"` }); return; }
    habits.pause(h.id, Boolean(paused));
    res.json({ ok: true, paused: !paused });
  });

  r.post("/api/folk/freeze", (req: Request, res: Response) => {
    const { chatId, name } = (req.body ?? {}) as Record<string, unknown>;
    if (!chatId || !name) { res.status(400).json({ error: "chatId, name required" }); return; }
    const h = habits.findByName(String(chatId), String(name));
    if (!h) { res.status(404).json({ error: `No habit named "${name}"` }); return; }
    const prev = h.freezes;
    habits.pause(h.id, h.paused);
    habits.pause(h.id, false);
    h.freezes = prev + 1;
    habits.pause(h.id, true);
    res.json({ ok: true, freezes: h.freezes });
  });

  return r;
}

function weekStreakData(chatId: string, habits: HabitStore): { labels: string; total: number; done: number; misses: number }[] {
  const tz = process.env.TIMEZONE ?? "Africa/Accra";
  const now = new Date();
  const db = habits.export();
  const results: { labels: string; total: number; done: number; misses: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const label = d.toLocaleDateString("en", { weekday: "short", timeZone: tz });
    const { ymd } = weekdayInTz(d, tz);
    const dayCheckins = db.checkins.filter(c => c.chatId === chatId && c.date === ymd);
    const total = dayCheckins.length;
    const done = dayCheckins.filter(c => c.status === "done").length;
    const misses = dayCheckins.filter(c => c.status === "missed").length;
    results.push({ labels: label, total, done, misses });
  }
  return results;
}

function folkWebAppHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Boop</title>
<script src="https://telegram.org/js/telegram-web-app.js"><\/script>
<style>
/* Native-first: Telegram theme vars, Raycast ladder as fallback */
:root {
  color-scheme: light dark;
  --bg: var(--tg-theme-bg-color, #07080a);
  --surface: var(--tg-theme-secondary-bg-color, #0d0d0d);
  --elevated: #101111;
  --card: var(--tg-theme-section-bg-color, #121212);
  --hairline: rgba(127,127,137,.22);
  --text: var(--tg-theme-text-color, #f5f5f5);
  --hint: var(--tg-theme-hint-color, #708499);
  --link: var(--tg-theme-link-color, #6ab3f3);
  --cta: var(--tg-theme-button-color, #ffffff);
  --cta-text: var(--tg-theme-button-text-color, #000000);
  --danger: var(--tg-theme-destructive-text-color, #ec3942);
  --green: #3ddc84;
  --amber: #ffc531;
  --violet: #8b5cf6;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif;
  background: var(--bg); color: var(--text);
  font-size: 16px; line-height: 1.4; letter-spacing: .2px;
  min-height: 100dvh; overflow-x: hidden;
}
.shell { max-width: 480px; margin: 0 auto; padding: 12px 16px calc(env(safe-area-inset-bottom, 12px) + 32px); }

/* Header — your status first */
.hdr { padding: 12px 4px 2px; }
.hdr .date { font-size: 13px; font-weight: 500; color: var(--hint); }
.hdr h1 { font-size: 32px; font-weight: 700; letter-spacing: -.5px; line-height: 1.1; margin-top: 2px; }

/* Cards — one surface ladder, hairlines, tight radius */
.card { background: var(--card); border: 1px solid var(--hairline); border-radius: 10px; padding: 16px; margin: 10px 0; animation: rise .35s ease both; }
.card:nth-of-type(2) { animation-delay: .04s; } .card:nth-of-type(3) { animation-delay: .08s; }
.card:nth-of-type(4) { animation-delay: .12s; } .card:nth-of-type(5) { animation-delay: .16s; }
.card:nth-of-type(6) { animation-delay: .2s; } .card:nth-of-type(7) { animation-delay: .24s; }
@keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
.sect { font-size: 13px; font-weight: 600; color: var(--hint); text-transform: none; letter-spacing: .2px; margin-bottom: 12px; }

/* Hero: ring + glory metrics */
.hero { display: flex; align-items: center; gap: 16px; }
.ring-wrap { position: relative; width: 112px; height: 112px; flex-shrink: 0; }
.ring-wrap svg { transform: rotate(-90deg); }
.ring-bg { stroke: var(--hairline); }
.ring-fg { stroke: var(--link); stroke-linecap: round; transition: stroke-dashoffset .8s cubic-bezier(.3,.7,.3,1); }
.ring-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.ring-center .pct { font-size: 24px; font-weight: 700; letter-spacing: -.5px; }
.ring-center .cap { font-size: 11px; color: var(--hint); font-weight: 500; }
.hero-stats { flex: 1; min-width: 0; }
.hero-stat { padding: 7px 0; border-bottom: 1px solid var(--hairline); display: flex; justify-content: space-between; align-items: baseline; }
.hero-stat:last-child { border-bottom: none; }
.hero-stat .k { font-size: 13px; color: var(--hint); font-weight: 500; }
.hero-stat .v { font-size: 17px; font-weight: 700; }
.hero-stat .v.streak { color: var(--amber); }

/* Pending banner */
.pending { display: flex; gap: 10px; align-items: center; background: rgba(255,197,49,.08); border: 1px solid rgba(255,197,49,.35); border-radius: 10px; padding: 12px 14px; margin: 10px 0; font-size: 14px; font-weight: 500; }
.pending .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--amber); flex-shrink: 0; }

/* Habit rows — content-aware, 48px targets */
.habit { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--hairline); }
.habit:last-child { border-bottom: none; }
.habit-dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }
.habit-main { flex: 1; min-width: 0; }
.habit-name { font-weight: 600; font-size: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.habit-sub { font-size: 13px; color: var(--hint); margin-top: 1px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.tone { font-size: 12px; font-weight: 600; color: var(--hint); }
.tone.relentless { color: var(--danger); } .tone.firm { color: var(--amber); } .tone.gentle { color: var(--green); }
.habit-streak { font-size: 14px; font-weight: 700; white-space: nowrap; }
.habit-actions { display: flex; gap: 8px; }
.btn { border: 0; border-radius: 8px; font-family: inherit; font-weight: 600; font-size: 15px; cursor: pointer; min-height: 48px; min-width: 48px; padding: 0 16px; display: inline-flex; align-items: center; justify-content: center; transition: opacity .15s, transform .1s; letter-spacing: .2px; }
.btn:active { transform: scale(.96); }
.btn-primary { background: var(--cta); color: var(--cta-text); width: 100%; }
.btn-done { background: var(--cta); color: var(--cta-text); }
.btn-ghost { background: transparent; color: var(--hint); border: 1px solid var(--hairline); min-width: 48px; padding: 0 12px; }
.btn-danger-ghost { background: transparent; color: var(--danger); border: 1px solid var(--hairline); min-width: 48px; padding: 0 12px; }
.btn-block { width: 100%; margin-top: 10px; }

/* Week bars */
.week { display: flex; gap: 6px; align-items: flex-end; height: 96px; }
.day { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 0; }
.day .track { width: 100%; height: 64px; border-radius: 6px; background: var(--surface); border: 1px solid var(--hairline); display: flex; align-items: flex-end; overflow: hidden; }
.day .fill { width: 100%; border-radius: 0 0 5px 5px; transition: height .5s ease; }
.day .fill.ok { background: var(--green); } .day .fill.bad { background: var(--danger); } .day .fill.idle { background: transparent; }
.day .dl { font-size: 11px; color: var(--hint); font-weight: 500; }
.day.today .dl { color: var(--text); font-weight: 700; }

/* Pack / memory rows — Telegram settings-list feel */
.row-item { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--hairline); }
.row-item:last-child { border-bottom: none; }
.tile { width: 40px; height: 40px; border-radius: 10px; background: var(--surface); border: 1px solid var(--hairline); display: flex; align-items: center; justify-content: center; font-size: 19px; flex-shrink: 0; }
.row-main { flex: 1; min-width: 0; }
.row-title { font-weight: 600; font-size: 15px; }
.row-sub { font-size: 13px; color: var(--hint); margin-top: 1px; line-height: 1.35; }
.pill-btn { border: 1px solid var(--link); color: var(--link); background: transparent; border-radius: 999px; font-family: inherit; font-weight: 600; font-size: 14px; padding: 8px 18px; min-height: 44px; cursor: pointer; flex-shrink: 0; transition: opacity .15s; }
.pill-btn:active { opacity: .6; }
.active-badge { color: var(--green); font-size: 13px; font-weight: 600; flex-shrink: 0; }
.del { width: 44px; height: 44px; border-radius: 8px; border: 0; background: transparent; color: var(--hint); font-size: 16px; cursor: pointer; flex-shrink: 0; }
.del:active { color: var(--danger); }

/* Forms */
.field { width: 100%; background: var(--surface); border: 1px solid var(--hairline); border-radius: 8px; padding: 13px 14px; color: var(--text); font-size: 16px; font-family: inherit; letter-spacing: .2px; outline: none; margin: 5px 0; }
.field:focus { border-color: var(--link); }
.field::placeholder { color: var(--hint); }
.field-row { display: flex; gap: 8px; }
.briefing-text { font-size: 14px; line-height: 1.55; color: var(--text); white-space: pre-wrap; }

/* Connect */
.connect-row { display: flex; gap: 8px; }
.connect-row .field { margin: 0; }
.connect-row .btn { width: auto; padding: 0 22px; }

/* Empty */
.empty { text-align: center; padding: 20px 12px; color: var(--hint); font-size: 14px; line-height: 1.5; }
.empty code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; color: var(--link); }

/* Toast + loader */
.toast { position: fixed; left: 50%; bottom: calc(env(safe-area-inset-bottom, 12px) + 28px); transform: translateX(-50%) translateY(16px); background: var(--card); border: 1px solid var(--hairline); color: var(--text); border-radius: 10px; padding: 12px 20px; font-size: 14px; font-weight: 600; opacity: 0; transition: all .25s ease; z-index: 50; pointer-events: none; max-width: calc(100vw - 48px); text-align: center; }
.toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
.loader { position: fixed; inset: 0; background: var(--bg); display: flex; align-items: center; justify-content: center; z-index: 40; transition: opacity .3s; font-size: 15px; font-weight: 600; color: var(--hint); }
.loader.hide { opacity: 0; pointer-events: none; }
.loader .pulse { animation: pulse 1.2s ease infinite; }
@keyframes pulse { 0%,100% { opacity: .4; } 50% { opacity: 1; } }
</style>
</head>
<body>
<div class="loader" id="loader"><div class="pulse">Boop</div></div>
<div class="shell">
  <div class="hdr">
    <div class="date" id="todayLine"></div>
    <h1>Today</h1>
  </div>

  <div class="card" id="connectCard">
    <div class="sect">Connect</div>
    <div class="connect-row">
      <input class="field" id="chatId" placeholder="Telegram chat ID" inputmode="numeric" autocomplete="off" />
      <button class="btn btn-primary" id="loadBtn" onclick="load()">Go</button>
    </div>
  </div>

  <div id="content" style="display:none"></div>
</div>
<div class="toast" id="toast"></div>

<script>
var tg = window.Telegram ? window.Telegram.WebApp : null;
if (tg) {
  tg.ready(); tg.expand();
  try { tg.setHeaderColor(tg.colorScheme === 'light' ? '#ffffff' : '#07080a'); } catch (e) {}
  try { tg.setBackgroundColor(tg.colorScheme === 'light' ? '#ffffff' : '#07080a'); } catch (e) {}
  try { tg.onEvent('themeChanged', function () {
    try { tg.setHeaderColor(tg.colorScheme === 'light' ? '#ffffff' : '#07080a'); } catch (e2) {}
    try { tg.setBackgroundColor(tg.colorScheme === 'light' ? '#ffffff' : '#07080a'); } catch (e3) {}
  }); } catch (e4) {}
}

var chat = '';
function $(id) { return document.getElementById(id); }
function esc(s) { var d = document.createElement('div'); d.textContent = (s === undefined || s === null) ? '' : String(s); return d.innerHTML; }
function toast(msg) { var t = $('toast'); t.textContent = msg; t.className = 'toast show'; setTimeout(function () { t.className = 'toast'; }, 2200); }
function buzz(kind) { try { if (tg && tg.HapticFeedback) { if (kind === 'ok') tg.HapticFeedback.notificationOccurred('success'); else if (kind === 'err') tg.HapticFeedback.notificationOccurred('error'); else tg.HapticFeedback.impactOccurred('light'); } } catch (e) {} }

/* Stable per-habit identity color (Habitly-style icon+color system) */
function habitHue(name) { var h = 0; for (var i = 0; i < name.length; i++) { h = (h * 31 + name.charCodeAt(i)) % 360; } return h; }
function habitColor(name) { return 'hsl(' + habitHue(name) + ', 65%, 55%)'; }

function todayLine() {
  try {
    var s = new Date().toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric' });
    $('todayLine').textContent = s;
  } catch (e) { $('todayLine').textContent = ''; }
}

function ringSVG(pct) {
  var r = 46, c = 2 * Math.PI * r;
  var off = c * (1 - Math.max(0, Math.min(100, pct)) / 100);
  return '<div class="ring-wrap"><svg width="112" height="112" viewBox="0 0 112 112">'
    + '<circle class="ring-bg" cx="56" cy="56" r="' + r + '" fill="none" stroke-width="9"/>'
    + '<circle class="ring-fg" cx="56" cy="56" r="' + r + '" fill="none" stroke-width="9" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '"/>'
    + '</svg><div class="ring-center"><div class="pct">' + pct + '%</div><div class="cap">on track</div></div></div>';
}

function weekHTML(days) {
  var out = '<div class="week">';
  for (var i = 0; i < days.length; i++) {
    var d = days[i];
    var cls = d.misses > 0 ? 'bad' : (d.done > 0 ? 'ok' : 'idle');
    var h = d.total ? Math.max(10, Math.round((d.done / d.total) * 64)) : 0;
    var today = i === days.length - 1 ? ' today' : '';
    out += '<div class="day' + today + '"><div class="track"><div class="fill ' + cls + '" style="height:' + h + 'px"></div></div><div class="dl">' + esc(d.labels) + '</div></div>';
  }
  return out + '</div>';
}

async function load() {
  chat = $('chatId').value.trim();
  if (!chat) { toast('Enter your chat ID'); buzz('err'); return; }
  try { localStorage.setItem('boop_chat', chat); } catch (e) {}
  buzz('tap');
  $('loadBtn').textContent = '...';
  $('loader').className = 'loader';
  try {
    var res = await fetch('/api/folk/overview?chatId=' + encodeURIComponent(chat));
    if (!res.ok) throw new Error('bad status');
    var j = await res.json();
    render(j);
    buzz('ok');
  } catch (e) {
    toast('Could not load — check the chat ID');
    buzz('err');
  }
  $('loadBtn').textContent = 'Go';
  $('loader').className = 'loader hide';
}

function render(j) {
  var s = j.score;
  var habits = j.habits || [];
  var pending = j.pending || [];
  var memories = j.memories || [];
  var packs = j.packs || [];
  var best = habits.length ? Math.max.apply(null, habits.map(function (h) { return h.streak || 0; })) : 0;
  var html = '';

  /* Hero — your status first */
  html += '<div class="card"><div class="hero">' + ringSVG(s.pct)
    + '<div class="hero-stats">'
    + '<div class="hero-stat"><span class="k">Best streak</span><span class="v streak">' + best + ' days</span></div>'
    + '<div class="hero-stat"><span class="k">Done this week</span><span class="v">' + s.done + ' / ' + s.scheduled + '</span></div>'
    + '<div class="hero-stat"><span class="k">Active habits</span><span class="v">' + habits.length + '</span></div>'
    + '</div></div></div>';

  if (pending.length) {
    html += '<div class="pending"><span class="dot"></span><span>' + pending.length + ' check-in' + (pending.length > 1 ? 's' : '') + ' awaiting your reply — tap Done on the habit below.</span></div>';
  }

  /* Habits */
  html += '<div class="card"><div class="sect">Habits</div>';
  if (habits.length) {
    for (var i = 0; i < habits.length; i++) {
      var h = habits[i];
      html += '<div class="habit">'
        + '<span class="habit-dot" style="background:' + habitColor(h.name) + '"></span>'
        + '<div class="habit-main"><div class="habit-name">' + esc(h.name) + '</div>'
        + '<div class="habit-sub"><span class="tone ' + esc(h.tone) + '">' + esc(h.tone) + '</span>'
        + '<span>' + esc(h.daysLabel) + ' · ' + esc((h.times || []).join(', ')) + '</span>'
        + (h.proofRequired ? '<span>photo proof</span>' : '')
        + (h.paused ? '<span>paused</span>' : '')
        + '</div></div>'
        + '<div class="habit-streak">' + (h.streak || 0) + 'd</div>'
        + '<div class="habit-actions">'
        + '<button class="btn btn-done" onclick="logHabit(this.dataset.n,\'done\')" data-n="' + esc(h.name) + '">Done</button>'
        + '<button class="btn btn-ghost" onclick="togglePause(this.dataset.n,this.dataset.p)" data-n="' + esc(h.name) + '" data-p="' + h.paused + '">' + (h.paused ? 'Resume' : 'Pause') + '</button>'
        + '</div></div>';
    }
  } else {
    html += '<div class="empty">No habits yet.<br>Send <code>/habit gym daily 07:00</code> in chat and I will check in on you.</div>';
  }
  html += '</div>';

  /* Week */
  if (j.days && j.days.length && j.days.some(function (d) { return d.total > 0; })) {
    html += '<div class="card"><div class="sect">Last 7 days</div>' + weekHTML(j.days) + '</div>';
  }

  /* Packs */
  html += '<div class="card"><div class="sect">Coaches</div>';
  for (var p = 0; p < packs.length; p++) {
    var pk = packs[p];
    html += '<div class="row-item"><div class="tile">' + esc(pk.emoji) + '</div>'
      + '<div class="row-main"><div class="row-title">' + esc(pk.name) + '</div><div class="row-sub">' + esc(pk.tagline) + '</div></div>'
      + (pk.hired ? '<span class="active-badge">Active</span>' : '<button class="pill-btn" onclick="hire(this.dataset.p)" data-p="' + esc(pk.id) + '">Hire</button>')
      + '</div>';
  }
  html += '</div>';

  /* Memory */
  html += '<div class="card"><div class="sect">Memory</div>';
  if (memories.length) {
    for (var m = 0; m < memories.length; m++) {
      var mem = memories[m];
      html += '<div class="row-item"><div class="tile">' + kindIcon(mem.kind) + '</div>'
        + '<div class="row-main"><div class="row-title">' + esc(mem.label) + '</div><div class="row-sub">' + esc(String(mem.detail).slice(0, 140)) + '</div></div>'
        + '<button class="del" onclick="forget(this.dataset.l)" data-l="' + esc(mem.label) + '">Delete</button></div>';
    }
  } else {
    html += '<div class="empty">Nothing remembered yet.<br>Send <code>/remember goal marathon : under 4h</code> in chat.</div>';
  }
  html += '<div class="field-row"><input class="field" id="ml" placeholder="Label — e.g. marathon" /><input class="field" id="md" placeholder="Detail" style="flex:2" /></div>';
  html += '<button class="btn btn-primary btn-block" onclick="remember()">Remember this</button></div>';

  /* Briefing */
  html += '<div class="card"><div class="sect">Briefing</div><div class="briefing-text" id="brief">Loading…</div>'
    + '<button class="btn btn-ghost btn-block" style="width:100%" onclick="brief()">Refresh briefing</button></div>';

  $('content').innerHTML = html;
  $('content').style.display = '';
  $('connectCard').style.display = 'none';
  brief();
}

function kindIcon(kind) {
  var map = { person: 'P', goal: 'G', preference: 'S', routine: 'R', contact: 'C', fact: 'i' };
  return map[kind] || 'i';
}

async function hire(pid) {
  buzz('tap');
  try {
    var res = await fetch('/api/folk/hire', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: chat, userId: chat, packId: pid }) });
    var j = await res.json();
    toast(j.ok ? ('Hired ' + j.pack) : (j.error || 'Hire failed'));
    if (j.ok) { buzz('ok'); load(); } else buzz('err');
  } catch (e) { toast('Hire failed'); buzz('err'); }
}

async function logHabit(name, st) {
  buzz('tap');
  try {
    var res = await fetch('/api/folk/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: chat, name: name, status: st }) });
    var j = await res.json();
    if (j.ok) { toast(st === 'done' ? ('Logged — streak ' + j.streak + ' days') : 'Marked as missed'); buzz('ok'); load(); }
    else { toast(j.error || 'Log failed'); buzz('err'); }
  } catch (e) { toast('Log failed'); buzz('err'); }
}

async function togglePause(name, p) {
  buzz('tap');
  try {
    await fetch('/api/folk/pause', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: chat, name: name, paused: p === 'true' }) });
    load();
  } catch (e) { toast('Could not update'); buzz('err'); }
}

async function forget(label) {
  buzz('tap');
  try {
    await fetch('/api/folk/remember/' + encodeURIComponent(label), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: chat }) });
    toast('Forgotten');
    load();
  } catch (e) { toast('Could not forget'); buzz('err'); }
}

async function remember() {
  var label = $('ml').value.trim(), detail = $('md').value.trim();
  if (!label || !detail) { toast('Add a label and a detail'); buzz('err'); return; }
  buzz('tap');
  try {
    await fetch('/api/folk/remember', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: chat, kind: 'fact', label: label, detail: detail }) });
    toast('Remembered');
    buzz('ok');
    load();
  } catch (e) { toast('Could not save'); buzz('err'); }
}

async function brief() {
  if (!chat) return;
  try {
    var res = await fetch('/api/folk/briefing?chatId=' + encodeURIComponent(chat));
    var j = await res.json();
    var el = $('brief');
    if (el) el.textContent = j.briefing || 'No briefing today.';
  } catch (e) { var el2 = $('brief'); if (el2) el2.textContent = 'Briefing unavailable.'; }
}

todayLine();
(function () {
  var c = null;
  try { c = localStorage.getItem('boop_chat'); } catch (e) {}
  if (c) { $('chatId').value = c; load(); }
  else { $('loader').className = 'loader hide'; }
})();
<\/script>
</body>
</html>`;
}
