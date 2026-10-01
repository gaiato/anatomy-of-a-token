/* Anatomy of a Token: page controller. Loads the served model's profile, builds the scene from it,
 * and runs the walkthrough: one panel that explains the current step at the depth you choose, while the
 * 3D map stays live (orbit, click anything, step through tokens). */
import { $, esc, clamp, int, count, bytes, pct, ms, showTok, tag, REDUCED } from './util.js';
import { viewModel, traceModel } from './model.js';
import { buildScene } from './scene.js';
import { steps as buildSteps, stationTitles, PHASES, STATION_STEP, MIXNAME } from './story.js';
import { skyTime } from './skytime.js';
import { config, loadProfile, loadSnapshotTraces, runTrace, status } from './data.js';

const store = { get(k) { try { return sessionStorage.getItem(k); } catch { return null; } }, set(k, v) { try { sessionStorage.setItem(k, v); } catch { } },
  lget(k) { try { return localStorage.getItem(k); } catch { return null; } }, lset(k, v) { try { localStorage.setItem(k, v); } catch { } } };
const TIERS = ['Overview', 'Technical', 'Under the hood'];
const DEFAULT_PROMPTS = ['Why does ice float on water?', 'Write a haiku about autumn leaves.', 'What is 17 times 23?'];
const RECORD = new URLSearchParams(location.search).has('record');   // driven frame by frame by record/render.mjs

const { profile, demo, reason } = await loadProfile();
const M = viewModel(profile);
const snaps = await loadSnapshotTraces();
let T = null;
{
  const saved = store.get('anatomy-trace:' + M.id);
  const raw = (saved && JSON.parse(saved)) || snaps.find(t => t.model === M.id) || (demo ? snaps[0] : null);
  if (raw) T = traceModel(raw, M);
}

/* ── Header ── */
document.title = `Anatomy of a Token · ${M.name}`;
$('model-line').textContent = `${M.name} · ${M.engine.label} on ${M.hw.title}`;
$('live-dot').className = demo ? 'dot idle' : 'dot warn';
if (config.backLink) { const a = $('b-back'); a.href = config.backLink.href; a.querySelector('.lbl').textContent = config.backLink.label; a.hidden = false; }
if (demo) { const b = $('banner'); b.innerHTML = `<b>Demo data.</b> No probe answered${reason ? ` (${esc(reason)})` : ''}, so this page shows ${esc(M.name)} as captured on ${esc((profile.generated || '').slice(0, 10))}. <a href="#" id="howto">Run the probe</a> to see your own model. <button class="banner-x" aria-label="Dismiss">×</button>`; b.hidden = false; $('howto').href = config.repo || '#'; }
$('banner').addEventListener('click', e => { if (e.target.closest('.banner-x')) $('banner').hidden = true; });

/* ── Scene ── */
const W = { steps: [], i: 0, tier: clamp(+(store.lget('anatomy-tier') || 1), 1, 3), playing: false, speed: 1, e: 0, open: false, probsIdx: 0, layer: -1 };
const S = buildScene(M, { titles: stationTitles(M), shot: new URLSearchParams(location.search).has('shot'), keep: RECORD, sky: config.sky, onPick, onFrame, onDecodeStep: si => { if (cur()?.widget === 'steps') markStep(si); } });
if (T) S.setTrace(T);
W.steps = buildSteps(M, ctx());
function ctx() { return { trace: T, demo, maxTokens: config.maxTokens }; }
const cur = () => W.steps[W.i];

/* ── Step rail ── */
function renderRail() {
  let n = 0;
  $('journey').innerHTML = PHASES.map((ph, pi) => {
    const list = W.steps.map((s, i) => [s, i]).filter(([s]) => s.phase === pi); if (!list.length) return '';
    return `<div class="grp">${esc(ph)}</div>` + list.map(([s, i]) => `<button data-i="${i}" style="--sc:${S.SC[s.station] || S.COL.accent}"><span class="n">${++n}</span><span class="d"></span>${esc(s.title)}</button>`).join('');
  }).join('');
  markRail();
}
function markRail() { document.querySelectorAll('#journey button').forEach(b => b.classList.toggle('on', W.open && +b.dataset.i === W.i)); document.querySelector('#journey button.on')?.scrollIntoView({ block: 'nearest' }); }
$('journey').addEventListener('click', e => { const b = e.target.closest('button[data-i]'); if (b) go(+b.dataset.i); });

