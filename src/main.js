import { loadMidiFromUrl, loadMidiFromFile } from "./midiLoader.js";
import { buildVoices } from "./voicing.js";
import { Renderer, KEYS_W, RULER_H, PRESETS, DEFAULT_LAYERS, LAYER_GROUPS } from "./render.js";
import { Player } from "./player.js";
import { buildChordEvents, defaultChordSources, isChordSourceCandidate } from "./chordSource.js";
import { detectKey, detectKeyTimeline, pitchHistogram, keyAt, autoDetectKeyChanges, TONIC_NAMES } from "./keyDetect.js";
import { tonicPc } from "./consonance.js";

const state = {
  song: null,
  voices: [],
  handThreshold: 60,
  groupChords: true,
  onsetWindow: 0.045,
  // Separate, much-looser tolerance for the *manual* chord-source pooling
  // (voicing.js still uses the tight onsetWindow above so per-voice
  // clustering stays accurate). 600ms covers most rolled / arpeggiated
  // accompaniment patterns.
  chordWindow: 0.6,
  // Pool mode for the manual chord-source picker. "bar" is the default
  // for hymn / waltz / accompaniment patterns where the harmony changes
  // on every downbeat. "window" reverts to the onset-tolerance slider;
  // "beat" pools per beat; "sustain" merges anything whose sustains
  // overlap.
  chordPoolMode: "bar",
  themeName: "light",
  chordSources: new Set(),  // voice.id of voices selected for chord analysis
  chordEvents: [],          // pooled chord events from `chordSources`
  // Key + consonance configuration. `keyMode` controls where the key
  // comes from: "manual" (user picks tonic+mode), "auto" (single
  // detected key), or "timeline" (per-bar detected segments).
  keySource: "manual",
  keyManual: { tonic: "C", mode: "major" },
  keyTimeline: [],
  consonanceMethod: "degree",
};

const $ = (id) => document.getElementById(id);
const canvas = $("canvas");
const minimap = $("minimap");
const tooltip = $("tooltip");
const renderer = new Renderer(canvas, minimap);
const player = new Player();

// ---------- bootstrapping ----------
window.addEventListener("error", (e) => {
  console.error("[midivis] uncaught:", e.message, e.error);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("[midivis] unhandled promise rejection:", e.reason);
});
// init() is called at the bottom of the file so all module-level `const`s
// (DATA_PRESETS, ALL_COLS, etc.) are initialized before bindUI() runs.

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
  state.voices = buildVoices(song, state.handThreshold, { groupChords: state.groupChords, onsetWindow: state.onsetWindow });
  state.chordSources = defaultChordSources(state.voices);
  // Seed the manual key from the file's own signature when present, so
  // the Key panel shows something sensible even before the user presses
  // Detect. Wipe any prior song's timeline.
  const ks = song?.header?.keySignatures;
  if (ks && ks.length) {
    state.keyManual = {
      tonic: ks[0].key || "C",
      mode: ks[0].scale === "minor" ? "minor" : "major",
    };
  }
  state.keyTimeline = [];
  if (state.keySource === "timeline") state.keySource = "manual";
  recomputeChordEvents();
  renderer.setSong(song, state.voices);
  renderer.setChordEvents(state.chordEvents);
  player.load(state.voices, song.durationSec);
  renderVoicesPanel();
  renderLayersPanel();
  renderKeyPanel();
  _setKeyReadout(song);
  updateTimeReadout();
  updateSeek(0);
}

function rebuildVoices() {
  if (!state.song) return;
  // Carry mute / solo / gain across the rebuild. Without this, toggling
  // "Group chords" (or any onset-window slider drag) silently un-mutes
  // every voice the user had silenced — a really nasty foot-gun.
  const prev = new Map();
  for (const v of state.voices || []) {
    prev.set(v.id, { muted: !!v.muted, solo: !!v.solo, gainDb: v.gainDb });
    // label/kind fallback in case ids change after groupChords toggles.
    prev.set(`label:${v.label}`, { muted: !!v.muted, solo: !!v.solo, gainDb: v.gainDb });
  }
  state.voices = buildVoices(state.song, state.handThreshold, { groupChords: state.groupChords, onsetWindow: state.onsetWindow });
  for (const v of state.voices) {
    const carry = prev.get(v.id) ?? prev.get(`label:${v.label}`);
    if (carry) {
      v.muted  = carry.muted;
      v.solo   = carry.solo;
      if (carry.gainDb != null) v.gainDb = carry.gainDb;
    }
  }
  // Voice IDs are label-derived, so they may have changed. Re-derive the
  // chord-source selection from the new voice list.
  state.chordSources = defaultChordSources(state.voices);
  recomputeChordEvents();
  renderer.setVoices(state.voices);
  renderer.setChordEvents(state.chordEvents);
  player.load(state.voices, state.song.durationSec);
  renderVoicesPanel();
}

// Re-pool chord events from the currently-selected source voices, using
// the current consonance method + key timeline.
function recomputeChordEvents() {
  const tl = effectiveKeyTimeline();
  state.chordEvents = buildChordEvents(state.voices, state.chordSources, state.chordWindow, {
    method: state.consonanceMethod,
    keyTimeline: tl,
    poolMode: state.chordPoolMode,
    song: state.song,
  });
}

