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
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet" />
<script src="https://telegram.org/js/telegram-web-app.js"><\/script>
<style>
:root {
  --bg: #09090b; --surface: #18181b; --surface2: #27272a; --border: #3f3f46;
  --text: #fafafa; --text2: #a1a1aa; --text3: #71717a;
  --accent: #a78bfa; --accent2: #8b5cf6; --green: #34d399; --red: #f87171;
  --orange: #fb923c; --blue: #60a5fa; --pink: #f472b6;
  --glass: rgba(24,24,27,.72); --glass-border: rgba(63,63,70,.5);
  --r: 16px; --r-sm: 10px; --r-xs: 6px;
  --shadow: 0 1px 3px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.25);
  --shadow-lg: 0 4px 12px rgba(0,0,0,.5), 0 16px 48px rgba(0,0,0,.35);
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
  color-scheme: dark;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--bg); color: var(--text); min-height: 100dvh; overflow-x: hidden; -webkit-tap-highlight-color: transparent; }
body::before { content: ''; position: fixed; top: -50%; left: -50%; width: 200%; height: 200%;
  background: radial-gradient(ellipse at 30% 20%, rgba(139,92,246,.08) 0%, transparent 50%),
              radial-gradient(ellipse at 70% 80%, rgba(52,211,153,.05) 0%, transparent 50%);
  pointer-events: none; z-index: 0; }

.shell { position: relative; z-index: 1; max-width: 480px; margin: 0 auto; padding: env(safe-area-inset-top, 12px) 16px calc(env(safe-area-inset-bottom, 12px) + 80px); }

/* ── Header ── */
.hdr { padding: 20px 0 4px; }
.hdr h1 { font-size: 28px; font-weight: 900; letter-spacing: -1px; line-height: 1.1; }
.hdr h1 span { background: linear-gradient(135deg, var(--accent), var(--green)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
.hdr .sub { color: var(--text3); font-size: 13px; margin-top: 4px; }

/* ── Glass card ── */
.card { background: var(--glass); border: 1px solid var(--glass-border); border-radius: var(--r); padding: 16px; margin: 12px 0; backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
  animation: fadeUp .4s ease both; }
.card:nth-child(2) { animation-delay: .05s; } .card:nth-child(3) { animation-delay: .1s; }
.card:nth-child(4) { animation-delay: .15s; } .card:nth-child(5) { animation-delay: .2s; }
.card:nth-child(6) { animation-delay: .25s; } .card:nth-child(7) { animation-delay: .3s; }
@keyframes fadeUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }

.card-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.2px; color: var(--text3); margin-bottom: 12px; display: flex; align-items: center; gap: 6px; }

/* ── Stats grid ── */
.stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin: 12px 0; }
.stat { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-sm); padding: 16px 12px; text-align: center; transition: transform .2s, border-color .3s; }
.stat:active { transform: scale(.97); }
.stat .n { font-size: 28px; font-weight: 800; letter-spacing: -1px; line-height: 1; }
.stat .n.accent { color: var(--accent); }
.stat .n.green { color: var(--green); }
.stat .l { font-size: 11px; color: var(--text3); margin-top: 4px; font-weight: 500; }

