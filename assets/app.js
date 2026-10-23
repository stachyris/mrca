'use strict';

// Relationship columns in the CSV and the edge type each one produces.
const RELATIONS = { advisors: 'advisor', collaborators: 'collab', opposition: 'opposition' };
// Columns with their own place in the panel; any other column is shown under its own heading.
const CORE = new Set(['id', 'name', 'label', 'years', 'era', 'institution', 'field', 'desc', 'contributions', ...Object.keys(RELATIONS)]);
const EDGE_STYLE = {
  advisor:    { rgb: '200,169,110', dash: [],     label: 'Advisor → student' },
  collab:     { rgb: '94,155,116',  dash: [4, 4], label: 'Collaboration' },
  opposition: { rgb: '200,120,120', dash: [2, 5], label: 'Opposition' },
};
const FALLBACK_COLORS = ['#b5a46e', '#8fa3c8', '#c89a7e', '#9ec8a0', '#c8a0c0', '#a0a0a0'];
const SIM_STEPS = 300;

const $ = id => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');

const state = {
  config: { eras: [] }, eras: {}, columns: [], nodes: [], edges: [], byId: {}, adj: {}, issues: [],
  source: '', loadError: '',
  view: { x: 0, y: 0, k: 1 }, W: 0, H: 0, viewMoved: false,
  hover: null, selected: null, era: 'all', query: '', simLeft: 0,
};

// ─── CSV ─────────────────────────────────────────────────────────
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = (rows.shift() || []).map(h => h.trim().toLowerCase());
  const records = rows
    .filter(r => r.some(v => v.trim()))
    .map(r => Object.fromEntries(header.map((h, i) => [h, (r[i] || '').trim()])));
  return { header, records };
}

const splitList = s => (s || '').split(';').map(x => x.trim()).filter(Boolean);

// ─── Data → graph ────────────────────────────────────────────────
function buildGraph({ header, records }) {
  if (!header.includes('id') || !header.includes('name')) {
    throw new Error('The CSV needs at least an "id" and a "name" column.');
  }
  const issues = [], nodes = [], byId = {};
  for (const r of records) {
    if (!r.id) { issues.push(`The row for "${r.name || '?'}" has no id, so it was skipped.`); continue; }
    if (byId[r.id]) { issues.push(`The id "${r.id}" appears twice; only the first row is used.`); continue; }
    const n = { ...r, era: r.era || 'unassigned', contributions: splitList(r.contributions), x: 0, y: 0, vx: 0, vy: 0, visible: true };
    nodes.push(n);
    byId[r.id] = n;
  }

  const edges = [], seen = new Set();
  for (const n of nodes) {
    for (const [col, type] of Object.entries(RELATIONS)) {
      for (const other of splitList(n[col])) {
        if (other === n.id) continue;
        if (!byId[other]) { issues.push(`"${n.id}" lists "${other}" under ${col}, but no row has that id.`); continue; }
        const [s, t] = type === 'advisor' ? [other, n.id] : [n.id, other].sort();
        const key = `${type}|${s}|${t}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ source: byId[s], target: byId[t], type });
      }
    }
  }

  const eras = {};
  for (const e of state.config.eras || []) eras[e.id] = { ...e };
  let extra = 0;
  for (const n of nodes) {
    if (eras[n.era]) continue;
    eras[n.era] = { id: n.era, label: n.era.replace(/_/g, ' '), color: FALLBACK_COLORS[extra++ % FALLBACK_COLORS.length] };
    issues.push(`The era "${n.era}" isn't defined in config.json, so it was given a default color.`);
  }

  const adj = Object.fromEntries(nodes.map(n => [n.id, new Set()]));
  for (const e of edges) { adj[e.source.id].add(e.target.id); adj[e.target.id].add(e.source.id); }
  const lonely = nodes.filter(n => !adj[n.id].size).length;
  if (lonely) issues.push(`${lonely} ${lonely === 1 ? 'person has' : 'people have'} no links yet.`);

  Object.assign(state, { columns: header, nodes, edges, byId, adj, eras, issues, hover: null, selected: null, loadError: '' });
}

async function loadFromURL(url) {
  state.source = url;
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    useCSV(await res.text());
  } catch (err) {
    state.loadError = location.protocol === 'file:'
      ? 'Browsers block pages opened from disk from reading other files. Run "python3 -m http.server" in this folder and open http://localhost:8000, or use Load CSV.'
      : `Couldn't load ${url} (${err.message}).`;
    renderOverview();
  }
}

function loadFromFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { state.source = `${file.name} (uploaded, not saved)`; useCSV(reader.result); };
  reader.readAsText(file);
}

function useCSV(text) {
  try {
    buildGraph(parseCSV(text));
  } catch (err) {
    state.loadError = err.message;
    renderOverview();
    return;
  }
  renderFilters();
  renderLegend();
  applyFilters();
  layout();
  renderOverview();
}

