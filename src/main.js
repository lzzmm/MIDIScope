import { loadMidiFromUrl, loadMidiFromFile } from "./midiLoader.js";
import { buildVoices } from "./voicing.js";
import { Renderer, KEYS_W, RULER_H, PRESETS, DEFAULT_LAYERS } from "./render.js";
import { Player } from "./player.js";

const state = {
  song: null,
  voices: [],
  handThreshold: 60,
};

const $ = (id) => document.getElementById(id);
const canvas = $("canvas");
const minimap = $("minimap");
const tooltip = $("tooltip");
const renderer = new Renderer(canvas, minimap);
const player = new Player();

// ---------- bootstrapping ----------
init();

async function init() {
  bindUI();
  renderer.start();
  // Try to load default file (works when served via http(s); fails over to drop hint on file://).
  try {
    const song = await loadMidiFromUrl("midi/Satie-Gymnopedie1-flute-piano.mid");
    setSong(song);
  } catch (err) {
    console.warn("Default MIDI not loaded; please open or drop a .mid file.", err);
  }
}

function setSong(song) {
  state.song = song;
  state.voices = buildVoices(song, state.handThreshold);
  renderer.setSong(song, state.voices);
  player.load(state.voices, song.durationSec);
  renderVoicesPanel();
  renderLayersPanel();
  updateTimeReadout();
}

function rebuildVoices() {
  if (!state.song) return;
  state.voices = buildVoices(state.song, state.handThreshold);
  renderer.setVoices(state.voices);
  player.load(state.voices, state.song.durationSec);
  renderVoicesPanel();
}