/* ── Going to a step ── */
function go(i, o = {}) {
  i = clamp(i, 0, W.steps.length - 1);
  const s = W.steps[i];
  if (s.needsTrace && !T && !o.noAuto) { ensureTrace().then(() => go(W.steps.findIndex(x => x.id === s.id), o)); return; }
  W.i = i; W.e = 0; W.open = true; W.probsIdx = s.probsAt ?? W.probsIdx;
  if (!o.keepLayer) {
    if (s.station === 'linear' || s.station === 'attn') { if (W.layer < 0 || !layerFits(W.layer, s.station)) W.layer = -1; }
    else if (s.station !== 'ffn') W.layer = -1;
  }
  if (W.layer >= 0) S.openLayer(W.layer); else if (!['linear', 'attn', 'ffn'].includes(s.station) && s.beat !== 'decode') S.closeLayer();
  S.beat(s.beat);
  if (s.beat !== 'intro' || o.dur === 0) S.flyTo(S.viewFor(s.station === 'hw' ? 'hw' : s.station), o.dur ?? 1.8);
  S.focus = s.station; S.show = { tokens: s.id === 'tokenize', probs: s.widget === 'probs', drafts: s.id === 'spec' || s.id === 'decode' };
  renderPanel(); markRail();
  if (!o.noHash) history.replaceState(null, '', '#step=' + s.id + (W.layer >= 0 ? ',' + (W.layer + 1) : ''));
}
const layerFits = (i, st) => (st === 'linear') === ['linear', 'ssm'].includes(M.types[i]);
function overview(o = {}) { W.open = false; W.playing = false; S.focus = null; S.show = {}; S.closeLayer(); W.layer = -1; $('panel').hidden = true; S.panelW = 0; document.body.classList.remove('panel-open'); S.flyTo(S.VIEWS.overview, o.dur); markRail(); history.replaceState(null, '', '#overview'); syncPlay(); }
function openLayer(i) {
  W.layer = clamp(i, 0, M.L - 1); S.openLayer(W.layer);
  const id = ['linear', 'ssm'].includes(M.types[W.layer]) ? 'linear' : 'attention';
  const j = W.steps.findIndex(s => s.id === id); if (j >= 0) go(j, { keepLayer: true });
}