// ─── Layout and simulation ───────────────────────────────────────
function layout() {
  const order = Object.keys(state.eras);
  state.nodes.forEach(n => {
    const angle = (order.indexOf(n.era) / order.length) * Math.PI * 2;
    const r = 200 + Math.random() * 120;
    n.x = Math.cos(angle) * r + (Math.random() - 0.5) * 100;
    n.y = Math.sin(angle) * r + (Math.random() - 0.5) * 100;
    n.vx = n.vy = 0;
  });
  for (let i = 0; i < SIM_STEPS; i++) tick();
  state.simLeft = 0;
  fitView();
}

function tick() {
  const vis = state.nodes.filter(n => n.visible);
  for (let i = 0; i < vis.length; i++) {
    for (let j = i + 1; j < vis.length; j++) {
      const a = vis[i], b = vis[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 0.1;
      const f = 3200 / (d * d);
      a.vx -= dx / d * f; a.vy -= dy / d * f;
      b.vx += dx / d * f; b.vy += dy / d * f;
    }
  }
  for (const e of state.edges) {
    const s = e.source, t = e.target;
    if (!s.visible || !t.visible) continue;
    const dx = t.x - s.x, dy = t.y - s.y;
    const d = Math.hypot(dx, dy) || 0.1;
    const f = (d - (e.type === 'advisor' ? 120 : 100)) * 0.03;
    s.vx += dx / d * f; s.vy += dy / d * f;
    t.vx -= dx / d * f; t.vy -= dy / d * f;
  }
  for (const n of vis) {
    n.vx = (n.vx - n.x * 0.008) * 0.82;
    n.vy = (n.vy - n.y * 0.008) * 0.82;
    n.x += n.vx; n.y += n.vy;
  }
}

function fitView() {
  const vis = state.nodes.filter(n => n.visible);
  if (!vis.length || !state.W) return;
  const xs = vis.map(n => n.x), ys = vis.map(n => n.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const k = Math.min(state.W / (x1 - x0 + 80), state.H / (y1 - y0 + 80), 1.6);
  state.view = { k, x: state.W / 2 - (x0 + x1) / 2 * k, y: state.H / 2 - (y0 + y1) / 2 * k };
  state.viewMoved = false;
}

// ─── Drawing ─────────────────────────────────────────────────────
function resize() {
  const dpr = window.devicePixelRatio || 1;
  state.W = canvas.clientWidth;
  state.H = canvas.clientHeight;
  canvas.width = state.W * dpr;
  canvas.height = state.H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

const isNeighbor = (n, of) => of && state.adj[of.id] && state.adj[of.id].has(n.id);

function draw() {
  if (state.simLeft > 0) { tick(); state.simLeft--; }
  const { view, hover, selected } = state;
  const focus = hover || selected;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, state.W, state.H);
  ctx.translate(view.x, view.y);
  ctx.scale(view.k, view.k);

  for (const e of state.edges) {
    const s = e.source, t = e.target;
    if (!s.visible || !t.visible) continue;
    const lit = focus && [hover, selected].some(f => f && (f === s || f === t));
    const style = EDGE_STYLE[e.type];
    const color = `rgba(${style.rgb},${lit ? 0.9 : 0.2})`;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(t.x, t.y);
    ctx.strokeStyle = color;
    ctx.lineWidth = lit ? 1.8 : 1;
    ctx.setLineDash(style.dash);
    ctx.stroke();
    ctx.setLineDash([]);
    if (e.type === 'advisor') {
      const a = Math.atan2(t.y - s.y, t.x - s.x);
      const ax = t.x - Math.cos(a) * 12, ay = t.y - Math.sin(a) * 12;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - 8 * Math.cos(a - 0.4), ay - 8 * Math.sin(a - 0.4));
      ctx.lineTo(ax - 8 * Math.cos(a + 0.4), ay - 8 * Math.sin(a + 0.4));
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    }
  }

  for (const n of state.nodes) {
    if (!n.visible) continue;
    const isHover = n === hover, isSel = n === selected;
    const near = isNeighbor(n, hover) || isNeighbor(n, selected);
    const dim = focus && !isHover && !isSel && !near;
    const color = state.eras[n.era].color;
    const r = isSel ? 13 : isHover ? 11 : 9;

    if (isHover || isSel) {
      const g = ctx.createRadialGradient(n.x, n.y, r, n.x, n.y, r + 10);
      g.addColorStop(0, color + '55');
      g.addColorStop(1, 'transparent');
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + 10, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fillStyle = dim ? color + '33' : color;
    ctx.fill();
    ctx.strokeStyle = isSel ? '#fff' : isHover ? '#ffffffbb' : color + '88';
    ctx.lineWidth = isSel ? 2 : 1;
    ctx.stroke();

    if (isHover || isSel || near || (view.k > 1.3 && !dim)) {
      ctx.font = `${isSel ? '600 ' : ''}${11 / Math.max(view.k, 1)}px "Source Serif 4", serif`;
      ctx.fillStyle = isSel || isHover ? '#e8dfc8' : '#e8dfc8aa';
      ctx.textAlign = 'center';
      ctx.fillText(n.label || n.name.split(' ').pop(), n.x, n.y + r + 13 / Math.max(view.k, 1));
    }
  }
  requestAnimationFrame(draw);
}

// ─── Interaction ─────────────────────────────────────────────────
function nodeAt(cx, cy) {
  const { x, y, k } = state.view;
  const wx = (cx - x) / k, wy = (cy - y) / k;
  let best = null, bestD = Infinity;
  for (const n of state.nodes) {
    if (!n.visible) continue;
    const d = Math.hypot(n.x - wx, n.y - wy);
    if (d < 9 + 8 / k && d < bestD) { best = n; bestD = d; }
  }
  return best;
}

function zoomAt(cx, cy, factor) {
  const v = state.view;
  const k = Math.max(0.2, Math.min(5, v.k * factor));
  v.x = cx - (cx - v.x) * (k / v.k);
  v.y = cy - (cy - v.y) * (k / v.k);
  v.k = k;
  state.viewMoved = true;
}

const pointers = new Map();
let gesture = null;

canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  const pts = [...pointers.values()];
  gesture = pts.length === 1
    ? { start: pts[0], view: { ...state.view }, moved: false }
    : { pinch: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), moved: true };
});

