// AI insights plugin for MIDIScope.
//
// Strict plugin contract:
//   - Read-only with respect to the host: only inspects `getState()` and
//     calls `seekTo(t)` / `player.getTime()` / `player.isPlaying()`.
//   - Owns its own DOM (#panel-ai, #ai-settings-dialog) and never touches
//     other panels, the canvas, the renderer, or the player's audio path.
//   - Self-contained: if the panel HTML is missing, installAI() is a no-op
//     and the rest of the app keeps working.
//   - All persistent state lives under the `midivis.ai.*` localStorage
//     namespace.
//
// Nothing else in src/ should import from this file.

import { buildRows, toCSV } from "./dataExport.js";

// ---------------- localStorage helpers ----------------
const LS_PREFIX = "midivis.ai.";
const lsGet = (k, def = "") => {
  try { const v = localStorage.getItem(LS_PREFIX + k); return v == null ? def : v; }
  catch { return def; }
};
const lsSet = (k, v) => {
  try { localStorage.setItem(LS_PREFIX + k, v); } catch {}
};
const lsDel = (k) => { try { localStorage.removeItem(LS_PREFIX + k); } catch {} };

// ---------------- i18n ----------------
const I18N = {
  en: {
    panelTitle: "AI insights",
    notConfigured: "Configure an OpenAI-compatible API to enable AI features.",
    configure: "Settings",
    summarize: "Summarize piece",
    guide: "Generate listening guide",
    sections: "Detect sections (A/B/A')",
    explain: "Explain selection",
    chat: "Chat",
    exportReport: "Export report (.md)",
    print: "Print / Save as PDF",
    fromBar: "From bar",
    toBar: "to bar",
    placeholder: "Ask anything about this piece… e.g. \"Where is the climax?\"",
    send: "Send",
    clear: "Clear",
    follow: "Follow playhead",
    busy: "Working…",
    apiTitle: "AI settings",
    baseUrl: "API base URL",
    apiKey: "API key",
    model: "Model",
    temperature: "Temperature",
    maxTokens: "Max tokens",
    languageDefault: "Output language",
    save: "Save",
    cancel: "Cancel",
    test: "Test connection",
    keyHint: "Stored only in this browser's localStorage. Clear at any time.",
    copy: "Copy",
    copied: "Copied",
    jumpTo: "Jump to bar",
    nothingYet: "No output yet. Pick an action above.",
    needSong: "Load a MIDI file first.",
    error: "Error",
    sectionsHeading: "Sections",
    summaryHeading: "Summary",
    guideHeading: "Listening guide",
    selectionHeading: "Selection notes",
    chatHeading: "Conversation",
  },
  zh: {
    panelTitle: "AI 鉴赏",
    notConfigured: "请先配置 OpenAI 兼容接口以启用 AI 功能。",
    configure: "设置",
    summarize: "整曲总结",
    guide: "生成跟播解说",
    sections: "段落切分（A/B/A'）",
    explain: "解释所选小节",
    chat: "对话",
    exportReport: "导出鉴赏报告（.md）",
    print: "打印 / 另存为 PDF",
    fromBar: "从第",
    toBar: "到第",
    placeholder: "随便问，例如：\"高潮在哪里？\"",
    send: "发送",
    clear: "清空",
    follow: "跟随播放高亮",
    busy: "AI 思考中…",
    apiTitle: "AI 设置",
    baseUrl: "接口 Base URL",
    apiKey: "API Key",
    model: "模型",
    temperature: "Temperature",
    maxTokens: "最大 token 数",
    languageDefault: "输出语言",
    save: "保存",
    cancel: "取消",
    test: "测试连接",
    keyHint: "仅保存在本浏览器的 localStorage 中，可随时清除。",
    copy: "复制",
    copied: "已复制",
    jumpTo: "跳到第",
    nothingYet: "暂无内容。点击上方按钮开始。",
    needSong: "请先加载一个 MIDI 文件。",
    error: "出错",
    sectionsHeading: "段落",
    summaryHeading: "总结",
    guideHeading: "跟播解说",
    selectionHeading: "选段说明",
    chatHeading: "对话",
  },
};
let LANG = lsGet("ui_lang", "zh") === "en" ? "en" : "zh";
const t = (k) => (I18N[LANG] && I18N[LANG][k]) || I18N.en[k] || k;