/* ── The step panel ── */
function para(x) { const t = typeof x === 'string' ? x : x.text; const src = typeof x === 'string' ? '' : tag(x.src); return `<p>${esc(t)}${src}</p>`; }
function renderPanel() {
  const s = cur(), p = $('panel');
  p.style.setProperty('--sc', S.SC[s.station] || S.COL.accent);
  const n = W.steps.length, tier = W.tier;
  const layerSub = W.layer >= 0 && (s.id === 'linear' || s.id === 'attention') ? `<p class="p-sub">Layer ${W.layer + 1} of ${M.L} · ${esc(MIXNAME(M)[M.types[W.layer]])}${M.pleLayers.includes(W.layer) ? ' · receives the PLE rows' : ''}${M.marks.filter(m => m.layers.includes(W.layer)).map(m => ' · ' + esc(m.label)).join('')}</p>` : '';
  $('panel-body').innerHTML = `
    <div class="wt-head"><span class="wt-phase">${esc(PHASES[s.phase])}</span><span class="wt-n mono">${W.i + 1} / ${n}</span></div>
    <h2 class="p-title">${esc(s.title)}</h2><div class="p-kick">${esc(s.kicker || '')}</div>${layerSub}
    <div class="tiers" role="radiogroup" aria-label="Depth">${TIERS.map((t, j) => `<button role="radio" aria-checked="${tier === j + 1}" data-tier="${j + 1}" title="${esc(t)} (${j + 1})"><i>${j + 1}</i>${esc(t)}</button>`).join('')}</div>
    <p class="lead">${esc(s.t1)}</p>
    ${tier >= 2 && s.t2.length ? `<section class="tier2"><h4>Technical</h4>${s.t2.map(para).join('')}</section>` : ''}
    ${tier >= 3 && s.t3.length ? `<section class="tier3"><h4>Under the hood</h4>${s.t3.map(para).join('')}</section>` : ''}
    ${tier < 3 && (tier === 1 ? s.t2.length : s.t3.length) ? `<button class="deeper" data-tier="${tier + 1}">${tier === 1 ? 'Go deeper: the technical version' : 'Go deeper: under the hood'} ↓</button>` : ''}
    <div id="w-widget">${widget(s)}</div>
    <div id="p-live">${liveBox(s)}</div>
    ${tier >= 2 && s.facts?.length ? `<h4>The numbers</h4><dl class="facts">${s.facts.map(([k, v, src]) => `<dt>${esc(k)}</dt><dd>${esc(v)}${tag(src)}</dd>`).join('')}</dl>` : ''}
    ${s.id === 'hw' && M.pack?.credit && tier >= 3 ? `<p class="credit">${esc(M.pack.credit)}</p>` : ''}`;
  p.hidden = false; document.body.classList.add('panel-open'); S.panelW = innerWidth > 900 ? 456 : 1;
  $('wt-prev').disabled = W.i === 0; $('wt-next').disabled = W.i === n - 1;
  syncPlay();
  if (s.widget === 'prompt') wirePrompt();
}
$('panel-body').addEventListener('click', e => {
  const t = e.target.closest('[data-tier]'); if (t) { setTier(+t.dataset.tier); return; }
  const a = e.target.closest('[data-ans]'); if (a && T) { W.probsIdx = (W.probsIdx + +a.dataset.ans + T.out.length) % T.out.length; S.setAnswer(W.probsIdx); $('w-widget').innerHTML = widget(cur()); return; }
  const l = e.target.closest('[data-layer]'); if (l) { openLayer(+l.dataset.layer); return; }
  const st = e.target.closest('[data-step]'); if (st && T) { S.decodeStep?.(); markStep(+st.dataset.step); return; }
});
function setTier(t) { W.tier = clamp(t, 1, 3); store.lset('anatomy-tier', W.tier); if (!W.open) return; const sc = $('panel').scrollTop; renderPanel(); $('panel').scrollTop = sc; }
$('wt-prev').onclick = () => go(W.i - 1);
$('wt-next').onclick = () => go(W.i + 1);
$('wt-play').onclick = () => togglePlay();
$('wt-replay').onclick = () => go(W.i, { dur: 1.2 });
$('wt-speed').onclick = () => { const L = [1, 1.5, .6]; W.speed = L[(L.indexOf(W.speed) + 1) % L.length]; S.speed = W.speed; $('wt-speed').textContent = W.speed + '×'; };
$('panel-x').onclick = () => overview();
function togglePlay(on = !W.playing) { W.playing = on; if (on && !W.open) go(0); syncPlay(); }
function syncPlay() { $('wt-play').textContent = W.playing ? '❚❚' : '▶'; $('wt-play').setAttribute('aria-label', W.playing ? 'Pause' : 'Play the walkthrough'); $('b-walk').classList.toggle('on', W.open); document.body.classList.toggle('playing', W.playing); }
function stepDur(s) {   // reading time for what is on screen, plus the animation
  const words = [s.t1, ...(W.tier >= 2 ? s.t2 : []), ...(W.tier >= 3 ? s.t3 : [])].map(x => typeof x === 'string' ? x : x.text).join(' ').split(/\s+/).length;
  return clamp(4 + words / 3.4, 8, 45) + (s.beat === 'decode' ? 4 : 0);
}