canvas.addEventListener('pointermove', e => {
  const p = { x: e.offsetX, y: e.offsetY };
  if (!pointers.has(e.pointerId)) {
    state.hover = nodeAt(p.x, p.y);
    canvas.classList.toggle('pointing', !!state.hover);
    return;
  }
  pointers.set(e.pointerId, p);
  const pts = [...pointers.values()];
  if (pts.length === 2 && gesture.pinch) {
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    zoomAt((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2, d / gesture.pinch);
    gesture.pinch = d;
  } else if (gesture.start) {
    const dx = p.x - gesture.start.x, dy = p.y - gesture.start.y;
    if (Math.hypot(dx, dy) > 4) gesture.moved = true;
    if (gesture.moved) {
      canvas.classList.add('dragging');
      state.view.x = gesture.view.x + dx;
      state.view.y = gesture.view.y + dy;
      state.viewMoved = true;
    }
  }
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  canvas.classList.remove('dragging');
  if (gesture && !gesture.moved && !pointers.size) select(nodeAt(e.offsetX, e.offsetY));
  if (!pointers.size) gesture = null;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => { if (!pointers.size) state.hover = null; });

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  zoomAt(e.offsetX, e.offsetY, e.deltaY > 0 ? 0.9 : 1.1);
}, { passive: false });

$('fitBtn').addEventListener('click', fitView);
$('search').addEventListener('input', e => { state.query = e.target.value; applyFilters(); });
$('loadBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', e => { loadFromFile(e.target.files[0]); e.target.value = ''; });

let dragDepth = 0;
window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; $('dropOverlay').classList.add('visible'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').classList.remove('visible'); } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  $('dropOverlay').classList.remove('visible');
  loadFromFile(e.dataTransfer.files[0]);
});

// Re-fit when the canvas changes size (first layout, window resize, rotation) unless the view was panned or zoomed.
new ResizeObserver(() => { resize(); if (!state.viewMoved) fitView(); }).observe(canvas);

// ─── Filters and legend ──────────────────────────────────────────
function renderFilters() {
  const used = new Set(state.nodes.map(n => n.era));
  const eras = [{ id: 'all', label: 'All' }, ...Object.values(state.eras).filter(e => used.has(e.id))];
  if (!used.has(state.era)) state.era = 'all';
  $('filters').replaceChildren(...eras.map(era => {
    const b = el('button', 'filter-btn' + (era.id === state.era ? ' active' : ''), era.label);
    b.type = 'button';
    if (era.color) b.style.setProperty('--era', era.color);
    b.addEventListener('click', () => {
      state.era = era.id;
      $('filters').querySelectorAll('.filter-btn').forEach(x => x.classList.toggle('active', x === b));
      applyFilters();
    });
    return b;
  }));
}

function renderLegend() {
  const used = new Set(state.nodes.map(n => n.era));
  const items = Object.values(state.eras).filter(e => used.has(e.id)).map(e => {
    const dot = el('div', 'legend-dot');
    dot.style.background = e.color;
    return el('div', 'legend-item', dot, e.label);
  });
  for (const style of Object.values(EDGE_STYLE)) {
    const line = el('div', 'legend-line');
    line.style.borderTop = `2px ${style.dash.length ? 'dashed' : 'solid'} rgba(${style.rgb},0.8)`;
    items.push(el('div', 'legend-item', line, style.label));
  }
  $('legend').replaceChildren(...items);
}