// ---------- UI ----------
function bindUI() {
  bindCollapsiblePanels();
  bindHoverTips();
  bindDataExport();
  // Play/Pause
  $("btn-play").addEventListener("click", togglePlay);
  $("btn-stop").addEventListener("click", () => {
    player.stop();
    renderer.setPlayhead(0);
    updateSeek(0);
  });
  document.addEventListener("keydown", e => {
    if (e.target.tagName === "INPUT") return;
    if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  });

  // Seek slider
  const seek = $("seek");
  seek.addEventListener("input", () => {
    if (!state.song) return;
    const t = (seek.value / 1000) * state.song.durationSec;
    player.seek(t);
    renderer.setPlayhead(t);
  });

  // Speed
  const speed = $("speed");
  speed.addEventListener("input", () => {
    const v = parseFloat(speed.value);
    player.setSpeed(v);
    $("speed-val").textContent = v.toFixed(2) + "×";
  });

  // Volume
  const vol = $("vol");
  vol.addEventListener("input", () => {
    const v = parseFloat(vol.value);
    player.setMasterDb(v);
    $("vol-val").textContent = v + " dB";
  });

  // Hand threshold
  const hand = $("hand-thr");
  hand.addEventListener("input", () => {
    state.handThreshold = parseInt(hand.value, 10);
    $("hand-thr-val").textContent = String(state.handThreshold);
    rebuildVoices();
  });

  // Style sliders
  const styleDot = $("style-dot");
  if (styleDot) styleDot.addEventListener("input", () => {
    const v = parseFloat(styleDot.value);
    renderer.setStyle({ dotScale: v });
    $("style-dot-val").textContent = v.toFixed(2) + "×";
  });
  const styleLw = $("style-lw");
  if (styleLw) styleLw.addEventListener("input", () => {
    const v = parseFloat(styleLw.value);
    renderer.setStyle({ lineWidth: v });
    $("style-lw-val").textContent = v.toFixed(1) + " px";
  });
  const styleLa = $("style-la");
  if (styleLa) styleLa.addEventListener("input", () => {
    const v = parseFloat(styleLa.value);
    renderer.setStyle({ lineAlpha: v, chordStemAlpha: Math.min(1, v * 0.85) });
    $("style-la-val").textContent = Math.round(v * 100) + "%";
  });

  // Timbre + reverb
  const timbre = $("timbre");
  timbre.addEventListener("change", () => {
    player.setTimbre(timbre.value);
    if (state.song) player.load(state.voices, state.song.durationSec);
  });
  const reverb = $("reverb");
  reverb.addEventListener("input", () => {
    const pct = parseInt(reverb.value, 10);
    $("reverb-val").textContent = pct + "%";
    player.setReverbWet(pct / 100);
  });
  player.onStatus = (msg) => {
    const el = $("sound-status");
    if (el) el.textContent = msg || "";
  };

  // Zoom
  const zoom = $("zoom");
  zoom.addEventListener("input", () => {
    const v = parseInt(zoom.value, 10);
    renderer.setPxPerSec(v);
    $("zoom-val").textContent = v + " px/s";
  });

  // Preset
  const preset = $("preset");
  preset.addEventListener("change", () => {
    renderer.applyPreset(preset.value);
    renderLayersPanel();
  });

  // Theme toggle
  const btnTheme = $("btn-theme");
  btnTheme.addEventListener("click", () => {
    const isLight = document.body.classList.toggle("theme-light");
    renderer.setTheme(isLight ? "light" : "dark");
    btnTheme.textContent = isLight ? "☀" : "☾";
  });

  // Export (PNG / PDF) — uses the dedicated multi-system score renderer
  $("btn-export").addEventListener("click", async () => {
    if (!state.song) return;
    const width = parseInt($("export-w").value, 10) || 2000;
    const scale = parseInt($("export-scale").value, 10) || 2;
    const fmt   = $("export-fmt").value || "png";
    const rowsRaw = $("export-rows").value;
    const rows  = rowsRaw === "auto" ? null : parseInt(rowsRaw, 10);
    const btn   = $("btn-export");
    const orig  = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Rendering…";
    try {
      const { renderScore } = await import("./scoreExport.js");
      const { canvas, widthCss, heightCss } = renderScore(state.song, state.voices, {
        width,
        scale,
        rows,
        maxAspect: 4,
        theme: "light",
        title: state.song.name || "",
        legend: $("export-legend")?.checked ?? true,
        style: { ...renderer.style },
        layers: {
          ...renderer.layers,
          // animation-only layers forced off for static image
          pulse: false, comet: false, ripple: false, beam: false,
          aurora: false, liveTrace: false, minimap: false,
          // glow is static-safe and respected
        },
      });
      const base = (state.song.name || "midi").replace(/[^\w\-]+/g, "_");
      if (fmt === "pdf") {
        const jsPDF = await loadJsPDF();
        const dataUrl = canvas.toDataURL("image/png");
        const pdf = new jsPDF({
          orientation: widthCss >= heightCss ? "landscape" : "portrait",
          unit: "pt",
          format: [widthCss, heightCss],
          compress: true,
        });
        pdf.addImage(dataUrl, "PNG", 0, 0, widthCss, heightCss, undefined, "FAST");
        pdf.save(`${base}_score.pdf`);
      } else {
        await new Promise(res => canvas.toBlob((blob) => {
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `${base}_score_${width}x${heightCss|0}.png`;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          res();
        }, "image/png"));
      }
    } catch (err) {
      console.error("Export failed", err);
      alert("Export failed: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });

  // File picker
  $("file").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const song = await loadMidiFromFile(f);
    setSong(song);
  });

  // Drag & drop
  const dz = $("dropzone");
  let dragDepth = 0;
  window.addEventListener("dragenter", e => { e.preventDefault(); dragDepth++; dz.hidden = false; });
  window.addEventListener("dragleave", e => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; dz.hidden = true; } });
  window.addEventListener("dragover", e => { e.preventDefault(); });
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    dragDepth = 0; dz.hidden = true;
    const f = e.dataTransfer.files?.[0];
    if (f) {
      const song = await loadMidiFromFile(f);
      setSong(song);
    }
  });

  // Canvas: click-to-seek, hover tooltip, wheel zoom + horizontal scroll
  canvas.addEventListener("click", (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < KEYS_W) return;
    const t = renderer.xToTime(x);
    player.seek(t);
    renderer.setPlayhead(t);
    updateSeek(t);
  });

  canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < KEYS_W || y < RULER_H) { tooltip.hidden = true; return; }
    const hit = renderer.hitTest(x, y);
    if (hit) {
      tooltip.hidden = false;
      tooltip.style.left = (e.clientX + 12) + "px";
      tooltip.style.top  = (e.clientY + 12) + "px";
      const n = hit.note;
      tooltip.textContent =
        `${hit.voice.label} • ${pitchName(n.midi)} (#${n.midi})  ` +
        `t=${n.time.toFixed(3)}s  dur=${n.duration.toFixed(3)}s  vel=${(n.velocity*127|0)}`;
    } else {
      tooltip.hidden = true;
    }
  });
  canvas.addEventListener("mouseleave", () => { tooltip.hidden = true; });

  canvas.addEventListener("wheel", (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0015);
      const cur = renderer.pxPerSec;
      const next = Math.max(20, Math.min(2000, cur * factor));
      renderer.setPxPerSec(next);
      $("zoom").value = String(Math.round(Math.min(600, Math.max(40, next))));
      $("zoom-val").textContent = Math.round(next) + " px/s";
    } else {
      // Horizontal scroll
      e.preventDefault();
      const dx = (Math.abs(e.deltaX) > Math.abs(e.deltaY)) ? e.deltaX : e.deltaY;
      renderer.scrollX = Math.max(0, renderer.scrollX + dx);
    }
  }, { passive: false });

  // Minimap: click to center, drag to scrub viewport.
  let miniDragging = false;
  const miniSeekFromEvent = (e, seek) => {
    if (!state.song) return;
    const rect = minimap.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const t = ratio * state.song.durationSec;
    if (seek) {
      player.seek(t);
      renderer.setPlayhead(t);
      updateSeek(t);
    }
    renderer.centerOnTime(t);
  };
  minimap.addEventListener("mousedown", (e) => {
    miniDragging = true;
    miniSeekFromEvent(e, e.shiftKey === false); // click → also seek
  });
  window.addEventListener("mousemove", (e) => {
    if (!miniDragging) return;
    miniSeekFromEvent(e, false);
  });
  window.addEventListener("mouseup", () => { miniDragging = false; });
}