/* ── Widgets: real data at the step ── */
function chipCls(t) { return t.special ? 'special' : /\w/.test(t.text) ? 'word' : ''; }
function widget(s) {
  const w = s.widget;
  if (w === 'prompt') {
    const presets = demo ? snaps.map(t => t.prompt.text) : [...new Set([...DEFAULT_PROMPTS, ...snaps.map(t => t.prompt.text)])];
    return `<form id="ask" class="ask" autocomplete="off">
      ${demo ? '' : `<label class="sr" for="ask-q">Your question</label><textarea id="ask-q" maxlength="2000" rows="2" placeholder="Ask ${esc(M.name)} anything…">${esc(T?.text || '')}</textarea>`}
      <div class="presets">${presets.map(p => `<button type="button" class="chip-btn${T?.text === p ? ' on' : ''}" data-preset="${esc(p)}">${esc(p)}</button>`).join('')}</div>
      ${demo ? '' : `<div class="ask-row"><button class="btn sm primary" id="ask-go" type="submit">Run it on ${esc(M.name.split(' ')[0])}</button><span class="ask-st" id="ask-st">${T ? `Showing: “${esc(T.text.slice(0, 60))}”` : 'No request yet.'}</span></div>
      <p class="privacy">Please don’t type personal information. Your question goes only to the model on this server and is not stored.</p>`}
    </form>`;
  }
  if (!T && s.needsTrace) return `<p class="muted">Run a question in step ${W.steps.findIndex(x => x.id === 'prompt') + 1} to see real data here.</p>`;
  if (w === 'tokens') return `<h4>Your prompt, exactly as the model sees it</h4><div class="chips">${T.tokens.map(t => `<span class="chip ${chipCls(t)}" title="token ${t.id}">${esc(showTok(t.text))}<i>${t.id}</i></span>`).join('')}</div>
    <div class="legend"><span><i class="lg special"></i>template / special</span><span><i class="lg word"></i>word piece</span><span><i class="lg other"></i>space, newline, punctuation</span></div>`;
  if (w === 'probs') {
    const i = clamp(W.probsIdx, 0, T.out.length - 1), x = T.out[i];
    return `<h4>The model’s real top five, token by token</h4>
      <div class="stepper"><button class="btn sm" data-ans="-1" aria-label="Previous token">‹</button><span>token ${i + 1} / ${T.out.length}</span><span class="so">${esc(showTok(x.text))}</span><button class="btn sm" data-ans="1" aria-label="Next token">›</button></div>
      <div class="bars">${(x.top || []).map(([t, p]) => `<div class="bar ${t === x.text ? 'win' : ''}"><span class="t">${esc(showTok(t))}</span><span class="track"><span class="fill" style="width:${Math.max(.5, (p || 0) * 100)}%"></span></span><span class="p">${pct(p)}</span></div>`).join('')}</div>
      <p class="ctx mono">${esc(T.out.slice(Math.max(0, i - 8), i).map(o => o.text).join('')).replace(/\n/g, '⏎')}<b>${esc(x.text).replace(/\n/g, '⏎')}</b></p>`;
  }
  if (w === 'layers') {
    const cols = M.L <= 16 ? M.L : M.L % 16 === 0 ? 16 : M.L % 12 === 0 ? 12 : 16;
    const present = [...new Set(M.types)];
    return `<h4>All ${M.L} layers · click one to open it</h4><div class="layermap" style="grid-template-columns:repeat(${cols},minmax(0,26px))">${M.types.map((t, i) =>
      `<button class="${t}${M.pleLayers.includes(i) ? ' ple' : ''}${M.marks.some(m => m.layers.includes(i)) ? ' ab' : ''}${i === W.layer ? ' cur' : ''}" data-layer="${i}" aria-label="Layer ${i + 1}, ${esc(MIXNAME(M)[t])}">${i + 1}</button>`).join('')}</div>
      <div class="legend">${present.map(t => `<span><i class="lg ${t}"></i>${esc(MIXNAME(M)[t])}</span>`).join('')}${M.pleLayers.length ? '<span><i class="lg pleb"></i>PLE input</span>' : ''}${M.marks.map(m => `<span><i class="lg dotw"></i>${esc(m.label)}</span>`).join('')}</div>`;
  }
  if (w === 'memory' && M.memory) { const t = M.memory.regions.reduce((a, r) => a + r.bytes, 0);
    return `<div class="membar">${M.memory.regions.map(r => `<i style="width:${r.bytes / t * 100}%;background:${r.color}" title="${esc(r.label)}"></i>`).join('')}</div>
      <div class="memrows">${M.memory.regions.map(r => `<div><i style="background:${r.color}"></i><span>${esc(r.label)} ${tag(r.src)}</span><span class="g">${bytes(r.bytes)}</span><small>${esc(r.note)}</small></div>`).join('')}</div>`; }
  if (w === 'steps') {
    const k = M.spec?.k || 0, rows = T.steps.slice(0, 40);
    return `<h4>Every engine step of your reply${k ? ` · drafts accepted per step (of ${k})` : ''}</h4>
      ${k ? `<div class="accrow">${T.acc.map((p, j) => `<div><span>draft ${j + 1}</span><span class="track"><span class="fill" style="width:${(p || 0) * 100}%"></span></span><span class="p">${pct(p, 0)}</span></div>`).join('')}</div>` : ''}
      <ol class="steps">${rows.map((st, si) => `<li data-step="${si}" class="${si === 0 ? 'pre' : ''}"><span class="t mono">${ms(st.t_ms)}</span><span class="toks">${st.tokens.map((x, j) => `<span class="tk ${si === 0 ? 'first' : j < st.n - 1 ? 'acc' : 'own'}">${esc(showTok(x.text))}</span>`).join('')}</span>${k && si ? `<span class="n mono">${st.n - 1}/${k}</span>` : ''}</li>`).join('')}</ol>
      <div class="legend">${k ? '<span><i class="lg acc"></i>accepted draft</span><span><i class="lg own"></i>the model’s own token</span>' : ''}<span><i class="lg first"></i>first token (after prefill)</span></div>`;
  }
  if (w === 'reply') return `<h4>The reply, chunk by chunk</h4><div class="reply">${T.steps.map((st, si) => `<span class="ck c${si % 2}" title="step ${si + 1} · ${ms(st.t_ms)}">${esc(st.tokens.map(x => x.text).join(''))}</span>`).join('')}</div>`;
  if (w === 'summary') return `<div class="sumgrid">
      <div><b class="mono">${T.n}</b><span>prompt tokens</span></div><div><b class="mono">${T.nOut}</b><span>reply tokens</span></div>
      <div><b class="mono">${T.steps.length}</b><span>engine steps</span></div><div><b class="mono">${ms(T.ttft)}</b><span>first token</span></div>
      <div><b class="mono">${T.stepMs ? ms(T.stepMs) : '–'}</b><span>per step</span></div><div><b class="mono">${ms(T.total)}</b><span>whole reply</span></div></div>
      <p class="muted">Measured ${demo ? 'when this snapshot was captured' : 'on your request'}${T.when ? `, ${esc(T.when.replace('T', ' ').slice(0, 16))} UTC` : ''}.</p>`;
  return '';
}
function markStep(si) { document.querySelectorAll('#w-widget li[data-step]').forEach(li => li.classList.toggle('now', +li.dataset.step === si)); }