// ---------------- minimal markdown renderer ----------------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function mdToHtml(md) {
  if (!md) return "";
  const lines = String(md).split(/\r?\n/);
  const out = [];
  let inCode = false, inUl = false, inOl = false;
  const flushLists = () => {
    if (inUl) { out.push("</ul>"); inUl = false; }
    if (inOl) { out.push("</ol>"); inOl = false; }
  };
  const inline = (s) => {
    s = escapeHtml(s);
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(?:^|[\s(])\*([^*\n]+)\*/g, (m, p) => m.replace("*" + p + "*", "<em>" + p + "</em>"));
    // Auto-link "bar 12" / "bars 12-16" / "第12小节" / "第12-16小节"
    s = s.replace(/\b(bars?)\s+(\d+)(?:\s*[-–]\s*(\d+))?\b/gi,
      (m, _w, a, b) => `<a class="ai-bar-link" data-bar="${a}" href="javascript:void(0)">${m}</a>`);
    s = s.replace(/第\s*(\d+)\s*(?:[-–~]\s*\d+\s*)?小节/g,
      (m, a) => `<a class="ai-bar-link" data-bar="${a}" href="javascript:void(0)">${m}</a>`);
    return s;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^```/.test(line)) {
      flushLists();
      if (!inCode) { out.push("<pre><code>"); inCode = true; }
      else { out.push("</code></pre>"); inCode = false; }
      continue;
    }
    if (inCode) { out.push(escapeHtml(line)); continue; }
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    if (h) { flushLists(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    const ul = line.match(/^\s*[-*]\s+(.+)$/);
    if (ul) {
      if (!inUl) { flushLists(); out.push("<ul>"); inUl = true; }
      out.push(`<li>${inline(ul[1])}</li>`); continue;
    }
    const ol = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ol) {
      if (!inOl) { flushLists(); out.push("<ol>"); inOl = true; }
      out.push(`<li>${inline(ol[1])}</li>`); continue;
    }
    if (!line.trim()) { flushLists(); out.push(""); continue; }
    flushLists();
    out.push(`<p>${inline(line)}</p>`);
  }
  flushLists();
  if (inCode) out.push("</code></pre>");
  return out.join("\n");
}

// ---------------- music-data summarizers ----------------
// Build a compact JSON-friendly digest of the loaded song so the AI
// gets enough harmonic / structural context without blowing up the
// prompt. Caps everything to keep token usage bounded.
function digestSong(state) {
  const s = state.song;
  if (!s) return null;
  const voices = (state.voices || []).map(v => ({
    label: v.label, kind: v.kind, notes: v.notes.length,
    range: v.notes.length ? [Math.min(...v.notes.map(n => n.midi)), Math.max(...v.notes.map(n => n.midi))] : null,
  }));
  const tempos = (s.tempos || []).slice(0, 16).map(x => ({ time: +x.time.toFixed(2), bpm: Math.round(x.bpm) }));
  const ts = (s.timeSignatures || []).map(x => ({ time: +x.time.toFixed(2), sig: `${x.numerator}/${x.denominator}` }));
  const keyTl = (state.keyTimeline || []).map(k => ({ bar: k.bar, time: +k.time.toFixed(2), key: `${k.tonic} ${k.mode}` }));
  // Compress chord events: keep at most ~120 events evenly distributed.
  const ce = state.chordEvents || [];
  const N = Math.min(ce.length, 160);
  const stride = ce.length > N ? ce.length / N : 1;
  const chords = [];
  for (let i = 0; i < N; i++) {
    const e = ce[Math.floor(i * stride)];
    if (!e) continue;
    chords.push({
      t: +e.time.toFixed(2),
      name: e.chordName || null,
      con: e.consonance,
    });
  }
  return {
    name: s.name,
    durationSec: +s.durationSec.toFixed(2),
    ppq: s.ppq,
    tempos,
    timeSignatures: ts,
    keyManual: state.keyManual,
    keyTimeline: keyTl,
    voices,
    chordCount: ce.length,
    chordsSampled: chords,
  };
}

// CSV-ish chord table at chord-change granularity, for the deeper prompts.
function chordTableCSV(state, opts = {}) {
  const { song, voices, chordEvents, keyManual } = state;
  if (!song || !voices) return "";
  try {
    const tab = buildRows(song, voices, {
      grouping: "chord",
      chordEvents,
      keySig: keyManual,
      columns: ["bar", "beat", "time", "chord_name", "chord_root", "consonance"],
      timeFormat: "sec",
      ...opts,
    });
    return toCSV(tab);
  } catch (e) {
    console.warn("[ai] chordTableCSV failed", e);
    return "";
  }
}

// Heuristic section split based on key changes + chord-density bursts.
// Pure JS, no AI call. The AI later just titles each segment.
function heuristicSections(state) {
  const s = state.song; if (!s) return [];
  const dur = s.durationSec;
  const ce = state.chordEvents || [];
  const kt = state.keyTimeline || [];
  // Start with key-change boundaries.
  const cuts = new Set([0]);
  for (const k of kt) cuts.add(k.time);
  // Add boundaries where chord density per 4-second window changes sharply.
  const win = 4;
  const buckets = Math.max(2, Math.ceil(dur / win));
  const dens = new Array(buckets).fill(0);
  for (const e of ce) {
    const i = Math.min(buckets - 1, Math.floor(e.time / win));
    dens[i]++;
  }
  for (let i = 1; i < buckets; i++) {
    const a = dens[i - 1], b = dens[i];
    const ratio = (b + 1) / (a + 1);
    if (ratio > 1.8 || ratio < 0.55) cuts.add(i * win);
  }
  const sorted = [...cuts].filter(t => t < dur - 1).sort((a, b) => a - b);
  // Merge overly short segments (< 6s).
  const merged = [sorted[0] ?? 0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - merged[merged.length - 1] >= 6) merged.push(sorted[i]);
  }
  // Cap at 8 sections.
  while (merged.length > 8) {
    let bestI = 1, bestGap = Infinity;
    for (let i = 1; i < merged.length; i++) {
      const gap = (merged[i] - merged[i - 1]);
      if (gap < bestGap) { bestGap = gap; bestI = i; }
    }
    merged.splice(bestI, 1);
  }
  const sections = [];
  for (let i = 0; i < merged.length; i++) {
    const start = merged[i];
    const end = (i + 1 < merged.length) ? merged[i + 1] : dur;
    sections.push({ index: i, start: +start.toFixed(2), end: +end.toFixed(2) });
  }
  // Annotate each with the active key + dominant chords.
  for (const sec of sections) {
    const k = kt.length ? kt.filter(x => x.time <= sec.start).pop() : null;
    sec.key = k ? `${k.tonic} ${k.mode}` : `${state.keyManual.tonic} ${state.keyManual.mode}`;
    const inSec = ce.filter(e => e.time >= sec.start && e.time < sec.end);
    const counts = new Map();
    for (const e of inSec) {
      if (!e.chordName) continue;
      counts.set(e.chordName, (counts.get(e.chordName) || 0) + 1);
    }
    sec.topChords = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, c]) => `${n}×${c}`);
    sec.bar = barOfTime(state.song, sec.start);
    sec.endBar = barOfTime(state.song, sec.end);
  }
  return sections;
}

function barOfTime(song, sec) {
  if (!song?.header) return 1;
  const tick = song.header.secondsToTicks(sec);
  const tsList = song.timeSignatures?.length ? song.timeSignatures
    : [{ ticks: 0, numerator: 4, denominator: 4, measures: 0 }];
  let active = tsList[0];
  for (const ts of tsList) { if ((ts.ticks ?? 0) <= tick) active = ts; else break; }
  const tpb = song.ppq * (4 / active.denominator);
  const tpm = tpb * active.numerator;
  const dt = tick - (active.ticks ?? 0);
  return Math.round(active.measures ?? 0) + Math.floor(dt / tpm) + 1;
}

function timeOfBar(song, bar) {
  if (!song?.header) return 0;
  const tsList = song.timeSignatures?.length ? song.timeSignatures
    : [{ ticks: 0, numerator: 4, denominator: 4, measures: 0 }];
  let active = tsList[0];
  for (const ts of tsList) {
    if ((ts.measures ?? 0) + 1 <= bar) active = ts; else break;
  }
  const tpb = song.ppq * (4 / active.denominator);
  const tpm = tpb * active.numerator;
  const barsInto = Math.max(0, bar - 1 - (active.measures ?? 0));
  const tick = (active.ticks ?? 0) + barsInto * tpm;
  return song.header.ticksToSeconds(tick);
}

// ---------------- LLM client ----------------
function getConfig() {
  return {
    baseUrl: lsGet("baseUrl", "https://api.openai.com/v1"),
    apiKey: lsGet("apiKey", ""),
    model: lsGet("model", "gpt-4o-mini"),
    temperature: parseFloat(lsGet("temperature", "0.7")),
    maxTokens: parseInt(lsGet("maxTokens", "1500"), 10),
    outLang: lsGet("outLang", "zh"),
  };
}

function isConfigured() {
  const c = getConfig();
  // Accept either a key, or a fully-qualified non-OpenAI URL (Ollama etc.)
  return !!c.apiKey || (!!c.baseUrl && !c.baseUrl.includes("api.openai.com"));
}

async function chatComplete({ system, user, signal, onChunk }) {
  const c = getConfig();
  const url = c.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const body = {
    model: c.model,
    temperature: c.temperature,
    max_tokens: c.maxTokens,
    stream: !!onChunk,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  const headers = { "Content-Type": "application/json" };
  if (c.apiKey) headers["Authorization"] = `Bearer ${c.apiKey}`;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg += " " + (j.error?.message || JSON.stringify(j)); }
    catch { try { msg += " " + (await res.text()); } catch {} }
    throw new Error(msg);
  }
  if (!onChunk) {
    const j = await res.json();
    return j.choices?.[0]?.message?.content || "";
  }
  // SSE streaming
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", full = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return full;
      try {
        const j = JSON.parse(data);
        const delta = j.choices?.[0]?.delta?.content || "";
        if (delta) { full += delta; onChunk(delta, full); }
      } catch {}
    }
  }
  return full;
}

// ---------------- prompt builders ----------------
function langInstruction() {
  const c = getConfig();
  return c.outLang === "en"
    ? "Reply in clear English."
    : "请用简体中文回答，语气像一位耐心的音乐鉴赏老师。";
}

function systemPrompt() {
  return [
    "You are an expert music analyst guiding a listener through a piece of MIDI music.",
    "You receive structured data: song metadata, key timeline, voice list, and a chord progression.",
    "Be concrete: cite bar numbers (e.g. \"bar 12\" or \"第12小节\") and chord names when relevant.",
    "Avoid hallucinating composer biography unless the song name strongly implies it.",
    "Prefer short paragraphs and bullet lists. Use Markdown.",
    langInstruction(),
  ].join(" ");
}

function summaryPrompt(state) {
  const dig = digestSong(state);
  const chords = chordTableCSV(state);
  return [
    "Provide a concise listening-companion summary of this piece.",
    "Cover (in this order): (1) overall character and likely style/period, (2) tonal plan and any modulations, (3) texture/instrumentation, (4) notable harmonic devices (cadences, sequences, borrowed chords, suspensions), (5) what to listen for emotionally. Keep it under ~350 words.",
    "",
    "## Song digest (JSON)",
    "```json",
    JSON.stringify(dig, null, 2),
    "```",
    "",
    "## Chord progression (CSV, chord-change granularity)",
    "```csv",
    chords.slice(0, 6000),
    "```",
  ].join("\n");
}