// Active key timeline: for "manual" or "auto" modes that's a single
// segment starting at t=0; for "timeline" it's whatever the segmented
// detector produced last time the user pressed Run.
function effectiveKeyTimeline() {
  if (state.keySource === "timeline" && state.keyTimeline.length) {
    return state.keyTimeline;
  }
  const sig = state.keyManual;
  return [{ bar: 1, time: 0, tonic: sig.tonic, mode: sig.mode, tonicPc: tonicPc(sig.tonic, sig.mode) }];
}

// Read the active key signature for scale-degree CSV export. Manual
// override always wins; otherwise we pick the first segment of the
// detected timeline; otherwise the file's own key signature; otherwise C.
function currentKeySig() {
  if (state.keySource === "manual" || state.keySource === "auto") {
    return { ...state.keyManual };
  }
  if (state.keyTimeline.length) {
    const k = state.keyTimeline[0];
    return { tonic: k.tonic, mode: k.mode };
  }
  const ks = state.song?.header?.keySignatures;
  if (ks && ks.length) {
    return { tonic: ks[0].key || "C", mode: ks[0].scale === "minor" ? "minor" : "major" };
  }
  return { tonic: "C", mode: "major" };
}

// ---------- UI ----------
function bindUI() {
  bindCollapsiblePanels();
  bindHoverTips();
  bindDataExport();
  bindKeyPanel();
  bindSteppers();
  applyMinimapVisibility();
  // Play/Pause
  $("btn-play").addEventListener("click", togglePlay);
  $("btn-stop").addEventListener("click", () => {
    player.stop();
    renderer.setPlayhead(0);
    updateSeek(0);
  });
  document.addEventListener("keydown", e => {
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.code) {
      case "Space":      e.preventDefault(); togglePlay(); break;
      case "Escape":     e.preventDefault(); $("btn-stop").click(); break;
      case "ArrowLeft":  e.preventDefault(); seekBy(e.shiftKey ? -5 : -1); break;
      case "ArrowRight": e.preventDefault(); seekBy(e.shiftKey ?  5 :  1); break;
      case "Home":       e.preventDefault(); seekTo(0); break;
      case "End":        if (state.song) { e.preventDefault(); seekTo(state.song.durationSec); } break;
      case "KeyF":       e.preventDefault(); fitToView(); break;
      case "KeyT":       e.preventDefault(); $("btn-theme").click(); break;
      case "Equal": case "NumpadAdd":      e.preventDefault(); nudgeZoom( 1.25); break;
      case "Minus": case "NumpadSubtract": e.preventDefault(); nudgeZoom(1/1.25); break;
    }
  });
  // Fit button
  $("btn-fit")?.addEventListener("click", fitToView);

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
    const out = $("speed-val"); if (out) out.textContent = v.toFixed(2) + "×";
  });

  // Volume
  const vol = $("vol");
  vol.addEventListener("input", () => {
    const v = parseFloat(vol.value);
    player.setMasterDb(v);
    const out = $("vol-val"); if (out) out.textContent = v + " dB";
  });

  // Hand threshold
  const hand = $("hand-thr");
  hand.addEventListener("input", () => {
    state.handThreshold = parseInt(hand.value, 10);
    const out = $("hand-thr-val"); if (out) out.textContent = String(state.handThreshold);
    rebuildVoices();
  });

  // Style sliders
  const styleDot = $("style-dot");
  if (styleDot) styleDot.addEventListener("input", () => {
    const v = parseFloat(styleDot.value);
    renderer.setStyle({ dotScale: v });
    const out = $("style-dot-val"); if (out) out.textContent = v.toFixed(2) + "×";
  });
  const styleLw = $("style-lw");
  if (styleLw) styleLw.addEventListener("input", () => {
    const v = parseFloat(styleLw.value);
    renderer.setStyle({ lineWidth: v });
    const out = $("style-lw-val"); if (out) out.textContent = v.toFixed(1) + " px";
  });
  const styleLa = $("style-la");
  if (styleLa) styleLa.addEventListener("input", () => {
    const v = parseFloat(styleLa.value);
    renderer.setStyle({ lineAlpha: v, chordStemAlpha: Math.min(1, v * 0.85) });
    const out = $("style-la-val"); if (out) out.textContent = Math.round(v * 100) + "%";
  });
  // Velocity → opacity mix
  const styleVel = $("style-velmix");
  if (styleVel) styleVel.addEventListener("input", () => {
    const v = parseFloat(styleVel.value);
    renderer.setStyle({ velocityMix: v });
    const out = $("style-velmix-val"); if (out) out.textContent = Math.round(v * 100) + "%";
  });
  // Active (playthrough) opacity
  const styleLaA = $("style-laActive");
  if (styleLaA) styleLaA.addEventListener("input", () => {
    const v = parseFloat(styleLaA.value);
    renderer.setStyle({ lineAlphaActive: v });
    const out = $("style-laActive-val"); if (out) out.textContent = Math.round(v * 100) + "%";
  });
  const styleGlow = $("style-glow");
  if (styleGlow) styleGlow.addEventListener("input", () => {
    const v = parseFloat(styleGlow.value);
    renderer.setStyle({ glowStrength: v });
    const out = $("style-glow-val"); if (out) out.textContent = v.toFixed(2) + "×";
  });
  const styleComet = $("style-comet");
  if (styleComet) styleComet.addEventListener("input", () => {
    const v = parseFloat(styleComet.value);
    renderer.setStyle({ cometLen: v });
    const out = $("style-comet-val"); if (out) out.textContent = v.toFixed(2) + "×";
  });
  const styleRipple = $("style-ripple");
  if (styleRipple) styleRipple.addEventListener("input", () => {
    const v = parseFloat(styleRipple.value);
    renderer.setStyle({ rippleR: v });
    const out = $("style-ripple-val"); if (out) out.textContent = v.toFixed(2) + "×";
  });
  const stylePedExt = $("style-pedalExtends");
  if (stylePedExt) stylePedExt.addEventListener("change", () => {
    renderer.setStyle({ pedalExtendsTails: stylePedExt.checked });
  });

  // Onset window (per-voice chord-clustering tolerance, used by voicing.js)
  const onsetWin = $("onset-win");
  if (onsetWin) onsetWin.addEventListener("input", () => {
    const ms = parseInt(onsetWin.value, 10);
    state.onsetWindow = ms / 1000;
    const out = $("onset-win-val"); if (out) out.textContent = ms + " ms";
    rebuildVoices();
    if (renderer._cacheChordNames) renderer._cacheChordNames();
  });

  // Chord window (cross-voice pooling tolerance for the manual chord-source
  // picker — independent from the per-voice onset window above).
  const chordWin = $("chord-win");
  if (chordWin) chordWin.addEventListener("input", () => {
    const ms = parseInt(chordWin.value, 10);
    state.chordWindow = ms / 1000;
    recomputeChordEvents();
    renderer.setChordEvents(state.chordEvents);
  });
  const chordModeSel = $("chord-mode");
  const syncChordWinEnabled = () => {
    if (!chordWin) return;
    const isWindow = state.chordPoolMode === "window";
    chordWin.disabled = !isWindow;
    const num = $("chord-win-num");
    if (num) num.disabled = !isWindow;
    const block = chordWin.closest(".ctrl-block");
    if (block) block.style.opacity = isWindow ? "" : "0.45";
  };
  if (chordModeSel) {
    chordModeSel.value = state.chordPoolMode;
    chordModeSel.addEventListener("change", () => {
      state.chordPoolMode = chordModeSel.value;
      syncChordWinEnabled();
      recomputeChordEvents();
      renderer.setChordEvents(state.chordEvents);
    });
  }
  syncChordWinEnabled();

  // Timbre + reverb
  const timbre = $("timbre");
  timbre.addEventListener("change", () => {
    player.setTimbre(timbre.value);
    if (state.song) player.load(state.voices, state.song.durationSec);
  });
  const reverb = $("reverb");
  reverb.addEventListener("input", () => {
    const pct = parseInt(reverb.value, 10);
    const out = $("reverb-val"); if (out) out.textContent = pct + "%";
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
    const out = $("zoom-val"); if (out) out.textContent = v + " px/s";
    _invalidateFitMemo();
  });

  // Preset
  const preset = $("preset");
  preset.addEventListener("change", () => {
    renderer.applyPreset(preset.value);
    renderLayersPanel();
  });

  // Theme toggle (default = light; remembered across sessions). The
  // CSS now defaults to light at :root and gates dark overrides behind
  // body.theme-dark, so the JS toggles `theme-dark` (not `theme-light`).
  const btnTheme = $("btn-theme");
  const moonSVG = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M11.5 9.5A4.5 4.5 0 0 1 6.5 4a4.5 4.5 0 1 0 5 5.5z" fill="currentColor"/></svg>';
  const sunSVG  = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="currentColor"/><g stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M3.3 12.7l1.4-1.4M11.3 4.7l1.4-1.4"/></g></svg>';
  const updateThemeBtn = () => {
    const isDark = document.body.classList.contains("theme-dark");
    btnTheme.innerHTML = isDark ? sunSVG : moonSVG;
    btnTheme.setAttribute("aria-label", isDark ? "Switch to light theme" : "Switch to dark theme");
  };
  btnTheme.addEventListener("click", () => {
    const isDark = document.body.classList.toggle("theme-dark");
    state.themeName = isDark ? "dark" : "light";
    renderer.setTheme(state.themeName);
    try { localStorage.setItem("theme", state.themeName); } catch {}
    updateThemeBtn();
    renderVoicesPanel(); // refresh voice swatches with the new palette
  });
  // Initial theme: respect saved preference, default to light.
  const savedTheme = (() => { try { return localStorage.getItem("theme"); } catch { return null; } })();
  const startDark = savedTheme === "dark";
  document.body.classList.toggle("theme-dark", startDark);
  state.themeName = startDark ? "dark" : "light";
  renderer.setTheme(state.themeName);
  updateThemeBtn();

  // Chord-group toggle (default on): when off, piano tracks stay as a single
  // voice (no Bass / Chords / Melody split). Chord *labels* are still drawn
  // wherever simultaneous notes are detected.
  const groupCb = $("group-chords");
  if (groupCb) {
    groupCb.checked = state.groupChords;
    groupCb.addEventListener("change", () => {
      state.groupChords = groupCb.checked;
      rebuildVoices();
    });
  }

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
    const input = e.target;
    const f = input.files?.[0];
    if (!f) return;
    try {
      const song = await loadMidiFromFile(f);
      song.name = song.name && song.name !== "untitled" ? song.name : f.name.replace(/\.[^.]+$/, "");
      setSong(song);
    } catch (err) {
      console.error("Failed to load MIDI file:", err);
      alert("Failed to load MIDI file:\n" + (err?.message || err));
    } finally {
      // Allow re-selecting the same file later.
      input.value = "";
    }
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
    if (!f) return;
    try {
      const song = await loadMidiFromFile(f);
      song.name = song.name && song.name !== "untitled" ? song.name : f.name.replace(/\.[^.]+$/, "");
      setSong(song);
    } catch (err) {
      console.error("Failed to load MIDI file:", err);
      alert("Failed to load MIDI file:\n" + (err?.message || err));
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
      const next = Math.max(2, Math.min(2000, renderer.pxPerSec * factor));
      renderer.setPxPerSec(next);
      syncZoomSlider(next);
      _invalidateFitMemo();
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
  const ratio = Math.max(0, Math.min(1, t / state.song.durationSec));
  const v = Math.round(ratio * 1000);
  const seek = $("seek");
  if (seek) seek.value = String(v);
  const fill = $("seek-fill");
  if (fill) fill.style.width = (ratio * 100).toFixed(2) + "%";
}