/* ── Asking your own question ── */
function wirePrompt() {
  const f = $('ask'); if (!f) return;
  f.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => {
    if (demo) { const t = snaps.find(x => x.prompt.text === b.dataset.preset); if (t) useTrace(t, true); return; }
    $('ask-q').value = b.dataset.preset; f.requestSubmit();
  });
  f.onsubmit = async e => { e.preventDefault(); const q = $('ask-q')?.value.trim(); if (!q) return; await ask(q, true); };
  $('ask-q')?.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); f.requestSubmit(); } });
}
let asking = null;
async function ask(q, advance) {
  if (asking) return asking;
  const st = $('ask-st'), go_ = $('ask-go');
  if (st) st.textContent = `Running on ${M.name}…`; if (go_) go_.disabled = true;
  asking = runTrace(q).then(t => { useTrace(t, advance); }).catch(e => {
    const msg = e.status === 429 ? 'Another request is running; try again in a moment.' : e.status === 502 ? 'No model is answering right now.' : `Could not run it: ${e.message}`;
    if ($('ask-st')) $('ask-st').textContent = msg; else toast(msg);
  }).finally(() => { asking = null; if ($('ask-go')) $('ask-go').disabled = false; });
  return asking;
}
function useTrace(raw, advance) {
  T = traceModel(raw, M); S.setTrace(T); store.set('anatomy-trace:' + M.id, JSON.stringify(raw));
  const id = cur()?.id; W.steps = buildSteps(M, ctx()); renderRail();
  const i = W.steps.findIndex(s => s.id === id);
  if (advance && id === 'prompt') go(i + 1); else if (W.open) go(Math.max(0, i), { dur: 0 });
}
async function ensureTrace() {
  if (T) return;
  if (demo) { if (snaps[0]) useTrace(snaps[0], false); return; }
  toast(`Running a sample question on ${M.name} so the next steps have real data…`);
  await ask(DEFAULT_PROMPTS[0], false);
  if (!T && snaps[0]) useTrace(snaps[0], false);
}
function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 5000); }