/* ── Chart ── */
.chart-wrap { padding: 4px 0 0; }
.chart { display: flex; align-items: flex-end; gap: 6px; height: 100px; padding: 0 4px; }
.chart .col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; }
.chart .bar-bg { width: 100%; height: 80px; background: var(--surface2); border-radius: var(--r-xs); position: relative; overflow: hidden; display: flex; align-items: flex-end; }
.chart .bar { width: 100%; border-radius: var(--r-xs); transition: height .6s cubic-bezier(.34,1.56,.64,1); min-height: 3px; }
.chart .bar.done { background: linear-gradient(180deg, var(--green), #059669); }
.chart .bar.miss { background: linear-gradient(180deg, var(--red), #dc2626); }
.chart .bar.empty { background: var(--surface2); opacity: .3; }
.chart .lbl { font-size: 10px; color: var(--text3); font-weight: 600; }
.chart .val { font-size: 9px; color: var(--text2); font-weight: 500; }

/* ── Streak hero ── */
.streak-hero { text-align: center; padding: 20px 0 12px; }
.streak-hero .num { font-size: 56px; font-weight: 900; letter-spacing: -3px; line-height: 1;
  background: linear-gradient(135deg, var(--orange), var(--red)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
.streak-hero .label { font-size: 12px; color: var(--text3); font-weight: 600; text-transform: uppercase; letter-spacing: 1px; }

/* ── Habit rows ── */
.habit { display: flex; align-items: center; gap: 12px; padding: 14px 0; border-bottom: 1px solid rgba(63,63,70,.4); }
.habit:last-child { border-bottom: none; }
.habit-info { flex: 1; min-width: 0; }
.habit-name { font-weight: 700; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.habit-meta { font-size: 12px; color: var(--text3); margin-top: 2px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.habit-streak { font-size: 14px; font-weight: 800; color: var(--orange); white-space: nowrap; }

.pill { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; }
.pill-gentle { background: rgba(52,211,153,.15); color: var(--green); }
.pill-steady { background: rgba(96,165,250,.15); color: var(--blue); }
.pill-firm { background: rgba(251,146,60,.15); color: var(--orange); }
.pill-relentless { background: rgba(248,113,113,.15); color: var(--red); }
.pill-paused { background: rgba(113,113,122,.15); color: var(--text3); }

.habit-actions { display: flex; gap: 6px; flex-shrink: 0; }
.btn { border: 0; border-radius: var(--r-xs); padding: 8px 12px; font-weight: 700; font-size: 11px; cursor: pointer; transition: all .15s; text-transform: uppercase; letter-spacing: .5px; font-family: inherit; }
.btn:active { transform: scale(.93); }
.btn-done { background: var(--green); color: #000; }
.btn-miss { background: rgba(248,113,113,.15); color: var(--red); border: 1px solid rgba(248,113,113,.3); }
.btn-skip { background: var(--surface2); color: var(--text3); border: 1px solid var(--border); }
.btn-accent { background: var(--accent2); color: #fff; }
.btn-accent:active { background: var(--accent); }

/* ── Pack cards ── */
.pack-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.pack { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-sm); padding: 14px; text-align: center; transition: all .2s; cursor: pointer; }
.pack:active { transform: scale(.97); border-color: var(--accent); }
.pack .emoji { font-size: 28px; margin-bottom: 6px; }
.pack .name { font-weight: 700; font-size: 13px; }
.pack .tag { font-size: 11px; color: var(--text3); margin-top: 2px; line-height: 1.3; }
.pack.hired { border-color: var(--green); background: rgba(52,211,153,.05); }
.pack .hired-badge { color: var(--green); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; margin-top: 6px; }

/* ── Memory ── */
.memo { display: flex; align-items: flex-start; gap: 10px; padding: 12px; background: var(--surface); border-radius: var(--r-sm); margin: 6px 0; border: 1px solid var(--border); }
.memo-icon { width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0; }
.memo-icon.person { background: rgba(96,165,250,.15); }
.memo-icon.goal { background: rgba(52,211,153,.15); }
.memo-icon.preference { background: rgba(167,139,250,.15); }
.memo-icon.routine { background: rgba(251,146,60,.15); }
.memo-icon.contact { background: rgba(244,114,182,.15); }
.memo-icon.fact { background: rgba(113,113,122,.15); }
.memo-body { flex: 1; min-width: 0; }
.memo-label { font-weight: 700; font-size: 13px; }
.memo-detail { font-size: 12px; color: var(--text2); margin-top: 2px; line-height: 1.4; }
.memo-del { width: 24px; height: 24px; border-radius: 6px; border: 0; background: rgba(248,113,113,.1); color: var(--red); cursor: pointer; font-size: 12px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: background .15s; }
.memo-del:active { background: rgba(248,113,113,.25); }

/* ── Add memory ── */
.add-memo { display: flex; gap: 6px; margin-top: 10px; }
.add-memo input { flex: 1; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-xs); padding: 10px 12px; color: var(--text); font-size: 13px; font-family: inherit; outline: none; transition: border-color .2s; }
.add-memo input:focus { border-color: var(--accent); }
.add-memo input::placeholder { color: var(--text3); }

/* ── Briefing ── */
.briefing-text { font-size: 13px; line-height: 1.6; color: var(--text2); white-space: pre-wrap; font-family: 'Inter', system-ui, sans-serif; }

/* ── Chat ID input ── */
.chat-input { display: flex; gap: 8px; align-items: stretch; }
.chat-input input { flex: 1; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-sm); padding: 12px 14px; color: var(--text); font-size: 14px; font-family: inherit; outline: none; transition: border-color .2s; }
.chat-input input:focus { border-color: var(--accent); }
.chat-input input::placeholder { color: var(--text3); }
.chat-input .btn { padding: 12px 18px; border-radius: var(--r-sm); font-size: 13px; }

/* ── Toast ── */
.toast { position: fixed; bottom: 100px; left: 50%; transform: translateX(-50%) translateY(20px); background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-sm); padding: 10px 20px; font-size: 13px; font-weight: 600; color: var(--text); box-shadow: var(--shadow-lg); opacity: 0; transition: all .3s ease; z-index: 999; pointer-events: none; }
.toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
.toast.success { border-color: var(--green); color: var(--green); }
.toast.error { border-color: var(--red); color: var(--red); }

/* ── Empty state ── */
.empty { text-align: center; padding: 24px 16px; color: var(--text3); }
.empty .icon { font-size: 36px; margin-bottom: 8px; }
.empty .msg { font-size: 13px; line-height: 1.5; }
.empty code { background: var(--surface2); padding: 2px 6px; border-radius: 4px; font-size: 12px; color: var(--accent); }

/* ── Skeleton loading ── */
.skeleton { background: linear-gradient(90deg, var(--surface) 25%, var(--surface2) 50%, var(--surface) 75%);
  background-size: 200% 100%; animation: shimmer 1.5s infinite; border-radius: var(--r-xs); }
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

/* ── Responsive ── */
@media (max-width: 360px) { .shell { padding-left: 12px; padding-right: 12px; } .card { padding: 12px; } }
</style>
</head>
<body>
<div class="shell">
  <div class="hdr">
    <h1><span>Boop</span></h1>
    <div class="sub">Your accountability friend</div>
  </div>

  <div class="card" id="chat-card">
    <div class="card-title">Connect</div>
    <div class="chat-input">
      <input id="chatId" placeholder="Telegram chat ID" inputmode="numeric" autocomplete="off" />
      <button class="btn btn-accent" onclick="load()" id="loadBtn">Go</button>
    </div>
  </div>

  <div id="content" style="display:none"></div>
</div>

<div class="toast" id="toast"></div>

<script>
const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); tg.setHeaderColor('#09090b'); tg.setBackgroundColor('#09090b'); }

let chat = '';
const $ = id => document.getElementById(id);
const esc = s => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };

function toast(msg, type='success') {
  const t = $('toast'); t.textContent = msg; t.className = 'toast ' + type + ' show';
  setTimeout(() => t.className = 'toast', 2200);
}

function haptic(style) { if (tg?.HapticFeedback) tg.HapticFeedback[style](); }

function pillHTML(t) { return '<span class="pill pill-'+t+'">'+t+'</span>'; }

function memoIcon(kind) {
  const icons = { person: '👤', goal: '🎯', preference: '⭐', routine: '🔄', contact: '📞', fact: '💡' };
  return '<div class="memo-icon '+kind+'">'+(icons[kind]||'💡')+'</div>';
}

function chartHTML(days) {
  if (!days || !days.length) return '';
  const max = Math.max(1, ...days.map(d => d.total || 0));
  return '<div class="chart">' + days.map(d => {
    const pct = d.total ? (d.done / d.total) * 100 : 0;
    const h = d.total ? Math.max(8, pct * 0.8) : 3;
    const cls = d.misses > 0 ? 'miss' : d.done > 0 ? 'done' : 'empty';
    return '<div class="col"><div class="val">'+( d.done||'')+'</div><div class="bar-bg"><div class="bar '+cls+'" style="height:'+h+'px"></div></div><div class="lbl">'+d.labels+'</div></div>';
  }).join('') + '</div>';
}

async function load() {
  chat = $('chatId').value.trim();
  if (!chat) return toast('Enter your chat ID', 'error');
  localStorage.setItem('boop_chat', chat);
  haptic('impactOccurred');
  $('loadBtn').textContent = '...';

  try {
    const r = await fetch('/api/folk/overview?chatId=' + encodeURIComponent(chat));
    const j = await r.json();
    const s = j.score;

    let html = '';

    /* streak hero */
    const topStreak = j.habits.length ? Math.max(...j.habits.map(h => h.streak)) : 0;
    html += '<div class="card"><div class="streak-hero"><div class="num">' + topStreak + '</div><div class="label">Best active streak</div></div></div>';

    /* stats */
    html += '<div class="stats">';
    html += '<div class="stat"><div class="n accent">' + s.pct + '%</div><div class="l">Accountability</div></div>';
    html += '<div class="stat"><div class="n green">' + s.done + '/' + s.scheduled + '</div><div class="l">Done this week</div></div>';
    html += '<div class="stat"><div class="n">' + j.habits.length + '</div><div class="l">Habits</div></div>';
    html += '<div class="stat"><div class="n">' + j.memories.length + '</div><div class="l">Memories</div></div>';
    html += '</div>';

    /* chart */
    if (j.days && j.days.length && j.days.some(d => d.total > 0)) {
      html += '<div class="card"><div class="card-title">7-Day Overview</div>' + chartHTML(j.days) + '</div>';
    }

    /* habits */
    html += '<div class="card"><div class="card-title">Habits</div>';
    if (j.habits.length) {
      j.habits.forEach(h => {
        html += '<div class="habit"><div class="habit-info">';
        html += '<div class="habit-name">' + esc(h.name) + '</div>';
        html += '<div class="habit-meta">' + pillHTML(h.tone);
        if (h.paused) html += pillHTML('paused');
        if (h.proofRequired) html += '<span>📸</span>';
        html += '<span>' + esc(h.daysLabel) + ' @ ' + esc(h.times.join(', ')) + '</span></div></div>';
        html += '<div class="habit-streak">🔥' + h.streak + '</div>';
        html += '<div class="habit-actions">';
        html += '<button class="btn btn-done" onclick="logHabit(\\'' + esc(h.name) + '\\',\\'done\\')">✓</button>';
        html += '<button class="btn btn-miss" onclick="logHabit(\\'' + esc(h.name) + '\\',\\'missed\\')">✗</button>';
        html += '<button class="btn btn-skip" onclick="togglePause(\\'' + esc(h.name) + '\\',\\'' + h.paused + '\\')">' + (h.paused ? '▶' : '⏸') + '</button>';
        html += '</div></div>';
      });
    } else {
      html += '<div class="empty"><div class="icon">🎯</div><div class="msg">No habits yet — <code>/habit gym daily 07:00</code></div></div>';
    }
    html += '</div>';

    /* packs */
    html += '<div class="card"><div class="card-title">Mini-Folks</div><div class="pack-grid">';
    j.packs.forEach(p => {
      html += '<div class="pack' + (p.hired ? ' hired' : '') + '" onclick="hire(\\'' + p.id + '\\')">';
      html += '<div class="emoji">' + p.emoji + '</div>';
      html += '<div class="name">' + esc(p.name) + '</div>';
      html += '<div class="tag">' + esc(p.tagline) + '</div>';
      if (p.hired) html += '<div class="hired-badge">✓ Active</div>';
      html += '</div>';
    });
    html += '</div></div>';

    /* memory */
    html += '<div class="card"><div class="card-title">Memory</div>';
    if (j.memories && j.memories.length) {
      j.memories.forEach(m => {
        html += '<div class="memo">' + memoIcon(m.kind);
        html += '<div class="memo-body"><div class="memo-label">' + esc(m.label) + '</div>';
        html += '<div class="memo-detail">' + esc(m.detail.slice(0, 140)) + '</div></div>';
        html += '<button class="memo-del" onclick="forget(\\'' + esc(m.label) + '\\')">✕</button></div>';
      });
    } else {
      html += '<div class="empty"><div class="icon">🧠</div><div class="msg">Nothing remembered yet — <code>/remember goal marathon : under 4h</code></div></div>';
    }
    html += '<div class="add-memo"><input id="mk" placeholder="kind" list="kinds" /><input id="ml" placeholder="label" /><input id="md" placeholder="detail" />';
    html += '<button class="btn btn-accent" onclick="remember()">+</button></div>';
    html += '<datalist id="kinds"><option value="person"/><option value="preference"/><option value="routine"/><option value="goal"/><option value="contact"/><option value="fact"/></datalist>';
    html += '</div>';

    /* briefing */
    html += '<div class="card"><div class="card-title">Morning Briefing</div>';
    html += '<div class="briefing-text" id="brief">Loading...</div>';
    html += '<button class="btn btn-skip" style="margin-top:10px;width:100%" onclick="brief()">Refresh</button></div>';

    $('content').innerHTML = html;
    $('content').style.display = '';
    $('chat-card').style.display = 'none';
    brief();
    toast('Dashboard loaded');
  } catch (e) {
    toast('Failed to load — check chat ID', 'error');
  }
  $('loadBtn').textContent = 'Go';
}

async function hire(p) {
  haptic('impactOccurred');
  const r = await fetch('/api/folk/hire', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({chatId:chat,userId:chat,packId:p})});
  const j = await r.json();
  toast(j.ok ? 'Hired!' : j.error, j.ok ? 'success' : 'error');
  load();
}

async function logHabit(n, st) {
  haptic('notificationOccurred');
  const r = await fetch('/api/folk/log', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({chatId:chat,name:n,status:st})});
  const j = await r.json();
  toast(st === 'done' ? '🔥 Logged!' : 'Marked missed', 'success');
  load();
}

async function togglePause(n, p) {
  haptic('impactOccurred');
  await fetch('/api/folk/pause', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({chatId:chat,name:n,paused:p==='true'})});
  load();
}

async function forget(l) {
  haptic('impactOccurred');
  await fetch('/api/folk/remember/' + encodeURIComponent(l), { method:'DELETE', headers:{'Content-Type':'application/json'}, body: JSON.stringify({chatId:chat})});
  toast('Forgot "' + l + '"');
  load();
}

async function remember() {
  const kind = $('mk').value || 'fact', label = $('ml').value, detail = $('md').value;
  if (!label || !detail) return toast('Need label + detail', 'error');
  haptic('notificationOccurred');
  await fetch('/api/folk/remember', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({chatId:chat,kind,label,detail})});
  toast('Remembered!');
  load();
}

async function brief() {
  if (!chat) return;
  const r = await fetch('/api/folk/briefing?chatId=' + encodeURIComponent(chat));
  const j = await r.json();
  const el = $('brief');
  if (el) el.textContent = j.briefing || 'No briefing today.';
}

(function(){ const c = localStorage.getItem('boop_chat'); if (c) { $('chatId').value = c; load(); } })();
<\/script>
</body>
</html>`;
}