function sectionsPrompt(state, sections) {
  const dig = digestSong(state);
  return [
    "I have pre-segmented the piece into sections using key changes and chord density.",
    "For each section, give: a short evocative title (e.g. 'Opening theme', '主题再现'), a 1-sentence description, and a label like A / A' / B / Coda where appropriate.",
    "Return STRICTLY a JSON array of objects with fields {index, title, label, description}, one per input section, in the same order. No prose outside the JSON.",
    "",
    "## Sections (input)",
    "```json",
    JSON.stringify(sections, null, 2),
    "```",
    "",
    "## Song digest",
    "```json",
    JSON.stringify(dig, null, 2),
    "```",
  ].join("\n");
}

function guidePrompt(state, sections) {
  const dig = digestSong(state);
  const chords = chordTableCSV(state);
  return [
    "Write a 'listening guide' that will be displayed in sync with playback.",
    "I have pre-segmented the piece into the sections below. For EACH section, write 2-4 sentences that the listener should read while that section plays. Be specific about what they will hear: the texture, who has the melody, harmonic moves, dynamic gestures, and emotional arc.",
    "Return STRICTLY a JSON array of objects with fields {index, text}, one per section. No prose outside the JSON.",
    "",
    "## Sections",
    "```json",
    JSON.stringify(sections.map(s => ({ index: s.index, bar: s.bar, endBar: s.endBar, key: s.key, topChords: s.topChords })), null, 2),
    "```",
    "",
    "## Song digest",
    "```json",
    JSON.stringify(dig, null, 2),
    "```",
    "",
    "## Chord progression (CSV)",
    "```csv",
    chords.slice(0, 6000),
    "```",
  ].join("\n");
}