/* ── Picking things in the scene ── */
function onPick(p) {
  if (p.type === 'layer') { openLayer(p.i); return; }
  const id = p.type === 'rig' ? p.id : p.id;
  const sid = id === 'attn' ? 'attention' : STATION_STEP[id];
  const j = W.steps.findIndex(s => s.id === sid);
  if (j >= 0) go(j, { keepLayer: p.type === 'rig' });
}

/* ── Live mode ── */
const live = { on: false, feed: null, state: null };
const K = M.spec?.k || 0;
$('acc').innerHTML = Array.from({ length: K }, (_, j) => `<i id="a${j}"></i>`).join(''); $('hud-acc').hidden = !K;
async function toggleLive() {
  if (demo) { toast('Live mode needs the probe: this page is showing saved data.'); return; }
  live.on = !live.on; S.live = live.on; $('b-live').setAttribute('aria-pressed', live.on); $('hud').hidden = !live.on; document.body.classList.toggle('live', live.on);
  if (!live.on) { live.feed?.stop(); S.resetLive(); $('live-dot').className = 'dot warn'; return; }
  const { LiveFeed } = await import('./live.js');
  live.feed = new LiveFeed({ metricsUrl: config.api + 'metrics', statusUrl: config.api + 'status', intervalMs: 1000, positions: K });
  live.feed.onUpdate(onLive); live.feed.start();
}
function onLive(u) {
  if (!u.ok) { $('hud-state').textContent = 'No model answering'; $('hud-dot').className = 'dot crit'; $('live-dot').className = 'dot crit'; return; }
  const s = live.state = u.state, f = (v, d = 0) => v == null || Number.isNaN(v) ? '–' : (+v).toFixed(d);
  const busy = (s.running ?? 0) > 0 || (s.genTokPerSec ?? 0) > .5;
  $('hud-state').textContent = busy ? 'Live · generating' : 'Live · idle'; $('hud-dot').className = busy ? 'dot' : 'dot idle'; $('live-dot').className = busy ? 'dot' : 'dot warn';
  $('hud-model').textContent = s.model || ''; $('h-gen').textContent = f(s.genTokPerSec, 1); $('h-pre').textContent = f(s.promptTokPerSec);
  $('h-step').textContent = f(s.stepMs, 1); $('h-tps').textContent = f(s.tokensPerStep, 2); $('h-run').textContent = f(s.running); $('h-wait').textContent = s.waiting ? `+${s.waiting} waiting` : M.slots ? `of ${M.slots}` : 'running';
  $('h-kv').textContent = f((s.kvUsage ?? 0) * 100, 1); $('h-pow').textContent = f(s.gpu?.powerW, 1); $('h-temp').textContent = f(s.gpu?.tempC);
  if (K && s.acceptance?.every(x => x != null)) { s.acceptance.forEach((p, j) => { const el = $('a' + j); if (el) el.style.height = Math.max(4, p * 100) + '%'; }); $('h-acc').textContent = s.acceptance.map(p => (p * 100).toFixed(0)).join(' / ') + ' %'; }
  if (W.open) $('p-live').innerHTML = liveBox(cur());
}
function liveBox(s) {
  const L = live.state; if (!live.on || !L || !s) return '';
  const f = (v, d = 0) => v == null ? '–' : (+v).toFixed(d);
  const m = { api: `${f(L.running)} running · ${f(L.waiting)} waiting · TTFT ${f(L.ttftMs)} ms`, schedule: `${f(L.running)}${M.slots ? ' of ' + M.slots : ''} seats busy · KV ${f((L.kvUsage ?? 0) * 100, 1)}%`,
    stack: `${f(L.stepMs, 1)} ms per step · ${f(L.tokensPerStep, 2)} tokens per step`, decode: `${f(L.stepMs, 1)} ms per step · ${f(L.genTokPerSec, 1)} tok/s out`, spec: `${f(L.tokensPerStep, 2)} tokens per step right now`,
    stream: `${f(L.genTokPerSec, 1)} tok/s out`, embed: `${f(L.promptTokPerSec)} prompt tok/s`, memory: `KV cache ${f((L.kvUsage ?? 0) * 100, 1)}% used`, hw: `GPU ${f(L.gpu?.powerW, 1)} W · ${f(L.gpu?.tempC)} °C · ${f(L.memUsedGiB, 1)} GiB used` }[s.id];
  return m ? `<div class="livebox"><b>● Live</b> ${esc(m)}</div>` : '';
}