function updateTimeReadout(tNow) {
  const t = tNow ?? 0;
  const dur = state.song?.durationSec ?? 0;
  // Legacy combined readout (still used if present somewhere).
  const legacy = $("time-readout");
  if (legacy) {
    let bb = "";
    if (state.song) {
      const { bar, beat } = barBeatAt(state.song, t);
      bb = `  ·  bar ${bar} · beat ${beat.toFixed(1)}`;
    }
    legacy.textContent = `${fmtTime(t)} / ${fmtTime(dur)}${bb}`;
  }
  // Modern transport panel.
  if (!state.song) return;
  const { bar, beat } = barBeatAt(state.song, t);
  const tempo = tempoAtSec(state.song, t);
  const ts    = tsAtSec(state.song, t);
  const setText = (id, val) => { const el = $(id); if (el) el.textContent = val; };
  // Compact mode (≤1480px viewport): the transport block becomes
  // bar.beat as a single cell and the TEMPO/TS/KEY trio gets smaller.
  // CSS handles the layout (.transport.compact); we just adjust the
  // text content here so users see e.g. "78.2" instead of "78".
  const compact = window.matchMedia("(max-width: 1480px)").matches;
  const tBarEl = $("t-bar");
  if (tBarEl) tBarEl.parentElement?.parentElement?.classList?.toggle("compact", compact);
  if (compact) {
    setText("t-bar",  `${bar}.${Math.max(1, Math.floor(beat))}`);
    setText("t-beat", "");
  } else {
    setText("t-bar",     String(bar));
    setText("t-beat",    beat.toFixed(1));
  }
  setText("t-tempo",   Math.round(tempo));
  setText("t-tsig",    ts);
  setText("t-elapsed", fmtTime(t));
  setText("t-total",   fmtTime(dur));
  // Key field is populated once on song load (see _setKeyReadout).
}