function selectionPrompt(state, fromBar, toBar) {
  const s = state.song;
  if (!s) return "";
  const t0 = timeOfBar(s, fromBar);
  const t1 = timeOfBar(s, toBar + 1);
  const ce = (state.chordEvents || []).filter(e => e.time >= t0 && e.time < t1);
  const slim = ce.map(e => ({
    bar: barOfTime(s, e.time), beat: null,
    name: e.chordName || null,
    con: e.consonance,
    members: e.members?.map(m => m.midi).slice(0, 8),
  }));
  return [
    `Explain in detail what is happening musically from bar ${fromBar} to bar ${toBar}.`,
    "Cover: harmonic function (Roman numerals if confident), voice-leading, melodic gesture, rhythmic profile, and how this passage relates to its surroundings.",
    "Cite bar numbers in your reply.",
    "",
    "## Active key context",
    "```json",
    JSON.stringify({ key: state.keyManual, timeline: state.keyTimeline }, null, 2),
    "```",
    "",
    "## Chords in selection",
    "```json",
    JSON.stringify(slim, null, 2),
    "```",
  ].join("\n");
}

function chatPrompt(state, history, userMsg) {
  const dig = digestSong(state);
  const lines = [
    "Continue the conversation about this piece. The user just asked a new question (last 'user' turn).",
    "Use the song context and prior turns. When suggesting a passage to listen to, cite bar numbers explicitly so the UI can wire jump-to-bar links.",
    "",
    "## Song digest",
    "```json",
    JSON.stringify(dig, null, 2),
    "```",
    "",
    "## Conversation so far",
  ];
  for (const m of history) {
    lines.push(`**${m.role === "user" ? "User" : "Assistant"}:** ${m.content}`);
  }
  lines.push(`**User:** ${userMsg}`);
  return lines.join("\n");
}

// ---------------- DOM building ----------------
const tag = (name, attrs = {}, children = []) => {
  const el = document.createElement(name);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k === "style") el.setAttribute("style", v);
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
};