/* ── Per-frame: autoplay, ambience, live ── */
let wall = performance.now();
function onFrame(dt) {
  const now = performance.now(), real = Math.min(1, (now - wall) / 1000); wall = now;   // autoplay keeps reading pace even when frames are slow
  if (live.on) S.liveTick(dt, live.state); else if (!W.playing) S.ambience(dt);
  if (W.playing && W.open) { W.e += real * W.speed; if (W.e > stepDur(cur())) { if (W.i >= W.steps.length - 1) { W.playing = false; syncPlay(); } else go(W.i + 1); } }
}

/* ── Watching for a model switch ── */
if (!demo) setInterval(async () => {
  try { const s = await status(); if (s.active && s.active !== M.id) { const b = $('banner'); b.innerHTML = `The server is now serving <b>${esc(s.active)}</b>. <button class="btn sm" id="rebuild">Rebuild for it</button> <button class="banner-x" aria-label="Dismiss">×</button>`; b.hidden = false; $('rebuild').onclick = () => location.reload(); } } catch { }
}, 20000);

/* ── Keyboard and buttons ── */
addEventListener('keydown', e => {
  if (e.target.closest?.('input,textarea,select')) return;
  const k = e.key;
  if (k === ' ' && e.target.closest?.('button,a')) return;   // Space already presses a focused button
  if (k === 'Escape') { if (W.layer >= 0 && W.open) { W.layer = -1; S.closeLayer(); renderPanel(); } else overview(); }
  else if (k === 'ArrowRight') go(W.open ? W.i + 1 : 0);
  else if (k === 'ArrowLeft') go(W.open ? W.i - 1 : 0);
  else if (k === '1' || k === '2' || k === '3') { if (W.open) setTier(+k); }
  else if (k === ' ') { e.preventDefault(); togglePlay(); }
  else if (k === 't' || k === 'T' || k === 'w' || k === 'W') { if (!W.open) go(0); togglePlay(true); }
  else if (k === 'l' || k === 'L') toggleLive();
  else if (k === 'o' || k === 'O') overview();
  else if (k === 'm' || k === 'M') { const j = W.steps.findIndex(s => s.id === 'memory'); if (j >= 0) go(j); }
  else if (k === 'a' || k === 'A') go(W.steps.findIndex(s => s.id === 'prompt'));
});
$('b-walk').onclick = () => { if (W.open && W.playing) togglePlay(false); else { if (!W.open) go(0); togglePlay(true); } };
$('b-ask').onclick = () => { go(W.steps.findIndex(s => s.id === 'prompt')); setTimeout(() => $('ask-q')?.focus(), 50); };
$('b-live').onclick = () => toggleLive();
$('b-overview').onclick = () => overview();
if (demo) $('b-live').hidden = true;