function applyFilters() {
  const q = state.query.toLowerCase().trim();
  for (const n of state.nodes) {
    const text = [n.name, n.label, n.field, n.institution, ...n.contributions].join(' ').toLowerCase();
    n.visible = (state.era === 'all' || n.era === state.era) && (!q || text.includes(q));
  }
  if (state.selected && !state.selected.visible) select(null);
  state.simLeft = 200;
}

// ─── Panel ───────────────────────────────────────────────────────
function el(tag, cls, ...children) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  node.append(...children.filter(c => c !== null && c !== undefined));
  return node;
}

function section(title, ...children) {
  return el('div', 'section', el('div', 'section-title', title), ...children);
}

function personLinks(people, cls = '') {
  return people.map(p => {
    const b = el('button', 'person-link ' + cls, p.name);
    b.type = 'button';
    b.addEventListener('click', () => select(p));
    return b;
  });
}

function select(n) {
  state.selected = n;
  n ? renderPerson(n) : renderOverview();
}

function renderPerson(n) {
  const era = state.eras[n.era];
  const badge = el('span', 'era-badge', era.label);
  badge.style.background = era.color;
  const related = (type, dir) => state.edges
    .filter(e => e.type === type && (dir === 'in' ? e.target === n : dir === 'out' ? e.source === n : e.source === n || e.target === n))
    .map(e => (e.source === n ? e.target : e.source));

  const parts = [
    el('div', null, el('div', 'panel-name', n.name), n.years ? el('div', 'panel-years', n.years) : null, badge),
    n.institution || n.field ? el('div', 'panel-inst', [n.institution, n.field].filter(Boolean).join(' · ')) : null,
    n.desc ? el('div', 'panel-desc', n.desc) : null,
    n.contributions.length ? section('Key contributions', el('div', 'tag-list', ...n.contributions.map(c => el('div', 'tag', c)))) : null,
  ];
  const groups = [
    ['Advisor(s)', related('advisor', 'in'), ''],
    ['Students / advisees', related('advisor', 'out'), ''],
    ['Collaborators', related('collab'), 'collab'],
    ['Opposed', related('opposition'), 'opposition'],
  ];
  for (const [title, people, cls] of groups) if (people.length) parts.push(section(title, ...personLinks(people, cls)));
  for (const key of state.columns) {
    if (!CORE.has(key) && n[key]) parts.push(section(key.replace(/_/g, ' '), el('div', 'panel-desc', n[key])));
  }
  $('panel').replaceChildren(...parts.filter(Boolean));
  $('panel').scrollTop = 0;
}

function renderOverview() {
  const parts = [];
  if (state.loadError) {
    parts.push(section('Could not load data', el('ul', 'issues', el('li', 'error', state.loadError))));
  }
  if (state.nodes.length) {
    const stat = (num, label) => el('div', 'stat', el('b', null, String(num)), el('span', null, label));
    parts.push(el('div', 'stats', stat(state.nodes.length, 'people'), stat(state.edges.length, 'links')));
    parts.push(el('p', null, 'Click any node to see a researcher\'s contributions, advisors, students and collaborators.'));
  }
  parts.push(section('Data source', el('div', 'source', state.source || '—')));
  if (state.issues.length) {
    parts.push(section(`Check the data (${state.issues.length})`, el('ul', 'issues', ...state.issues.map(t => el('li', null, t)))));
  }
  const template = el('a', null, 'Download the current CSV');
  template.href = state.config.data || 'data/people.csv';
  template.download = '';
  parts.push(section('Updating the network',
    el('p', null, 'Edit ', el('code', null, 'data/people.csv'), ' in the repository, or use Load CSV to preview a file here without saving it. ',
      'List advisors, collaborators and opposition as ids separated by semicolons.'),
    el('p', null, template)));
  $('panel').replaceChildren(...parts);
}

// ─── Start ───────────────────────────────────────────────────────
async function init() {
  resize();
  try {
    const res = await fetch('config.json', { cache: 'no-cache' });
    if (res.ok) state.config = await res.json();
  } catch { /* fall back to defaults */ }
  const { title, subtitle } = state.config;
  if (title) { $('title').textContent = title; document.title = subtitle ? `${title} — ${subtitle}` : title; }
  if (subtitle) $('subtitle').textContent = subtitle;
  const dataURL = new URLSearchParams(location.search).get('data') || state.config.data || 'data/people.csv';
  renderOverview();
  draw();
  await loadFromURL(dataURL);
}

init();