function tempoAtSec(song, sec) {
  const list = song.tempos || [];
  if (!list.length) return 120;
  let active = list[0];
  for (const x of list) { if (x.time <= sec) active = x; else break; }
  return active.bpm;
}
function tsAtSec(song, sec) {
  const list = song.timeSignatures || [];
  if (!list.length) return "4/4";
  let active = list[0];
  for (const x of list) { if ((x.time ?? 0) <= sec) active = x; else break; }
  return `${active.numerator}/${active.denominator}`;
}
function _setKeyReadout(song) {
  const el = $("t-key");
  if (!el) return;
  let key = "";
  if (song?.header?.keySignatures?.length) {
    const k = song.header.keySignatures[0];
    key = `${k.key || ""}${k.scale === "minor" ? "m" : ""}`.trim();
  }
  el.textContent = key || "—";
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(3).padStart(6, "0")}`;
}

// Lightweight bar:beat lookup for the live time-readout. Uses the
// @tonejs/midi `header.secondsToTicks` together with the most recent
// time-signature event that begins on or before `sec`.
function barBeatAt(song, sec) {
  if (!song || !song.header) return { bar: 1, beat: 1 };
  const tick = song.header.secondsToTicks(sec);
  const tsList = song.timeSignatures && song.timeSignatures.length
    ? song.timeSignatures
    : [{ ticks: 0, numerator: 4, denominator: 4, measures: 0 }];
  let active = tsList[0];
  for (const ts of tsList) {
    if ((ts.ticks ?? 0) <= tick) active = ts; else break;
  }
  const ticksPerBeat = song.ppq * (4 / active.denominator);
  const ticksPerMeasure = ticksPerBeat * active.numerator;
  const dt = tick - (active.ticks ?? 0);
  const measureIdx = Math.floor(dt / ticksPerMeasure);
  const inMeasure = dt - measureIdx * ticksPerMeasure;
  return {
    bar: Math.round(active.measures ?? 0) + measureIdx + 1,
    beat: inMeasure / ticksPerBeat + 1,
  };
}

const LAYER_LABELS = {
  grid:            ["Grid",          "Bar lines, beat ticks and pitch guides on the staff."],
  notes:           ["Notes",         "The note dots themselves — turn off only for an effect-only view."],
  connections:     ["Melody lines",  "Smooth curves connecting consecutive notes inside a voice."],
  chordStems:      ["Chord stems",   "Vertical stems connecting all members of a chord."],
  rootProgression: ["Chord roots",   "Heavy line tracing the root note of each chord through time."],
  chordLabels:     ["Chord names",   "Floating labels (e.g. C, Am7/G) above each chord change."],
  noteLabels:      ["Note names",    "Tiny note name (e.g. F#5) above every note dot — same idea as chord labels but per note. Off by default; can get crowded in dense passages."],
  consonance:      ["Consonance",    "Tint chord-name badges by consonance: green = perfect (0), amber = imperfect (1), red = dissonant (2). Appends ·0/·1/·2 to each label."],
  pedalLane:       ["Pedal lane",    "Bottom strip showing sustain-pedal (CC64) on/off regions."],
  noteFill:        ["Playthrough fill", "Active note tail fills left→right while the playhead is over it."],
  pulse:           ["Active pulse",  "Soft glow + enlarged dot whenever a note is currently sounding."],
  comet:           ["Comet trail",   "Fading streak following each currently-sounding note backwards."],
  ripple:          ["Ripple rings",  "Concentric rings that expand outward when a new note starts."],
  glow:            ["Soft glow",     "Diffuse halo behind every note dot. Heavier on dense passages."],
  aurora:          ["Aurora bands",  "Painterly vertical bands tinted by the active chord (heavy CPU)."],
  beam:            ["Playhead beam", "Vertical column of light at the current playhead position."],
  liveTrace:       ["Live trace",    "Thin moving line drawn from the playhead through the active notes."],
  minimap:         ["Minimap",       "Footer overview strip. Turn off to give the main view more room."],
};

function renderLayersPanel() {
  const ul = $("layers-list");
  ul.innerHTML = "";
  ul.style.padding = "0";
  ul.style.listStyle = "none";

  // Saved open/closed state (re-using `panel:<id>` keys).
  const isOpen = (id) => {
    try { const v = localStorage.getItem(`panel:${id}`); return v === null ? true : v === "open"; }
    catch { return true; }
  };

  for (const group of LAYER_GROUPS) {
    const li = document.createElement("li");
    li.style.listStyle = "none";
    const subId = `subpanel-layers-${group.id}`;
    const det = document.createElement("details");
    det.className = "subpanel";
    det.id = subId;
    det.open = isOpen(subId);
    det.addEventListener("toggle", () => {
      try { localStorage.setItem(`panel:${subId}`, det.open ? "open" : "closed"); } catch {}
    });
    const sm = document.createElement("summary");
    sm.innerHTML = `<span class="caret" aria-hidden="true"></span><span class="sub-title">${group.label}</span>`;
    det.appendChild(sm);
    const inner = document.createElement("ul");
    inner.className = "subpanel-list";
    for (const key of group.keys) {
      if (!(key in DEFAULT_LAYERS)) continue;
      const [label, tip] = LAYER_LABELS[key] || [key, ""];
      const liItem = document.createElement("li");
      liItem.setAttribute("data-tip", tip);
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.id = `layer-${key}`;
      cb.checked = !!renderer.layers[key];
      cb.addEventListener("change", () => {
        renderer.setLayer(key, cb.checked);
        if (key === "minimap") applyMinimapVisibility();
      });
      const lab = document.createElement("label");
      lab.htmlFor = cb.id;
      lab.textContent = label;
      liItem.append(cb, lab);
      inner.appendChild(liItem);
    }
    det.appendChild(inner);
    li.appendChild(det);
    ul.appendChild(li);
  }
}

function applyMinimapVisibility() {
  const on = !!renderer.layers.minimap;
  document.body.classList.toggle("no-minimap", !on);
  // Trigger a resize so the renderer re-measures the canvas.
  window.dispatchEvent(new Event("resize"));
}

// Wire all `.ctrl` rows: keep the <input type="range">, the sibling
// <input type="number">, and the ± buttons in sync. Whenever any of
// them changes we dispatch an `input` event on the range so the
// existing handlers (player speed, master gain, zoom, …) keep working.
function bindSteppers() {
  document.querySelectorAll(".ctrl").forEach((wrap) => {
    const range = wrap.querySelector('input[type="range"]');
    const num   = wrap.querySelector('input[type="number"]');
    const btns  = wrap.querySelectorAll(".step-btn");
    if (!range) return;
    const step = parseFloat(range.step) || 1;
    const minR = parseFloat(range.min);
    const maxR = parseFloat(range.max);
    const minN = num ? parseFloat(num.min) : minR;
    const maxN = num ? parseFloat(num.max) : maxR;
    const decimals = (String(range.step).split(".")[1] || "").length;
    const fmt = (v) => decimals ? v.toFixed(decimals) : String(Math.round(v));

    const setFromNum = (v) => {
      v = Math.max(minN, Math.min(maxN, v));
      if (num) num.value = fmt(v);
      const clamped = Math.max(minR, Math.min(maxR, v));
      range.value = String(clamped);
      range.dispatchEvent(new Event("input"));
    };

    range.addEventListener("input", () => {
      if (num) num.value = fmt(parseFloat(range.value));
    });
    if (num) {
      num.addEventListener("change", () => {
        const v = parseFloat(num.value);
        if (Number.isFinite(v)) setFromNum(v);
      });
      // Also commit on Enter.
      num.addEventListener("keydown", (e) => {
        if (e.key === "Enter") num.blur();
      });
    }
    btns.forEach((b) => {
      b.addEventListener("click", () => {
        const dir = parseFloat(b.dataset.step) || 0;
        const cur = parseFloat((num && num.value) || range.value);
        setFromNum(cur + dir * step);
      });
    });
    // Initial sync.
    if (num) num.value = fmt(parseFloat(range.value));
  });
}

function renderVoicesPanel() {
  const ul = $("voices-list");
  ul.innerHTML = "";
  state.voices.forEach((v, i) => {
    const li = document.createElement("li");
    const sw = document.createElement("span");
    sw.className = "swatch"; sw.style.background = (state.themeName === "dark" ? v.color : (v.colorLight || v.color));
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
    // "Include this voice in chord analysis" toggle. Hidden for kinds that
    // don't have real pitched content (drums/perc/fx). Toggling re-pools
    // the chord events that drive labels, consonance, and the chord CSV.
    if (isChordSourceCandidate(v)) {
      const chordBtn = document.createElement("button");
      chordBtn.textContent = "♪";
      chordBtn.title = "Include this voice in chord analysis (labels, consonance, chord CSV)";
      chordBtn.setAttribute("data-tip", "Include this voice in chord analysis (chord labels, consonance rating, chord CSV).");
      const sync = () => { chordBtn.className = state.chordSources.has(v.id) ? "active" : ""; };
      sync();
      chordBtn.addEventListener("click", () => {
        if (state.chordSources.has(v.id)) state.chordSources.delete(v.id);
        else state.chordSources.add(v.id);
        sync();
        recomputeChordEvents();
        renderer.setChordEvents(state.chordEvents);
      });
      li.append(chordBtn);
    }
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
  notes:       { grouping: "note",  cols: ["time", "bar", "beat", "voice", "pitch", "midi", "duration", "velocity", "chord_name"] },
  grid:        { grouping: "beat",  cols: ["time", "bar", "beat", "Melody", "Harmony", "Bass", "Flute"] },
  chords:      { grouping: "chord", cols: ["time", "bar", "beat", "chord_name", "chord_root", "chord_quality", "chord_bass", "consonance", "duration"] },
  // "Instruments" preset is special-cased: columns are computed from the
  // live voice list at export time. We still record a default grouping
  // so the grouping <select> shows something sensible.
  instruments: { grouping: "beat",  cols: ["__voiceWide"] },
  // Default custom export: one row per beat, harmony summary up front,
  // then each voice as a triplet (English name / scale-degree / octave)
  // so the user immediately sees BOTH spellings without re-checking
  // boxes. Voices that don't belong to the score are silently empty.
  custom:      { grouping: "auto", cols: [
    "time", "bar", "beat",
    "chord_name", "chord_quality", "chord_root", "chord_bass", "consonance",
    "Melody",  "Melody_note",  "Melody_oct",
    "Harmony", "Harmony_note", "Harmony_oct",
    "Bass",    "Bass_note",    "Bass_oct",
    "Flute",   "Flute_note",   "Flute_oct",
  ] },
};

const ALL_COLS = [
  ["time",          "Time"],
  ["bar",           "Bar"],
  ["beat",          "Beat"],
  ["voice",         "Voice"],
  ["pitch",         "Pitch"],
  ["pitch_note",    "Pitch · note"],
  ["pitch_oct",     "Pitch · octave"],
  ["midi",          "MIDI"],
  ["duration",      "Duration"],
  ["velocity",      "Velocity"],
  ["chord_name",    "Chord"],
  ["chord_root",    "Chord root"],
  ["chord_quality", "Chord quality"],
  ["chord_bass",    "Chord bass"],
  ["consonance",    "Consonance (0/1/2)"],
  ["track",         "Track #"],
  ["tempo_bpm",     "Tempo"],
  ["time_signature","Time sig"],
  // Per-voice pivot triplets. The base column is the English note name
  // (e.g. F#5); `_note` is the bare scale-degree integer (with a `*`
  // marker for chromatic notes when degree mode is on); `_oct` is the
  // MIDI octave number. Multiple notes in the same voice/beat are
  // joined with `+`.
  ["Melody",        "Melody"],
  ["Melody_note",   "Melody · note"],
  ["Melody_oct",    "Melody · octave"],
  ["Harmony",       "Harmony"],
  ["Harmony_note",  "Harmony · note"],
  ["Harmony_oct",   "Harmony · octave"],
  ["Bass",          "Bass"],
  ["Bass_note",     "Bass · note"],
  ["Bass_oct",      "Bass · octave"],
  ["Flute",         "Flute"],
  ["Flute_note",    "Flute · note"],
  ["Flute_oct",     "Flute · octave"],
];

// ---------- Key & consonance panel ----------

function bindKeyPanel() {
  const tonicSel  = $("key-tonic");
  const modeSel   = $("key-mode");
  const detectBtn = $("key-detect");
  const segInput  = $("key-seg-bars");
  const intervalChk = $("cons-interval");
  if (!tonicSel) return;

  // Default method is degree; restored if previously toggled.
  const savedMethod = localStorage.getItem("consonance:method");
  if (savedMethod === "interval" || savedMethod === "degree") {
    state.consonanceMethod = savedMethod;
  }
  if (intervalChk) intervalChk.checked = state.consonanceMethod === "interval";

  const onManualChange = () => {
    state.keySource = "manual";
    state.keyManual = { tonic: tonicSel.value, mode: modeSel.value };
    state.keyTimeline = [];
    recomputeChordEvents();
    renderer.setChordEvents(state.chordEvents);
    renderKeyPanel();
  };
  tonicSel.addEventListener("change", onManualChange);
  modeSel.addEventListener("change", onManualChange);

  // Single Detect button: when Segment bars > 0 it produces a per-segment
  // timeline (and the active key follows the playhead via keyAt()); when
  // Segment bars = 0 it picks one key for the whole song.
  detectBtn.addEventListener("click", () => {
    if (!state.song) return;
    const bars = parseInt(segInput?.value, 10) || 0;
    if (bars > 0) {
      const tl = detectKeyTimeline(state.song, state.voices, bars);
      state.keyTimeline = tl;
      state.keySource = (tl.length > 1) ? "timeline" : "auto";
      if (tl[0]) {
        state.keyManual = { tonic: tl[0].tonic, mode: tl[0].mode };
        tonicSel.value = tl[0].tonic;
        modeSel.value  = tl[0].mode;
      }
    } else {
      const hist = pitchHistogram(state.voices, 0, state.song.durationSec);
      const k = detectKey(hist);
      state.keyManual = { tonic: k.tonic, mode: k.mode };
      state.keySource = "auto";
      state.keyTimeline = [];
      tonicSel.value = k.tonic;
      modeSel.value  = k.mode;
    }
    recomputeChordEvents();
    renderer.setChordEvents(state.chordEvents);
    renderKeyPanel();
  });

  if (intervalChk) intervalChk.addEventListener("change", () => {
    state.consonanceMethod = intervalChk.checked ? "interval" : "degree";
    localStorage.setItem("consonance:method", state.consonanceMethod);
    recomputeChordEvents();
    renderer.setChordEvents(state.chordEvents);
  });

  // Auto-modulation button: runs autoDetectKeyChanges with sensible
  // defaults (2-bar sliding window, 3-bar majority smoothing, 4-bar
  // minimum run length) and writes the resulting timeline into state
  // exactly the way the manual Detect button does, so the renderer /
  // chord-source picker pick it up automatically.
  const autoBtn = $("key-auto");
  if (autoBtn) autoBtn.addEventListener("click", () => {
    if (!state.song) return;
    const tl = autoDetectKeyChanges(state.song, state.voices, {
      windowBars: 2, smoothBars: 3, minRunBars: 4,
    });
    state.keyTimeline = tl;
    state.keySource   = (tl.length > 1) ? "timeline" : "auto";
    if (tl[0]) {
      state.keyManual = { tonic: tl[0].tonic, mode: tl[0].mode };
      tonicSel.value  = tl[0].tonic;
      modeSel.value   = tl[0].mode;
    }
    recomputeChordEvents();
    renderer.setChordEvents(state.chordEvents);
    renderKeyPanel();
  });

  renderKeyPanel();
}

function renderKeyPanel() {
  const tonicSel = $("key-tonic");
  const modeSel  = $("key-mode");
  const tlEl     = $("key-timeline");
  if (!tonicSel) return;
  tonicSel.value = state.keyManual.tonic;
  modeSel.value  = state.keyManual.mode;
  if (!tlEl) return;
  if (state.keySource === "timeline" && state.keyTimeline.length) {
    const lines = state.keyTimeline.map(s => {
      const conf = (s.r != null) ? ` (r=${s.r.toFixed(2)})` : "";
      return `  bar ${s.bar} @ ${s.time.toFixed(2)}s — ${s.tonic} ${s.mode}${conf}`;
    });
    tlEl.textContent = `Detected ${state.keyTimeline.length} segment(s):\n${lines.join("\n")}`;
  } else if (state.keySource === "auto") {
    tlEl.textContent = `Auto-detected: ${state.keyManual.tonic} ${state.keyManual.mode} (whole song)`;
  } else {
    tlEl.textContent = "";
  }
}

function bindDataExport() {
  const presetSel = $("data-preset");
  const grpSel    = $("data-grouping");
  const grpRow    = $("data-grouping-row");
  const colsList  = $("data-cols-list");
  const fmtSel    = $("data-fmt");
  const timeSel   = $("data-time-fmt");
  const degChk    = $("data-use-degrees");
  const transposeChk = $("data-transpose");
  const splitChordChk = $("data-split-chord");
  const previewEl = $("data-preview");
  const btn       = $("btn-data-export");
  if (!presetSel) return;

  // Persist & restore the scale-degree CSV option.
  if (degChk) {
    degChk.checked = localStorage.getItem("dataExport:useDegrees") === "1";
    degChk.addEventListener("change", () => {
      localStorage.setItem("dataExport:useDegrees", degChk.checked ? "1" : "0");
    });
  }
  // Persist & restore the three structural CSV toggles.
  const bindToggle = (el, key) => {
    if (!el) return;
    el.checked = localStorage.getItem(key) === "1";
    el.addEventListener("change", () => {
      localStorage.setItem(key, el.checked ? "1" : "0");
    });
  };
  bindToggle(transposeChk,  "dataExport:transpose");
  bindToggle(splitChordChk, "dataExport:splitChord");

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
    // Bumped to v3 when grouping default changed to "auto".
    const saved = localStorage.getItem("dataExport:custom:v3");
    if (!saved) return setColsFromPreset("custom");
    try {
      const obj = JSON.parse(saved);
      grpSel.value = obj.grouping || "auto";
      const wanted = new Set(obj.cols || []);
      for (const inp of colInputs()) inp.checked = wanted.has(inp.dataset.col);
    } catch { setColsFromPreset("custom"); }
  };
  const saveCustom = () => {
    if (presetSel.value !== "custom") return;
    localStorage.setItem("dataExport:custom:v3", JSON.stringify({
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
    // Notes preset always per-note; chord preset always per-chord;
    // instruments preset uses its own subdiv (we still expose grouping).
    const fixed = presetSel.value === "notes" || presetSel.value === "chords";
    grpRow.style.display = fixed ? "none" : "";
    // Hide the column picker for instruments — columns are auto-derived
    // from the live voice list.
    const colsBlock = colsList.parentElement;
    if (colsBlock) colsBlock.style.display = presetSel.value === "instruments" ? "none" : "";
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

  // Initial state: Custom is the default — it bundles the
  // chord-summary block + per-voice (name / degree / octave) triplets
  // that match the documented out-of-the-box CSV layout.
  presetSel.value = "custom";
  restoreCustom();
  updateGroupingVisibility();
  updatePreview();

  btn.addEventListener("click", async () => {
    if (!state.song) return;
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = "Building…";
    try {
      const mod = await loadDataExport();
      let table;
      if (presetSel.value === "instruments") {
        table = mod.buildVoiceGridRows(state.song, state.voices, {
          subdiv: grpSel.value,
          withChord: true,
          timeFormat: timeSel.value,
          decimals: 3,
          useScaleDegrees: !!(degChk && degChk.checked),
          transpose: !!(transposeChk && transposeChk.checked),
          splitChord: !!(splitChordChk && splitChordChk.checked),
          keySig: currentKeySig(),
        });
      } else {
        const opts = {
          grouping: presetSel.value === "notes" ? "note"
                   : presetSel.value === "chords" ? "chord"
                   : grpSel.value,
          columns:  colInputs().filter(i => i.checked).map(i => i.dataset.col),
          timeFormat: timeSel.value, // "sec" | "mmss"
          decimals: 3,
          useScaleDegrees: !!(degChk && degChk.checked),
          transpose: !!(transposeChk && transposeChk.checked),
          splitChord: !!(splitChordChk && splitChordChk.checked),
          keySig: currentKeySig(),
          chordEvents: state.chordEvents,
        };
        table = mod.buildRows(state.song, state.voices, opts);
      }
      // Attach a human-readable legend (column meanings, voice list,
      // degree convention) describing this specific export.
      table.legend = mod.buildLegend(state.song, state.voices, {
        useScaleDegrees: !!(degChk && degChk.checked),
        transpose: !!(transposeChk && transposeChk.checked),
        keySig: currentKeySig(),
      });
      // Append the consonance distribution to the trailer so the user
      // sees an at-a-glance breakdown of stable / functional / chromatic
      // chord cells over the whole export.
      const dist = mod.consonanceSummary(table);
      if (dist.length) table.legend = [...table.legend, "", ...dist];
      // When grouping was "auto", surface the actual subdivision the
      // detector picked so the user can see e.g. "Auto-detected grid:
      // halfbeat" right in the CSV trailer.
      if (table.detectedGrouping) {
        table.legend = [...table.legend, "", `Auto-detected grid: ${table.detectedGrouping} (per ${({beat:"beat", halfbeat:"½ beat", quarterbeat:"¼ beat", bar:"bar"})[table.detectedGrouping] || table.detectedGrouping})`];
      }
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

// ---------- transport / view helpers ----------
function seekBy(deltaSec) {
  if (!state.song) return;
  const t = Math.max(0, Math.min(state.song.durationSec, player.getTime() + deltaSec));
  seekTo(t);
}
function seekTo(t) {
  player.seek(t);
  renderer.setPlayhead(t);
  updateSeek(t);
  updateTimeReadout(t);
}
function nudgeZoom(factor) {
  const next = Math.max(2, Math.min(2000, renderer.pxPerSec * factor));
  renderer.setPxPerSec(next);
  syncZoomSlider(next);
  _invalidateFitMemo();
}
// Toggleable fit-to-view: first press fits the whole piece into the
// viewport; second press restores the previous zoom + scroll position.
let _fitMemo = null;
function fitToView() {
  if (!state.song) return;
  const fitBtn = $("btn-fit");
  if (_fitMemo) {
    renderer.setPxPerSec(_fitMemo.pxPerSec);
    renderer.scrollX = _fitMemo.scrollX;
    syncZoomSlider(_fitMemo.pxPerSec);
    _fitMemo = null;
    fitBtn?.classList.remove("active");
    return;
  }
  const stageW = (canvas.clientWidth || window.innerWidth) - KEYS_W - 8;
  const next = Math.max(2, stageW / Math.max(0.001, state.song.durationSec));
  _fitMemo = { pxPerSec: renderer.pxPerSec, scrollX: renderer.scrollX };
  renderer.setPxPerSec(next);
  renderer.scrollX = 0;
  syncZoomSlider(next);
  fitBtn?.classList.add("active");
}
// Manually nudging the zoom invalidates the saved "previous" state.
function _invalidateFitMemo() {
  if (_fitMemo) {
    _fitMemo = null;
    $("btn-fit")?.classList.remove("active");
  }
}
function syncZoomSlider(px) {
  const z = $("zoom");
  if (z) {
    const min = parseInt(z.min, 10) || 4;
    const max = parseInt(z.max, 10) || 600;
    z.value = String(Math.round(Math.max(min, Math.min(max, px))));
  }
  const num = $("zoom-num");
  if (num) num.value = String(Math.round(px));
  const out = $("zoom-val"); if (out) out.textContent = Math.round(px) + " px/s";
}

// Kick everything off now that all module-level constants are initialized.
init();