/* ── Routes: #overview, #step=<id>[,<layer>], #s=<station>, #layer=<n>, #live ── */
function route() {
  const h = decodeURIComponent(location.hash.slice(1)); let m;
  if (!h || h === 'exterior') { S.flyTo(S.VIEWS.exterior, 0); return false; }
  if (h === 'overview') { overview({ dur: 0 }); return true; }
  if (h === 'live') { overview({ dur: 0 }); if (!live.on) toggleLive(); return true; }
  if ((m = h.match(/^step=([\w-]+)(?:,(\d+))?$/))) { const j = /^\d+$/.test(m[1]) ? +m[1] - 1 : W.steps.findIndex(s => s.id === m[1]); if (m[2]) { W.layer = clamp(+m[2] - 1, 0, M.L - 1); S.openLayer(W.layer); } if (j >= 0) go(j, { dur: 0, keepLayer: !!m[2] }); return true; }
  if ((m = h.match(/^tour=(\d+)$/))) { go(+m[1] - 1, { dur: 0 }); return true; }
  if ((m = h.match(/^s=(\w+)$/))) { onPick({ type: 'station', id: m[1] }); return true; }
  if ((m = h.match(/^layer=(\d+)$/))) { openLayer(+m[1] - 1); return true; }
  return false;
}
addEventListener('hashchange', route);
renderRail();
const routed = route();
document.querySelectorAll('[data-ic]').forEach(el => { const I = { chip: '<rect x="3" y="8" width="18" height="9" rx="2"/><path d="M7 12.5h.01M11 12.5h6"/>', eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', play: '<path d="M7 5v14l11-7z"/>',
  pulse: '<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>', ask: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>', back: '<path d="M15 18l-6-6 6-6"/>' }[el.dataset.ic];
  el.innerHTML = `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I || ''}</svg>`; });
if (new URLSearchParams(location.search).has('shot')) document.body.classList.add('shot');
if (RECORD) { document.body.classList.add('record'); $('banner').hidden = true; }
setTimeout(() => { $('loading').classList.add('gone'); if (!routed && !REDUCED && !RECORD) setTimeout(() => S.flyTo(S.VIEWS.overview, 3.2), 900); }, 250);
/* ── Where the background is, and the time slider ── */
if (S.sky) skyTime(S.sky, config.sky);

window.__viz = { sky: () => S.sky?.info(), stats: () => ({ ...S.stats(), step: W.open ? cur().id : null, tier: W.tier, live: live.on, demo, model: M.id, trace: T ? { n: T.n, out: T.nOut, steps: T.steps.length } : null }), go, overview, setTier, M, steps: () => W.steps.map(s => s.id),
  // for record mode: the scene, the current trace, and switching to a saved question
  S, get T() { return T; }, step: id => go(W.steps.findIndex(s => s.id === id)), useSnapshot: text => { const t = snaps.find(x => x.prompt.text === text); if (t) useTrace(t, false); return !!t; } };