// ---------------- main install ----------------
export function installAI({ getState, player, seekTo }) {
  const panel = document.getElementById("panel-ai");
  if (!panel) {
    console.warn("[ai] #panel-ai not in DOM; AI plugin disabled.");
    return;
  }
  const dialog = document.getElementById("ai-settings-dialog");
  const $ = (id) => document.getElementById(id);

  // -------- panel UI --------
  const refresh = () => {
    panel.querySelector("summary").firstChild.textContent = t("panelTitle") + " ";
    $("ai-lang-toggle").textContent = LANG === "zh" ? "EN" : "中";
    $("ai-settings-btn").textContent = "⚙ " + t("configure");
    $("ai-btn-summarize").textContent = t("summarize");
    $("ai-btn-guide").textContent = t("guide");
    $("ai-btn-sections").textContent = t("sections");
    $("ai-btn-explain").textContent = t("explain");
    $("ai-btn-export").textContent = "⬇ " + t("exportReport");
    $("ai-btn-print").textContent = t("print");
    $("ai-from-label").textContent = t("fromBar");
    $("ai-to-label").textContent = t("toBar");
    $("ai-chat-input").placeholder = t("placeholder");
    $("ai-chat-send").textContent = t("send");
    $("ai-chat-clear").textContent = t("clear");
    $("ai-follow-label").lastChild.textContent = " " + t("follow");
    if (!ui.outputHasContent) $("ai-output").innerHTML =
      `<p class="ai-empty">${escapeHtml(t("nothingYet"))}</p>`;
    $("ai-banner").textContent = isConfigured() ? "" : t("notConfigured");
    $("ai-banner").style.display = isConfigured() ? "none" : "";
  };

  const ui = {
    outputHasContent: false,
    sections: [],
    sectionTitles: [],
    guideTexts: [],
    chatHistory: [],
    activeRequest: null,
    followGuide: false,
  };

  // Build panel body
  const body = panel.querySelector(".panel-body");
  body.innerHTML = "";

  const banner = tag("div", { id: "ai-banner", class: "ai-banner status-note" });
  body.appendChild(banner);

  const headerRow = tag("div", { class: "ai-row" }, [
    tag("button", {
      id: "ai-settings-btn", class: "ai-btn",
      onclick: () => openSettings(),
    }),
    tag("button", {
      id: "ai-lang-toggle", class: "ai-btn ai-btn-mini",
      title: "Switch language / 切换语言",
      onclick: () => { LANG = LANG === "zh" ? "en" : "zh"; lsSet("ui_lang", LANG); refresh(); rerenderOutput(); },
    }),
  ]);
  body.appendChild(headerRow);

  const actions = tag("div", { class: "ai-actions" }, [
    tag("button", { id: "ai-btn-summarize", class: "ai-btn ai-primary",
      onclick: () => runSummarize() }),
    tag("button", { id: "ai-btn-sections", class: "ai-btn",
      onclick: () => runSections() }),
    tag("button", { id: "ai-btn-guide", class: "ai-btn",
      onclick: () => runGuide() }),
  ]);
  body.appendChild(actions);

  // Selection range
  const selRow = tag("div", { class: "ai-row ai-sel-row" }, [
    tag("span", { id: "ai-from-label", class: "ai-mini-label" }),
    tag("input", { id: "ai-sel-from", type: "number", min: "1", value: "1", class: "ai-num" }),
    tag("span", { id: "ai-to-label", class: "ai-mini-label" }),
    tag("input", { id: "ai-sel-to", type: "number", min: "1", value: "8", class: "ai-num" }),
    tag("button", { id: "ai-btn-explain", class: "ai-btn ai-btn-mini",
      onclick: () => runExplain() }),
  ]);
  body.appendChild(selRow);

  // Follow checkbox
  const followLabel = tag("label", { id: "ai-follow-label", class: "field row-inline" }, [
    tag("input", {
      id: "ai-follow", type: "checkbox",
      onchange: (e) => { ui.followGuide = e.target.checked; },
    }),
    document.createTextNode(""),
  ]);
  body.appendChild(followLabel);

  // Output area
  const output = tag("div", { id: "ai-output", class: "ai-output" });
  body.appendChild(output);

  // Sections list (rendered after sections detected)
  const sectionsWrap = tag("div", { id: "ai-sections-wrap", class: "ai-sections-wrap" });
  body.appendChild(sectionsWrap);

  // Chat
  const chatPanel = tag("details", { class: "subpanel" }, [
    tag("summary", {}, [
      tag("span", { class: "caret", "aria-hidden": "true" }),
      tag("span", { class: "sub-title", id: "ai-chat-heading" }, t("chat")),
    ]),
    tag("div", { id: "ai-chat-log", class: "ai-chat-log" }),
    tag("div", { class: "ai-row" }, [
      tag("input", { id: "ai-chat-input", type: "text", class: "ai-text-input" }),
      tag("button", { id: "ai-chat-send", class: "ai-btn ai-btn-mini ai-primary",
        onclick: () => runChatSend() }),
    ]),
    tag("div", { class: "ai-row ai-row-end" }, [
      tag("button", { id: "ai-chat-clear", class: "ai-btn ai-btn-mini",
        onclick: () => { ui.chatHistory = []; renderChat(); } }),
    ]),
  ]);
  body.appendChild(chatPanel);

  // Export row
  const exportRow = tag("div", { class: "ai-row" }, [
    tag("button", { id: "ai-btn-export", class: "ai-btn ai-btn-mini",
      onclick: () => exportReport() }),
    tag("button", { id: "ai-btn-print", class: "ai-btn ai-btn-mini",
      onclick: () => printReport() }),
  ]);
  body.appendChild(exportRow);

  // Enter to send in chat
  body.addEventListener("keydown", (e) => {
    if (e.target?.id === "ai-chat-input" && e.key === "Enter") {
      e.preventDefault();
      runChatSend();
    }
  });

  // Bar-link delegation
  body.addEventListener("click", (e) => {
    const a = e.target.closest?.(".ai-bar-link");
    if (!a) return;
    const bar = parseInt(a.dataset.bar, 10);
    const st = getState();
    if (!st.song || !Number.isFinite(bar)) return;
    const tm = timeOfBar(st.song, bar);
    seekTo(tm);
  });
  // Section jump delegation
  sectionsWrap.addEventListener("click", (e) => {
    const a = e.target.closest?.("[data-jump-time]");
    if (!a) return;
    seekTo(parseFloat(a.dataset.jumpTime));
  });

  // -------- settings dialog --------
  if (dialog) {
    dialog.addEventListener("close", () => { /* nothing */ });
    $("ai-set-save").addEventListener("click", (e) => {
      e.preventDefault();
      lsSet("baseUrl", $("ai-set-baseurl").value.trim() || "https://api.openai.com/v1");
      lsSet("apiKey", $("ai-set-apikey").value.trim());
      lsSet("model", $("ai-set-model").value.trim() || "gpt-4o-mini");
      lsSet("temperature", $("ai-set-temp").value);
      lsSet("maxTokens", $("ai-set-maxtok").value);
      lsSet("outLang", $("ai-set-lang").value);
      dialog.close();
      refresh();
    });
    $("ai-set-cancel").addEventListener("click", (e) => { e.preventDefault(); dialog.close(); });
    $("ai-set-test").addEventListener("click", async (e) => {
      e.preventDefault();
      const status = $("ai-set-status");
      status.textContent = "…";
      // Save first, so the test uses the values currently in the form.
      lsSet("baseUrl", $("ai-set-baseurl").value.trim() || "https://api.openai.com/v1");
      lsSet("apiKey", $("ai-set-apikey").value.trim());
      lsSet("model", $("ai-set-model").value.trim() || "gpt-4o-mini");
      try {
        const out = await chatComplete({
          system: "You are a connection test.",
          user: "Reply with the single word: OK",
        });
        status.textContent = "✓ " + (out || "(empty)").slice(0, 80);
      } catch (err) {
        status.textContent = "✗ " + (err.message || String(err));
      }
    });
  }

  function openSettings() {
    if (!dialog) return alert("Settings dialog missing in HTML.");
    $("ai-set-baseurl").value = lsGet("baseUrl", "https://api.openai.com/v1");
    $("ai-set-apikey").value = lsGet("apiKey", "");
    $("ai-set-model").value = lsGet("model", "gpt-4o-mini");
    $("ai-set-temp").value = lsGet("temperature", "0.7");
    $("ai-set-maxtok").value = lsGet("maxTokens", "1500");
    $("ai-set-lang").value = lsGet("outLang", "zh");
    $("ai-set-status").textContent = "";
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  // -------- output helpers --------
  let lastReportSections = []; // for export

  function setOutput(html, opts = {}) {
    output.innerHTML = html;
    ui.outputHasContent = true;
    if (opts.heading) lastReportSections.push({ heading: opts.heading, html });
  }
  function appendOutput(html) {
    output.insertAdjacentHTML("beforeend", html);
    ui.outputHasContent = true;
  }
  function rerenderOutput() {
    if (!ui.outputHasContent) {
      output.innerHTML = `<p class="ai-empty">${escapeHtml(t("nothingYet"))}</p>`;
    }
  }
  function showBusy(label) {
    const id = "ai-busy-" + Math.random().toString(36).slice(2, 7);
    appendOutput(`<p class="ai-busy" id="${id}"><em>${escapeHtml(label || t("busy"))}</em></p>`);
    return id;
  }
  function removeBusy(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
  }
  function showError(err) {
    appendOutput(`<p class="ai-error"><strong>${t("error")}:</strong> ${escapeHtml(err.message || String(err))}</p>`);
  }
  function ensureSong() {
    const st = getState();
    if (!st.song) { setOutput(`<p class="ai-empty">${escapeHtml(t("needSong"))}</p>`); return null; }
    if (!isConfigured()) { setOutput(`<p class="ai-empty">${escapeHtml(t("notConfigured"))}</p>`); return null; }
    return st;
  }

  // -------- actions --------
  async function runSummarize() {
    const st = ensureSong(); if (!st) return;
    setOutput(`<h3>${escapeHtml(t("summaryHeading"))}</h3><div id="ai-stream"></div>`);
    lastReportSections = [{ heading: t("summaryHeading"), html: "" }];
    const target = document.getElementById("ai-stream");
    const busyId = showBusy();
    let acc = "";
    try {
      await chatComplete({
        system: systemPrompt(),
        user: summaryPrompt(st),
        onChunk: (_d, full) => { acc = full; target.innerHTML = mdToHtml(full); },
      });
      lastReportSections[0].html = `<h3>${escapeHtml(t("summaryHeading"))}</h3>` + mdToHtml(acc);
    } catch (err) { showError(err); }
    finally { removeBusy(busyId); }
  }

  async function runSections() {
    const st = ensureSong(); if (!st) return;
    const sections = heuristicSections(st);
    if (!sections.length) { setOutput(`<p class="ai-empty">${escapeHtml(t("needSong"))}</p>`); return; }
    setOutput(`<h3>${escapeHtml(t("sectionsHeading"))}</h3><p><em>${escapeHtml(t("busy"))}</em></p>`);
    try {
      const reply = await chatComplete({
        system: systemPrompt() + " You must reply with valid JSON only when asked.",
        user: sectionsPrompt(st, sections),
      });
      const arr = parseJsonLoose(reply);
      ui.sections = sections;
      ui.sectionTitles = Array.isArray(arr) ? arr : [];
      renderSections();
      lastReportSections = [{
        heading: t("sectionsHeading"),
        html: sectionsWrap.innerHTML,
      }];
      output.innerHTML = `<h3>${escapeHtml(t("sectionsHeading"))}</h3>`;
    } catch (err) { showError(err); }
  }

  async function runGuide() {
    const st = ensureSong(); if (!st) return;
    let sections = ui.sections;
    if (!sections.length) sections = heuristicSections(st);
    ui.sections = sections;
    setOutput(`<h3>${escapeHtml(t("guideHeading"))}</h3><p><em>${escapeHtml(t("busy"))}</em></p>`);
    try {
      const reply = await chatComplete({
        system: systemPrompt() + " You must reply with valid JSON only when asked.",
        user: guidePrompt(st, sections),
      });
      const arr = parseJsonLoose(reply);
      ui.guideTexts = Array.isArray(arr) ? arr.map(o => o.text || "") : [];
      renderSections();
      lastReportSections = [{
        heading: t("guideHeading"),
        html: sectionsWrap.innerHTML,
      }];
      output.innerHTML = `<h3>${escapeHtml(t("guideHeading"))}</h3>`;
      // Auto-enable follow.
      const fb = $("ai-follow"); if (fb && !fb.checked) { fb.checked = true; ui.followGuide = true; }
    } catch (err) { showError(err); }
  }

  async function runExplain() {
    const st = ensureSong(); if (!st) return;
    const from = parseInt($("ai-sel-from").value, 10) || 1;
    const to = Math.max(from, parseInt($("ai-sel-to").value, 10) || from);
    setOutput(`<h3>${escapeHtml(t("selectionHeading"))} (bar ${from} – ${to})</h3><div id="ai-stream"></div>`);
    const target = document.getElementById("ai-stream");
    const busyId = showBusy();
    let acc = "";
    try {
      await chatComplete({
        system: systemPrompt(),
        user: selectionPrompt(st, from, to),
        onChunk: (_d, full) => { acc = full; target.innerHTML = mdToHtml(full); },
      });
      lastReportSections = [{
        heading: `${t("selectionHeading")} (bar ${from} – ${to})`,
        html: `<h3>${t("selectionHeading")} (bar ${from} – ${to})</h3>` + mdToHtml(acc),
      }];
    } catch (err) { showError(err); }
    finally { removeBusy(busyId); }
  }

  async function runChatSend() {
    const st = ensureSong(); if (!st) return;
    const inp = $("ai-chat-input");
    const msg = inp.value.trim();
    if (!msg) return;
    inp.value = "";
    ui.chatHistory.push({ role: "user", content: msg });
    renderChat();
    const target = renderChatPlaceholder();
    let acc = "";
    try {
      await chatComplete({
        system: systemPrompt(),
        user: chatPrompt(st, ui.chatHistory.slice(0, -1), msg),
        onChunk: (_d, full) => { acc = full; target.innerHTML = mdToHtml(full); },
      });
      ui.chatHistory.push({ role: "assistant", content: acc });
      renderChat();
    } catch (err) {
      target.innerHTML = `<span class="ai-error">${escapeHtml(err.message || String(err))}</span>`;
    }
  }

  function renderChat() {
    const log = $("ai-chat-log");
    if (!log) return;
    log.innerHTML = "";
    for (const m of ui.chatHistory) {
      const bubble = tag("div", { class: `ai-bubble ai-${m.role}` }, []);
      bubble.innerHTML = m.role === "user"
        ? `<strong>·</strong> ${escapeHtml(m.content)}`
        : mdToHtml(m.content);
      log.appendChild(bubble);
    }
    log.scrollTop = log.scrollHeight;
  }
  function renderChatPlaceholder() {
    const log = $("ai-chat-log");
    const bubble = tag("div", { class: "ai-bubble ai-assistant" }, []);
    bubble.innerHTML = `<em>${t("busy")}</em>`;
    log.appendChild(bubble);
    log.scrollTop = log.scrollHeight;
    return bubble;
  }

  function renderSections() {
    sectionsWrap.innerHTML = "";
    if (!ui.sections.length) return;
    for (let i = 0; i < ui.sections.length; i++) {
      const sec = ui.sections[i];
      const tt = ui.sectionTitles[i] || {};
      const guide = ui.guideTexts[i] || "";
      const card = tag("div", { class: "ai-section-card", "data-i": String(i),
        "data-start": String(sec.start), "data-end": String(sec.end) }, []);
      card.innerHTML = `
        <div class="ai-section-head">
          <a href="javascript:void(0)" data-jump-time="${sec.start}" class="ai-section-jump">▶</a>
          <span class="ai-section-label">${escapeHtml(tt.label || `S${i + 1}`)}</span>
          <span class="ai-section-title">${escapeHtml(tt.title || "")}</span>
          <span class="ai-section-bars">bar ${sec.bar}–${sec.endBar} · ${escapeHtml(sec.key)}</span>
        </div>
        ${tt.description ? `<div class="ai-section-desc">${escapeHtml(tt.description)}</div>` : ""}
        ${guide ? `<div class="ai-section-guide">${mdToHtml(guide)}</div>` : ""}
      `;
      sectionsWrap.appendChild(card);
    }
  }

  // -------- guide follow loop --------
  let lastActive = -1;
  function followTick() {
    if (ui.followGuide && ui.sections.length) {
      const t = player.getTime();
      let active = -1;
      for (let i = 0; i < ui.sections.length; i++) {
        if (t >= ui.sections[i].start && t < ui.sections[i].end) { active = i; break; }
      }
      if (active !== lastActive) {
        lastActive = active;
        const cards = sectionsWrap.querySelectorAll(".ai-section-card");
        cards.forEach((c, i) => c.classList.toggle("ai-active", i === active));
        if (active >= 0) {
          const c = cards[active];
          if (c) c.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
      }
    }
    requestAnimationFrame(followTick);
  }
  requestAnimationFrame(followTick);

  // -------- export --------
  function buildReportMd() {
    const st = getState();
    const lines = [];
    lines.push(`# ${st.song?.name || "MIDI"} — ${t("panelTitle")}`);
    lines.push("");
    lines.push(`*Generated by MIDIScope on ${new Date().toLocaleString()}*`);
    lines.push("");
    if (lastReportSections.length) {
      for (const s of lastReportSections) {
        lines.push("## " + s.heading);
        lines.push("");
        lines.push(htmlToText(s.html));
        lines.push("");
      }
    }
    if (ui.sections.length) {
      lines.push("## " + t("sectionsHeading"));
      for (let i = 0; i < ui.sections.length; i++) {
        const sec = ui.sections[i];
        const tt = ui.sectionTitles[i] || {};
        const guide = ui.guideTexts[i] || "";
        lines.push(`### [${tt.label || "S" + (i + 1)}] ${tt.title || ""} — bar ${sec.bar}–${sec.endBar} (${sec.key})`);
        if (tt.description) lines.push(tt.description);
        if (guide) { lines.push(""); lines.push(guide); }
        lines.push("");
      }
    }
    if (ui.chatHistory.length) {
      lines.push("## " + t("chatHeading"));
      for (const m of ui.chatHistory) {
        lines.push(`**${m.role === "user" ? "User" : "Assistant"}:** ${m.content}`);
        lines.push("");
      }
    }
    return lines.join("\n");
  }
  function htmlToText(html) {
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    return tmp.innerText || tmp.textContent || "";
  }
  function exportReport() {
    const md = buildReportMd();
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const name = (getState().song?.name || "midivis").replace(/[\\/:*?"<>|]/g, "_");
    a.download = `${name}.ai-report.md`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
  }
  function printReport() {
    const md = buildReportMd();
    const html = mdToHtml(md);
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(getState().song?.name || "MIDI")} — AI report</title>
      <style>
        body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;max-width:780px;margin:40px auto;padding:0 20px;color:#16181d;}
        h1,h2,h3{line-height:1.3} h1{border-bottom:2px solid #6366f1;padding-bottom:6px}
        h3{margin-top:1.6em} pre{background:#f1f3f8;padding:10px;border-radius:8px;overflow:auto;font-size:12px}
        code{background:#f1f3f8;padding:1px 5px;border-radius:4px;font-size:0.92em}
        a{color:#6366f1}
        @media print { a{color:inherit;text-decoration:none} }
      </style></head><body>${html}</body></html>`);
    w.document.close();
    setTimeout(() => { try { w.print(); } catch {} }, 250);
  }

  // -------- helpers --------
  function parseJsonLoose(s) {
    if (!s) return null;
    // Strip ```json fences
    const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = m ? m[1] : s;
    try { return JSON.parse(candidate); }
    catch {
      // Try first [...] block
      const a = candidate.indexOf("[");
      const b = candidate.lastIndexOf("]");
      if (a >= 0 && b > a) {
        try { return JSON.parse(candidate.slice(a, b + 1)); } catch {}
      }
      return null;
    }
  }

  // Initial paint
  refresh();
}