function togglePlay() {
  if (!state.song) return;
  if (player.isPlaying()) {
    player.pause();
    $("btn-play").textContent = "▶";
  } else {
    player.play();
    $("btn-play").textContent = "❚❚";
  }
}

// Render-loop side effects (sync UI with playhead)
function tick() {
  if (state.song) {
    const t = player.getTime();
    renderer.setPlayhead(t);
    updateSeek(t);
    updateTimeReadout(t);
    if (t >= state.song.durationSec - 0.01 && player.isPlaying()) {
      player.pause();
      $("btn-play").textContent = "▶";
    }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

function updateSeek(t) {
  if (!state.song) return;
  const v = Math.round((t / state.song.durationSec) * 1000);
  $("seek").value = String(Math.max(0, Math.min(1000, v)));
}

function updateTimeReadout(tNow) {
  const t = tNow ?? 0;
  const dur = state.song?.durationSec ?? 0;
  $("time-readout").textContent = `${fmtTime(t)} / ${fmtTime(dur)}`;
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(3).padStart(6, "0")}`;
}

const LAYER_LABELS = {
  grid: "Grid",
  notes: "Notes",
  connections: "Melody lines",
  chordStems: "Chord stems",
  rootProgression: "Chord roots",
  chordLabels: "Chord names",
  pulse: "Active pulse",
  comet: "Comet trail",
  ripple: "Ripple rings",
  glow: "Soft glow",
  aurora: "Aurora bands",
  beam: "Playhead beam",
  liveTrace: "Live trace",
  minimap: "Minimap",
};

function renderLayersPanel() {
  const ul = $("layers-list");
  ul.innerHTML = "";
  for (const key of Object.keys(DEFAULT_LAYERS)) {
    const li = document.createElement("li");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = `layer-${key}`;
    cb.checked = !!renderer.layers[key];
    cb.addEventListener("change", () => {
      renderer.setLayer(key, cb.checked);
    });
    const lab = document.createElement("label");
    lab.htmlFor = cb.id;
    lab.textContent = LAYER_LABELS[key] || key;
    li.append(cb, lab);
    ul.appendChild(li);
  }
}

function renderVoicesPanel() {
  const ul = $("voices-list");
  ul.innerHTML = "";
  state.voices.forEach((v, i) => {
    const li = document.createElement("li");
    const sw = document.createElement("span");
    sw.className = "swatch"; sw.style.background = v.color;
    const nm = document.createElement("span");
    nm.className = "name"; nm.textContent = v.label;
    const muteBtn = document.createElement("button");
    muteBtn.textContent = "M";
    muteBtn.className = v.muted ? "active" : "";
    muteBtn.title = "Mute";
    muteBtn.addEventListener("click", () => {
      v.muted = !v.muted;
      muteBtn.className = v.muted ? "active" : "";
      player.applyVoiceState();
    });
    const soloBtn = document.createElement("button");
    soloBtn.textContent = "S";
    soloBtn.className = v.solo ? "active" : "";
    soloBtn.title = "Solo";
    soloBtn.addEventListener("click", () => {
      v.solo = !v.solo;
      soloBtn.className = v.solo ? "active" : "";
      player.applyVoiceState();
    });
    li.append(sw, nm, muteBtn, soloBtn);
    ul.appendChild(li);
  });
}

// Local helper (avoid importing render's pitchName cycle)
function pitchName(m) {
  const names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  return names[m % 12] + (Math.floor(m / 12) - 1);
}

// Lazy-load jsPDF UMD from CDN; resolves to the jsPDF constructor.
let _jspdfPromise = null;
function loadJsPDF() {
  if (window.jspdf?.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
  if (_jspdfPromise) return _jspdfPromise;
  _jspdfPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js";
    s.onload = () => {
      if (window.jspdf?.jsPDF) resolve(window.jspdf.jsPDF);
      else reject(new Error("jsPDF failed to load"));
    };
    s.onerror = () => reject(new Error("jsPDF failed to load"));
    document.head.appendChild(s);
  });
  return _jspdfPromise;
}

// ---------- collapsible sidebar panels ----------
function bindCollapsiblePanels() {
  const panels = document.querySelectorAll("#voices-panel details.panel");
  for (const p of panels) {
    const key = "panel:" + p.id;
    const saved = localStorage.getItem(key);
    if (saved === "open") p.open = true;
    else if (saved === "closed") p.open = false;
    p.addEventListener("toggle", () => {
      localStorage.setItem(key, p.open ? "open" : "closed");
    });
  }
}

// ---------- custom hover tooltip (data-tip="...") ----------
function bindHoverTips() {
  const tip = document.getElementById("tooltip");
  if (!tip) return;
  let timer = null;
  let currentEl = null;

  const show = (el, x, y) => {
    const text = el.getAttribute("data-tip");
    if (!text) return;
    tip.textContent = text;
    tip.hidden = false;
    // Position: prefer right of cursor; flip if it would overflow viewport.
    const pad = 12;
    tip.style.left = "0px"; tip.style.top = "0px";
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let nx = x + pad;
    let ny = y + pad;
    if (nx + tw + 8 > window.innerWidth) nx = x - tw - pad;
    if (ny + th + 8 > window.innerHeight) ny = y - th - pad;
    tip.style.left = Math.max(4, nx) + "px";
    tip.style.top  = Math.max(4, ny) + "px";
  };
  const hide = () => { tip.hidden = true; currentEl = null; };

  document.addEventListener("mousemove", (e) => {
    const el = e.target.closest?.("[data-tip]");
    if (el !== currentEl) {
      clearTimeout(timer);
      hide();
      currentEl = el;
      if (el) {
        timer = setTimeout(() => { if (currentEl === el) show(el, e.clientX, e.clientY); }, 350);
      }
    } else if (el && !tip.hidden) {
      show(el, e.clientX, e.clientY);
    }
  });
  document.addEventListener("mouseleave", hide);
  document.addEventListener("scroll", hide, true);
  // Hide while interacting (so it doesn't block sliders).
  document.addEventListener("mousedown", hide);
  document.addEventListener("keydown", hide);
}

// ---------- data export ----------
let _dataExportMod = null;
async function loadDataExport() {
  if (!_dataExportMod) _dataExportMod = await import("./dataExport.js");
  return _dataExportMod;
}

const DATA_PRESETS = {
  notes:  { grouping: "note",  cols: ["time", "bar", "beat", "voice", "pitch", "midi", "duration", "velocity", "chord_name"] },
  grid:   { grouping: "beat",  cols: ["time", "bar", "beat", "Melody", "Harmony", "Bass", "Flute"] },
  chords: { grouping: "chord", cols: ["time", "bar", "beat", "chord_name", "chord_root", "chord_quality", "chord_bass", "duration"] },
  custom: { grouping: "beat",  cols: ["time", "bar", "beat", "Melody", "Harmony", "Bass"] },
};

const ALL_COLS = [
  ["time",          "Time"],
  ["bar",           "Bar"],
  ["beat",          "Beat"],
  ["voice",         "Voice"],
  ["pitch",         "Pitch"],
  ["midi",          "MIDI"],
  ["duration",      "Duration"],
  ["velocity",      "Velocity"],
  ["chord_name",    "Chord"],
  ["chord_root",    "Chord root"],
  ["chord_quality", "Chord quality"],
  ["chord_bass",    "Chord bass"],
  ["track",         "Track #"],
  ["tempo_bpm",     "Tempo"],
  ["time_signature","Time sig"],
  ["Melody",        "Melody"],
  ["Harmony",       "Harmony"],
  ["Bass",          "Bass"],
  ["Flute",         "Flute"],
];

function bindDataExport() {
  const presetSel = $("data-preset");
  const grpSel    = $("data-grouping");
  const grpRow    = $("data-grouping-row");
  const colsList  = $("data-cols-list");
  const fmtSel    = $("data-fmt");
  const timeSel   = $("data-time-fmt");
  const previewEl = $("data-preview");
  const btn       = $("btn-data-export");
  if (!presetSel) return;

  // Build column checkboxes.
  for (const [key, label] of ALL_COLS) {
    const id = "data-col-" + key;
    const wrap = document.createElement("label");
    wrap.innerHTML = `<input type="checkbox" id="${id}" data-col="${key}" /> ${label}`;
    colsList.appendChild(wrap);
  }
  const colInputs = () => Array.from(colsList.querySelectorAll("input[data-col]"));
  const setColsFromPreset = (name) => {
    const preset = DATA_PRESETS[name] || DATA_PRESETS.notes;
    grpSel.value = preset.grouping;
    const wanted = new Set(preset.cols);
    for (const inp of colInputs()) inp.checked = wanted.has(inp.dataset.col);
  };
  const restoreCustom = () => {
    const saved = localStorage.getItem("dataExport:custom");
    if (!saved) return setColsFromPreset("custom");
    try {
      const obj = JSON.parse(saved);
      grpSel.value = obj.grouping || "beat";
      const wanted = new Set(obj.cols || []);
      for (const inp of colInputs()) inp.checked = wanted.has(inp.dataset.col);
    } catch { setColsFromPreset("custom"); }
  };
  const saveCustom = () => {
    if (presetSel.value !== "custom") return;
    localStorage.setItem("dataExport:custom", JSON.stringify({
      grouping: grpSel.value,
      cols: colInputs().filter(i => i.checked).map(i => i.dataset.col),
    }));
  };
  const updatePreview = () => {
    const cols = colInputs().filter(i => i.checked).length;
    const grp = grpSel.value;
    previewEl.textContent = `${cols} column${cols === 1 ? "" : "s"} • grouping: ${grp}`;
  };
  const updateGroupingVisibility = () => {
    // Notes preset always per-note; chord preset always per-chord.
    const fixed = presetSel.value === "notes" || presetSel.value === "chords";
    grpRow.style.display = fixed ? "none" : "";
  };

  presetSel.addEventListener("change", () => {
    if (presetSel.value === "custom") restoreCustom();
    else setColsFromPreset(presetSel.value);
    updateGroupingVisibility();
    updatePreview();
  });
  grpSel.addEventListener("change", () => { saveCustom(); updatePreview(); });
  colsList.addEventListener("change", () => {
    if (presetSel.value !== "custom") presetSel.value = "custom";
    saveCustom();
    updatePreview();
  });

  // Initial state
  setColsFromPreset("notes");
  presetSel.value = "notes";
  updateGroupingVisibility();
  updatePreview();

  btn.addEventListener("click", async () => {
    if (!state.song) return;
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = "Building…";
    try {
      const mod = await loadDataExport();
      const opts = {
        grouping: presetSel.value === "notes" ? "note"
                 : presetSel.value === "chords" ? "chord"
                 : grpSel.value,
        columns:  colInputs().filter(i => i.checked).map(i => i.dataset.col),
        timeFormat: timeSel.value, // "sec" | "mmss"
        decimals: 3,
      };
      const table = mod.buildRows(state.song, state.voices, opts);
      const base  = (state.song.name || "midi").replace(/[^\w\-]+/g, "_");
      const fmt   = fmtSel.value;
      if (fmt === "xlsx") {
        const blob = await mod.toXLSX(table, "data");
        downloadBlob(blob, `${base}_data.xlsx`);
      } else {
        const csv = mod.toCSV(table);
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
        downloadBlob(blob, `${base}_data.csv`);
      }
    } catch (err) {
      console.error("Data export failed", err);
      alert("Data export failed: " + err.message);
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}