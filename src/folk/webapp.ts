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
    const days = weekStreakData();
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

function weekStreakData(): { labels: string; total: number; done: number; misses: number }[] {
  const now = new Date();
  const labels: string[] = [];
  const total: number[] = [];
  const done: number[] = [];
  const misses: number[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    labels.push(d.toLocaleDateString("en", { weekday: "short" }));
    total.push(0); done.push(0); misses.push(0);
  }
  return labels.map((l, i) => ({ labels: l, total: total[i], done: done[i], misses: misses[i] }));
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
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 16px; max-width: 680px; background: #fafafa; color: #111; }
  @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } .card { background: #1a1a1a; border-color: #333; } }
  h1 { font-size: 24px; margin: 0 0 2px; letter-spacing: -0.5px; }
  .tag { display: inline-block; background: #6366f1; color: #fff; font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 600; margin-left: 6px; vertical-align: middle; }
  .sub { opacity: .65; font-size: 13px; margin-bottom: 14px; }
  .card { background: #fff; border: 1px solid #e5e5e5; border-radius: 14px; padding: 14px; margin: 10px 0; }
  .row { display: flex; gap: 8px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
  button { border: 0; border-radius: 10px; padding: 8px 14px; font-weight: 600; cursor: pointer; font-size: 13px; transition: opacity .15s; }
  button:hover { opacity: .85; }
  .done { background: #22c55e; color: #fff; } .miss { background: #ef4444; color: #fff; } .skip { background: #94a3b8; color: #fff; }
  .streak { font-weight: 700; font-size: 15px; }
  .big-streak { font-size: 42px; font-weight: 800; text-align: center; margin: 8px 0; }
  .mini { font-size: 12px; opacity: .7; }
  input, select { padding: 10px; border-radius: 10px; border: 1px solid #d4d4d8; width: 100%; margin: 4px 0; font-size: 14px; }
  pre { white-space: pre-wrap; font-size: 13px; margin: 0; }
  .bar-wrap { height: 8px; background: #e5e5e5; border-radius: 99px; overflow: hidden; margin: 6px 0; }
  .bar { height: 100%; border-radius: 99px; background: linear-gradient(90deg, #22c55e, #6366f1); transition: width .4s; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .stat { text-align: center; padding: 10px; background: #f4f4f5; border-radius: 12px; }
  .stat .n { font-size: 22px; font-weight: 700; }
  .stat .l { font-size: 11px; opacity: .65; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .pill-gentle { background: #d1fae5; color: #065f46; } .pill-steady { background: #dbeafe; color: #1e40af; }
  .pill-firm { background: #fef3c7; color: #92400e; } .pill-relentless { background: #fee2e2; color: #991b1b; }
  .pill-paused { background: #f1f5f9; color: #64748b; }
  .habit-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #f0f0f0; }
  .habit-row:last-child { border-bottom: none; }
  .hire-btn { background: #6366f1; color: #fff; }
  .memo { padding: 8px 10px; background: #f8fafc; border-radius: 10px; margin: 4px 0; font-size: 13px; }
  .memo .kind { font-size: 11px; opacity: .6; text-transform: uppercase; }
  .chart { display: flex; align-items: flex-end; gap: 4px; height: 48px; margin: 8px 0; }
  .chart .b { flex: 1; border-radius: 4px 4px 0 0; min-height: 4px; background: #6366f1; opacity: .3; }
  .chart .b.done { opacity: 1; }
  .chart .b.miss { background: #ef4444; }
</style>
</head>
<body>
<h1>🔥 Boop <span class="tag">PRO</span></h1>
<div class="sub">Your accountability friend — better than folk.com: tones, proof, streaks, charts.</div>
<div class="card">
  <div class="row"><strong>Chat</strong></div>
  <input id="chatId" placeholder="Telegram chat id" inputmode="numeric" />
  <button class="hire-btn" onclick="load()">Load dashboard</button>
</div>
<div id="stats"></div>
<div id="chart-card" class="card" style="display:none"><strong>7-day chart</strong><div id="chart"></div><div class="mini" id="chart-label"></div></div>
<div id="habits"></div>
<div class="card"><strong>🛍️ Mini-folks</strong><div id="packs" class="sub">Load your chat to see the gallery.</div></div>
<div class="card"><strong>🧠 Memory</strong><div id="mem"></div><div style="margin-top:8px"><input id="memo-kind" list="kinds" placeholder="kind" style="width:120px" /><input id="memo-label" placeholder="label" style="width:160px" /><input id="memo-detail" placeholder="detail" style="width:240px" /><button class="hire-btn" onclick="remember()">remember</button></div><datalist id="kinds"><option value="person"/><option value="preference"/><option value="routine"/><option value="goal"/><option value="contact"/><option value="fact"/></datalist></div>
<div class="card"><strong>☀️ Briefing</strong><pre id="brief"></pre><button class="hire-btn" onclick="brief()">Refresh briefing</button></div>
<script>
const tg = window.Telegram?.WebApp; if (tg) { tg.ready(); tg.expand(); }
let chat = "";
function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function pill(t) { return "<span class='pill pill-'+t>"+t+"</span>"; }
async function load() {
  chat = document.getElementById("chatId").value.trim();
  if (!chat) return alert("Enter your chat id.");
  localStorage.setItem("boop_chat", chat);
  const r = await fetch("/api/folk/overview?chatId="+encodeURIComponent(chat));
  const j = await r.json();
  const s = j.score;
  document.getElementById("stats").innerHTML =
    '<div class="grid">' +
      '<div class="stat"><div class="n">'+s.pct+'%</div><div class="l">Accountability</div></div>' +
      '<div class="stat"><div class="n">'+s.done+'/'+s.scheduled+'</div><div class="l">Done this week</div></div>' +
      '<div class="stat"><div class="n">'+j.habits.length+'</div><div class="l">Habits</div></div>' +
      '<div class="stat"><div class="n">'+j.memories.length+'</div><div class="l">Memories</div></div>' +
    '</div>';
  const card = document.getElementById("chart-card");
  if (j.days && j.days.length) {
    card.style.display = "";
    document.getElementById("chart").innerHTML = j.days.map(d => {
      const h = d.done||1;
      return '<div class="bar '+(d.misses?'miss':'done')+'" style="height:'+Math.max(8,h*24)+'px" title="'+d.labels+': '+d.done+'/'+d.total+'"></div>';
    }).join("");
    document.getElementById("chart-label").textContent = "7 days — green = done, red = miss";
  }
  const hh = j.habits;
  document.getElementById("habits").innerHTML = hh.length
    ? hh.map(h => '<div class="habit-row"><div><strong>'+esc(h.name)+'</strong> <span class="mini">'+esc(h.daysLabel)+' @ '+esc(h.times.join(", "))+'</span><br>'+pill(h.tone)+(h.paused?' '+pill('paused'):'')+(h.proofRequired?' 📸':'')+'</div><span class="streak">🔥'+h.streak+'</span><div style="display:flex;gap:4px"><button class="done" onclick="logHabit(\\''+esc(h.name)+'\\',\\'done\\')">DONE</button><button class="miss" onclick="logHabit(\\''+esc(h.name)+'\\',\\'missed\\')">miss</button><button class="skip" onclick="togglePause(\\''+esc(h.name)+'\\',\\'\\'+h.paused+'\\')">'+(h.paused?"resume":"pause")+'</button></div></div>').join("")
    : '<div class="card">No habits yet — <code>/habit gym daily 07:00</code></div>';
  document.getElementById("mem").innerHTML = (j.memories||[]).map(m => '<div class="memo"><span class="kind">'+m.kind+'</span> <strong>'+esc(m.label)+'</strong>: '+esc(m.detail.slice(0,120))+' <button style="padding:2px 6px;font-size:11px;background:#fee2e2;border:0;border-radius:6px;cursor:pointer" onclick="forget(\\''+esc(m.label)+'\\')">✕</button></div>').join("") || '<div class="mini">Nothing remembered yet — <code>/remember goal x : detail</code></div>';
  document.getElementById("packs").innerHTML = j.packs.map(p =>
    '<div class="habit-row"><div>'+p.emoji+' <strong>'+esc(p.name)+'</strong><br><span class="mini">'+esc(p.tagline)+'</span></div>'+(p.hired?'<span style="color:#22c55e;font-weight:700">✅ hired</span>':'<button class="hire-btn" onclick="hire(\\''+p.id+'\\')">Hire</button>')+'</div>'
  ).join("") || '<div class="card">No packs yet.</div>';
  brief();
}
async function hire(p) { const r = await fetch("/api/folk/hire",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chatId:chat,userId:chat,packId:p})}); await load(); }
async function logHabit(n,st) { const r = await fetch("/api/folk/log",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chatId:chat,name:n,status:st})}); const j=await r.json(); load(); if(j.score) showScore(j.score); }
async function togglePause(n,p) { const r = await fetch("/api/folk/pause",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chatId:chat,name:n,paused:p==="true"})}); await load(); }
function forget(l) { fetch("/api/folk/remember/"+encodeURIComponent(l),{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({chatId:chat})}); load(); }
async function remember() { const kind=document.getElementById("memo-kind").value, label=document.getElementById("memo-label").value, detail=document.getElementById("memo-detail").value; if(!label||!detail)return alert("label + detail"); await fetch("/api/folk/remember",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chatId:chat,kind:kind,label,detail})}); load(); }
async function brief() { if(!chat)return; const r=await fetch("/api/folk/briefing?chatId="+encodeURIComponent(chat)); const j=await r.json(); document.getElementById("brief").textContent=j.briefing||""; }
function showScore(s) { const st=document.getElementById("stats"); st.innerHTML='<div class="grid"><div class="stat"><div class="n">'+s.pct+'%</div><div class="l">Accountability</div></div><div class="stat"><div class="n">'+s.done+'/'+s.scheduled+'</div><div class="l">Done</div></div></div>'; }
(function(){const c=localStorage.getItem("boop_chat");if(c){document.getElementById("chatId").value=c;load();}})();
</script>
</body>
</html>`;
}
