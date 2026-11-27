import { BLEND_MODES, EDIT_MAX_LAYERS, EDIT_MAX_PIXELS, parseEditProject, snapAxis, zoomStep } from '@brennglas/shared';
import type { BlendMode, EditLayer, EditProject, Generation, LayerSource } from '@brennglas/shared';
import { api, GEN_DRAG, imageUrl, inputUrl } from '../api.ts';
import { h } from '../dom.ts';
import { t } from '../i18n.ts';
import { ASPECTS } from './input-panel.ts';

/** Bildbearbeitung → plan_bildbearbeitung: links Arbeitsfläche, Werkzeug und Ebenen, in der Mitte die Fläche. */
const OP: Record<BlendMode, GlobalCompositeOperation> = {
  normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay', 'soft-light': 'soft-light', 'color-dodge': 'color-dodge',
};
const BLEND_KEY = {
  normal: 'ie.blend.normal', multiply: 'ie.blend.multiply', screen: 'ie.blend.screen', overlay: 'ie.blend.overlay',
  'soft-light': 'ie.blend.softLight', 'color-dodge': 'ie.blend.colorDodge',
} as const;
const TOOLS = ['move', 'brush', 'eraser', 'pick'] as const;
type ToolName = (typeof TOOLS)[number];
const TOOL_KEY = { brush: 'ie.tool.brush', eraser: 'ie.tool.eraser', move: 'ie.tool.move', pick: 'ie.tool.pick' } as const;
const HINT_KEY = { brush: 'ie.hint.brush', eraser: 'ie.hint.eraser', move: 'ie.hint.move', pick: 'ie.hint.pick' } as const;
const TOOL_HOTKEY: Record<string, ToolName> = { b: 'brush', e: 'eraser', v: 'move', i: 'pick' };
const SIZES = [1, 2, 4] as const;
const HISTORY = 40;
/** Einrasten ab diesem Abstand in Bildschirmpixeln. */
const SNAP_PX = 8;

interface Layer {
  kind: 'image' | 'fill';
  name: string;
  visible: boolean;
  opacity: number;
  blend: BlendMode;
  x: number;
  y: number;
  scale: number;
  flip: boolean;
  color: string;
  /** Bildebene: die Pixel, verändert sich beim Malen. */
  canvas: HTMLCanvasElement | null;
  /** Wo die Pixel unverändert liegen; null = neu oder bemalt, wird beim Speichern hochgeladen. */
  src: LayerSource | null;
}
type Meta = Omit<Layer, 'canvas' | 'src'>;
interface Snap { w: number; h: number; layers: Layer[]; meta: Meta[]; active: Layer | null }
interface Step { undo(): void; redo(): void }

export interface ImageEdit {
  settings: HTMLElement;
  stage: HTMLElement;
  /** Galerie-Bild als neue Ebene; ist die Fläche leer, gibt es ihre Größe vor. */
  add(g: Generation): void;
  /** Gespeicherte Bildbearbeitung wieder öffnen (rückgängig machbar). */
  open(g: Generation): void;
  /** Als neues Bild in die Galerie; wirft mit Meldung für das Formular. */
  save(): Promise<Generation>;
  enter(): void;
  leave(): void;
}

const canvasOf = (w: number, h: number) => Object.assign(document.createElement('canvas'), { width: w, height: h });
const ctx2d = (c: HTMLCanvasElement) => c.getContext('2d') as CanvasRenderingContext2D;
const toBlob = (c: HTMLCanvasElement) => new Promise<Blob>((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(new Error(t('ie.encodeFail')))), 'image/png'));
const pct = (x: number) => `${Math.round(x * 100)} %`;

/** Bild laden und auf EDIT_MAX_PIXELS verkleinern; Handyfotos stehen dank createImageBitmap richtig herum. */
async function bitmap(from: Blob | string): Promise<HTMLCanvasElement> {
  const blob = typeof from === 'string' ? await fetch(from).then((r) => { if (!r.ok) throw new Error(t('ie.loadFail')); return r.blob(); }) : from;
  const img = await createImageBitmap(blob).catch(() => { throw new Error(t('ie.loadFail')); });
  const s = Math.min(1, Math.sqrt(EDIT_MAX_PIXELS / (img.width * img.height)));
  const c = canvasOf(Math.max(1, Math.floor(img.width * s)), Math.max(1, Math.floor(img.height * s)));
  const x = ctx2d(c);
  x.imageSmoothingQuality = 'high';
  x.drawImage(img, 0, 0, c.width, c.height);
  img.close();
  return c;
}

/** Größte Fläche mit Seitenverhältnis a und etwa mp Megapixeln, Kanten auf 16 gerundet. */
function sizeFor(a: number, mp: number): [number, number] {
  const px = Math.min(EDIT_MAX_PIXELS, mp * 1024 * 1024);
  const w = Math.max(16, Math.floor(Math.sqrt(px * a) / 16) * 16);
  const hh = Math.max(16, Math.floor(w / a / 16) * 16);
  return [w, hh];
}

export function imageEditView(onToEdit: (g: Generation) => void): ImageEdit {
  let docW = 0;
  let docH = 0;
  let layers: Layer[] = [];
  let active: Layer | null = null;
  let tool: ToolName = 'move';
  const brush = { size: 40, hardness: 0.8, opacity: 1, color: '#ff8a1f' };
  const past: Step[] = [];
  const future: Step[] = [];
  let dirty = false;
  let lastSaved: Generation | null = null;
  let on = false;
  let newAspect = 16 / 9;
  let newMp: (typeof SIZES)[number] = 2;
  let newColor = '#ffffff';
  let cropAspect = 1;
  let canvasOpen = true;

  // --- Mitte ---
  const status = h('div', { class: 'status' });
  const sizeInfo = h('div', { class: 'cut-total' });
  const undoBtn = h('button', { type: 'button', class: 'button ghost', title: 'Strg+Z' }, t('ie.undo'));
  const redoBtn = h('button', { type: 'button', class: 'button ghost', title: 'Strg+Y' }, t('ie.redo'));
  const toEditBtn = h('button', { type: 'button', class: 'button ghost' }, t('ie.toEdit'));
  const zoomBtn = h('button', { type: 'button', class: 'button ghost hidden', title: t('ie.zoomTitle') });
  const view = h('canvas', { class: 'ie-canvas hidden' });
  const board = h('div', { class: 'ie-board hidden' });
  const cursor = h('div', { class: 'ie-cursor hidden' });
  const empty = h('p', { class: 'cut-empty ie-empty' }, t('ie.empty'));
  const wrap = h('div', { class: 'ie-wrap' }, board, view, cursor, empty);
  const error = h('p', { class: 'form-error' });
  const stage = h('section', { class: 'result ie-stage hidden' },
    h('div', { class: 'cut-head' }, status, undoBtn, redoBtn, toEditBtn, zoomBtn, sizeInfo), wrap, error);
  const vctx = ctx2d(view);

  // --- Verlauf ---
  const metaOf = (l: Layer): Meta => ({
    kind: l.kind, name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend, x: l.x, y: l.y, scale: l.scale, flip: l.flip, color: l.color,
  });
  const snap = (): Snap => ({ w: docW, h: docH, layers: [...layers], meta: layers.map(metaOf), active });
  function restore(s: Snap) {
    docW = s.w;
    docH = s.h;
    layers = [...s.layers];
    layers.forEach((l, i) => Object.assign(l, s.meta[i]));
    active = s.active && layers.includes(s.active) ? s.active : layers[layers.length - 1] ?? null;
    fit();
    drawPanel();
  }
  /** Zählt jede Änderung; Speichern übernimmt sein Ergebnis nur, wenn währenddessen nichts geschah. */
  let rev = 0;
  /** Zählt Pixeländerungen je Ebene, damit ein laufendes Speichern eine danach bemalte Ebene nicht als hochgeladen markiert. */
  const pixRev = new WeakMap<Layer, number>();
  const touch = (l: Layer) => pixRev.set(l, (pixRev.get(l) ?? 0) + 1);
  function push(step: Step) {
    rev++;
    past.push(step);
    if (past.length > HISTORY) past.shift();
    future.length = 0;
    dirty = true;
    lastSaved = null;
    drawHistory();
  }
  /** Aufbau oder Eigenschaften ändern, als ein Schritt rückgängig machbar. */
  function change(fn: () => void) {
    const before = snap();
    try {
      fn();
    } catch (e) {
      restore(before);
      error.textContent = (e as Error).message;
      return;
    }
    const after = snap();
    push({ undo: () => restore(before), redo: () => restore(after) });
    fit();
    drawPanel();
  }
  // Regler und Ziehen: Anfang merken, beim Loslassen ein einziger Schritt
  let pending: Snap | null = null;
  const begin = () => { pending ??= snap(); };
  function commit() {
    if (!pending) return;
    const before = pending;
    const after = snap();
    pending = null;
    // Klick ohne Bewegung: kein Schritt, sonst gälte ein gespeicherter Stand als geändert
    const same = before.w === after.w && before.h === after.h && before.layers.length === after.layers.length
      && before.layers.every((l, i) => l === after.layers[i]) && JSON.stringify(before.meta) === JSON.stringify(after.meta);
    if (same) return;
    push({ undo: () => restore(before), redo: () => restore(after) });
  }
  // Während Ziehen, Malen oder Verschieben der Ansicht nicht: der laufende Vorgang landete sonst in keinem Schritt
  const busyPointer = () => drag !== null || stroke !== null || pan !== null;
  function undo() {
    if (busyPointer()) return;
    commit();
    const s = past.pop();
    if (!s) return;
    s.undo();
    future.push(s);
    rev++;
    dirty = true;
    lastSaved = null;
    drawHistory();
  }
  function redo() {
    if (busyPointer()) return;
    const s = future.pop();
    if (!s) return;
    s.redo();
    past.push(s);
    rev++;
    dirty = true;
    lastSaved = null;
    drawHistory();
  }
  function drawHistory() {
    undoBtn.disabled = !past.length;
    redoBtn.disabled = !future.length;
  }
  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);

  // --- Ansicht: das Mausrad zoomt um den Zeiger, Zoom 1 = eingepasst; Versatz ox/oy in CSS-Pixeln ---
  let fitScale = 1;
  let zoom = 1;
  let ox = 0;
  let oy = 0;
  let fitFor = '';
  /** Eingepasst: folgt beim Ändern der Fenstergröße; nach Zoomen oder Verschieben bleibt der Ausschnitt. */
  let fitted = true;
  let queued = false;
  const viewS = () => fitScale * zoom;
  const dpr = () => window.devicePixelRatio || 1;
  function center() {
    zoom = 1;
    fitted = true;
    ox = (view.clientWidth - docW * viewS()) / 2;
    oy = (view.clientHeight - docH * viewS()) / 2;
  }
  function fit() {
    const has = docW > 0 && layers.length > 0;
    for (const x of [view, board, zoomBtn]) x.classList.toggle('hidden', !has);
    empty.classList.toggle('hidden', has);
    sizeInfo.textContent = docW ? `${docW}×${docH}` : '';
    if (!has) return;
    // Innenmaß der Fläche: der Umschlag hat einen Rahmen, die Fläche liegt darin
    const vw = view.clientWidth;
    const vh = view.clientHeight;
    // Höchstens 100 % in echten Bildschirmpixeln, auch bei Windows-Skalierung
    fitScale = Math.min(1 / dpr(), Math.max(0.01, Math.min((vw - 2) / docW, (vh - 2) / docH)));
    if (fitFor !== `${docW}x${docH}` || fitted) center();
    fitFor = `${docW}x${docH}`;
    view.width = Math.max(1, Math.round(vw * dpr()));
    view.height = Math.max(1, Math.round(vh * dpr()));
    redraw();
  }
  new ResizeObserver(() => { if (on) fit(); }).observe(wrap);
  function redraw() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const s = viewS();
      Object.assign(board.style, { left: `${ox}px`, top: `${oy}px`, width: `${docW * s}px`, height: `${docH * s}px` });
      zoomBtn.textContent = `${Math.round(s * dpr() * 100)} %`;
      // Auf ganze Bildschirmpixel, sonst ist auch 100 % leicht unscharf
      compose(vctx, s * dpr(), Math.round(ox * dpr()), Math.round(oy * dpr()));
      drawGuides();
    });
  }
  zoomBtn.addEventListener('click', () => { center(); redraw(); });

  // --- Einrasten beim Verschieben: Kanten an Rand der Fläche und an Kanten der anderen Bildebenen ---
  let guides: { x: number | null; y: number | null } = { x: null, y: null };
  function drawGuides() {
    if (guides.x === null && guides.y === null) return;
    const s = viewS() * dpr();
    const gx = guides.x === null ? null : guides.x * s + ox * dpr();
    const gy = guides.y === null ? null : guides.y * s + oy * dpr();
    vctx.save();
    vctx.setTransform(1, 0, 0, 1, 0, 0);
    vctx.strokeStyle = '#c8f04a';
    vctx.lineWidth = Math.max(1, dpr());
    vctx.beginPath();
    if (gx !== null) { vctx.moveTo(gx, 0); vctx.lineTo(gx, view.height); }
    if (gy !== null) { vctx.moveTo(0, gy); vctx.lineTo(view.width, gy); }
    vctx.stroke();
    vctx.restore();
  }
  /** Nächste Kante je Achse innerhalb SNAP_PX; ohne Treffer bleibt die Lage, auf ganze Pixel gerundet. */
  function snapped(l: Layer, nx: number, ny: number): [number, number] {
    const w = (l.canvas?.width ?? 0) * l.scale;
    const hh = (l.canvas?.height ?? 0) * l.scale;
    const thr = SNAP_PX / viewS();
    const xs = [0, docW];
    const ys = [0, docH];
    for (const o of layers) {
      if (o === l || !o.visible || o.kind !== 'image' || !o.canvas) continue;
      xs.push(o.x, o.x + o.canvas.width * o.scale);
      ys.push(o.y, o.y + o.canvas.height * o.scale);
    }
    const [x, gx] = snapAxis(nx, w, xs, thr);
    const [y, gy] = snapAxis(ny, hh, ys, thr);
    guides = { x: gx, y: gy };
    return [x, y];
  }

  /** Alle sichtbaren Ebenen von unten nach oben, beschnitten auf die Fläche; ein laufender Strich wird in seine Ebene gemischt. */
  function compose(c: CanvasRenderingContext2D, s: number, dx = 0, dy = 0) {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, c.canvas.width, c.canvas.height);
    c.imageSmoothingQuality = 'high';
    // Ab 200 % harte Pixel, damit man sieht, was wirklich im Bild steht
    c.imageSmoothingEnabled = s < 2;
    c.save();
    c.beginPath();
    c.rect(dx, dy, docW * s, docH * s);
    c.clip();
    for (const l of layers) {
      if (!l.visible) continue;
      c.save();
      c.globalAlpha = l.opacity;
      c.globalCompositeOperation = OP[l.blend];
      if (l.kind === 'fill') {
        c.fillStyle = l.color;
        c.fillRect(dx, dy, docW * s, docH * s);
      } else if (l.canvas) {
        const src = stroke?.layer === l ? strokeMix(l.canvas) : l.canvas;
        c.setTransform((l.flip ? -1 : 1) * l.scale * s, 0, 0, l.scale * s, (l.x + (l.flip ? l.canvas.width * l.scale : 0)) * s + dx, l.y * s + dy);
        c.drawImage(src, 0, 0);
      }
      c.restore();
    }
    c.restore();
  }

  // --- Malen ---
  interface Stroke { layer: Layer; canvas: HTMLCanvasElement; stamp: HTMLCanvasElement; r: number; last: [number, number]; box: [number, number, number, number]; erase: boolean }
  let stroke: Stroke | null = null;
  const mix = canvasOf(1, 1);
  function strokeMix(base: HTMLCanvasElement): HTMLCanvasElement {
    if (!stroke) return base;
    if (mix.width !== base.width || mix.height !== base.height) Object.assign(mix, { width: base.width, height: base.height });
    const m = ctx2d(mix);
    m.globalCompositeOperation = 'copy';
    m.globalAlpha = 1;
    m.drawImage(base, 0, 0);
    m.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
    m.globalAlpha = brush.opacity;
    m.drawImage(stroke.canvas, 0, 0);
    return mix;
  }
  /** Arbeitsfläche → Pixel der Ebene (Lage, Größe, Spiegelung zurückgerechnet). */
  function toLayer(l: Layer, x: number, y: number): [number, number] {
    const w = l.canvas?.width ?? 0;
    const u = (x - l.x) / l.scale;
    return [l.flip ? w - u : u, (y - l.y) / l.scale];
  }
  function makeStamp(r: number, color: string): HTMLCanvasElement {
    const d = Math.max(2, Math.ceil(r * 2));
    const c = canvasOf(d, d);
    const x = ctx2d(c);
    const g = x.createRadialGradient(d / 2, d / 2, 0, d / 2, d / 2, d / 2);
    g.addColorStop(0, color);
    g.addColorStop(Math.min(0.99, brush.hardness), color);
    g.addColorStop(1, `${color}00`);
    x.fillStyle = g;
    x.fillRect(0, 0, d, d);
    return c;
  }
  function dab(st: Stroke, x: number, y: number) {
    const [lx, ly] = st.last;
    const dist = Math.hypot(x - lx, y - ly);
    const step = Math.max(0.5, st.r * 0.15);
    const n = Math.max(1, Math.ceil(dist / step));
    const c = ctx2d(st.canvas);
    for (let i = 1; i <= n; i++) {
      const px = lx + ((x - lx) * i) / n;
      const py = ly + ((y - ly) * i) / n;
      c.drawImage(st.stamp, px - st.stamp.width / 2, py - st.stamp.height / 2);
    }
    const b = st.box;
    const m = st.stamp.width / 2 + 1;
    st.box = [Math.min(b[0], x - m), Math.min(b[1], y - m), Math.max(b[2], x + m), Math.max(b[3], y + m)];
    st.last = [x, y];
  }
  function startStroke(x: number, y: number) {
    const l = active;
    if (!l || l.kind !== 'image' || !l.canvas) return void (status.textContent = t('ie.paintWhere'));
    if (!l.visible) return void (status.textContent = t('ie.paintHidden'));
    const [lx, ly] = toLayer(l, x, y);
    const r = Math.max(0.5, brush.size / 2 / l.scale);
    const stamp = makeStamp(r, tool === 'eraser' ? '#000000' : brush.color);
    // Der Stempel ragt über r hinaus (gerundete Größe): der gesicherte Ausschnitt muss ihn ganz fassen, sonst bleiben nach Rückgängig Reste
    const m = stamp.width / 2 + 1;
    const st: Stroke = {
      layer: l, canvas: canvasOf(l.canvas.width, l.canvas.height), stamp,
      r, last: [lx, ly], box: [lx - m, ly - m, lx + m, ly + m], erase: tool === 'eraser',
    };
    ctx2d(st.canvas).drawImage(st.stamp, lx - st.stamp.width / 2, ly - st.stamp.height / 2);
    stroke = st;
    redraw();
  }
  function endStroke() {
    const st = stroke;
    stroke = null;
    if (!st || !st.layer.canvas) return;
    const c = st.layer.canvas;
    const x0 = Math.max(0, Math.floor(st.box[0]));
    const y0 = Math.max(0, Math.floor(st.box[1]));
    const w = Math.min(c.width, Math.ceil(st.box[2])) - x0;
    const hh = Math.min(c.height, Math.ceil(st.box[3])) - y0;
    if (w <= 0 || hh <= 0) return redraw();
    const lc = ctx2d(c);
    // Nur der berührte Ausschnitt kommt in den Verlauf, ganze Ebenen wären je Schritt bis zu 16 MB
    const before = lc.getImageData(x0, y0, w, hh);
    lc.save();
    lc.globalAlpha = brush.opacity;
    lc.globalCompositeOperation = st.erase ? 'destination-out' : 'source-over';
    lc.drawImage(st.canvas, 0, 0);
    lc.restore();
    const after = lc.getImageData(x0, y0, w, hh);
    const l = st.layer;
    const prevSrc = l.src;
    l.src = null;
    touch(l);
    push({
      undo: () => { lc.putImageData(before, x0, y0); l.src = prevSrc; touch(l); redraw(); },
      redo: () => { lc.putImageData(after, x0, y0); l.src = null; touch(l); redraw(); },
    });
    redraw();
  }

  // --- Zeiger auf der Fläche ---
  const docPos = (e: PointerEvent | WheelEvent): [number, number] => {
    const r = view.getBoundingClientRect();
    return [(e.clientX - r.left - ox) / viewS(), (e.clientY - r.top - oy) / viewS()];
  };
  function pick(e: PointerEvent) {
    const [x, y] = docPos(e);
    if (x < 0 || y < 0 || x >= docW || y >= docH) return;
    const r = view.getBoundingClientRect();
    const [cr, cg, cb] = vctx.getImageData(Math.floor((e.clientX - r.left) * dpr()), Math.floor((e.clientY - r.top) * dpr()), 1, 1).data;
    brush.color = `#${[cr, cg, cb].map((v) => (v ?? 0).toString(16).padStart(2, '0')).join('')}`;
    drawPanel();
  }
  let drag: { x: number; y: number; lx: number; ly: number } | null = null;
  // Ansicht verschieben: mittlere Maustaste oder Leertaste + Ziehen
  let pan: { x: number; y: number; ox: number; oy: number } | null = null;
  let space = false;
  view.addEventListener('pointerdown', (e) => {
    if (e.button === 1 || (e.button === 0 && space)) {
      e.preventDefault();
      view.setPointerCapture(e.pointerId);
      pan = { x: e.clientX, y: e.clientY, ox, oy };
      view.classList.add('panning');
      return;
    }
    if (e.button !== 0) return;
    error.textContent = '';
    if (tool === 'pick' || e.altKey) return pick(e);
    view.setPointerCapture(e.pointerId);
    const [x, y] = docPos(e);
    if (tool === 'move') {
      if (!active || active.kind !== 'image') return void (status.textContent = t('ie.moveWhere'));
      begin();
      drag = { x, y, lx: active.x, ly: active.y };
      return;
    }
    startStroke(x, y);
  });
  view.addEventListener('pointermove', (e) => {
    if (pan) {
      ox = pan.ox + e.clientX - pan.x;
      oy = pan.oy + e.clientY - pan.y;
      fitted = false;
      return redraw();
    }
    moveCursor(e);
    const [x, y] = docPos(e);
    if (drag && active) {
      const nx = drag.lx + x - drag.x;
      const ny = drag.ly + y - drag.y;
      // Strg hält das Einrasten ab
      if (e.ctrlKey) guides = { x: null, y: null };
      [active.x, active.y] = e.ctrlKey ? [Math.round(nx), Math.round(ny)] : snapped(active, nx, ny);
      return redraw();
    }
    if (!stroke) return;
    for (const ev of e.getCoalescedEvents?.() ?? [e]) {
      const [dx, dy] = docPos(ev);
      const [lx, ly] = toLayer(stroke.layer, dx, dy);
      dab(stroke, lx, ly);
    }
    redraw();
  });
  const release = () => {
    if (pan) {
      pan = null;
      view.classList.remove('panning');
    }
    if (drag) {
      drag = null;
      guides = { x: null, y: null };
      commit();
      redraw();
    }
    endStroke();
  };
  // Sonst startet Chrome mit der mittleren Taste den Bildlauf-Modus
  view.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
  view.addEventListener('pointerup', release);
  view.addEventListener('pointercancel', release);
  view.addEventListener('pointerleave', () => cursor.classList.add('hidden'));
  view.addEventListener('wheel', (e) => {
    if (!docW) return;
    e.preventDefault();
    const r = view.getBoundingClientRect();
    zoomTo(zoomStep(viewS() * dpr(), e.deltaY < 0 ? 1 : -1), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  /** Zoom auf eine Stufe in Bildschirmpixeln je Bildpixel; der Punkt cx/cy (CSS-Pixel in der Fläche) bleibt stehen. */
  function zoomTo(level: number, cx: number, cy: number) {
    const old = viewS();
    fitted = false;
    zoom = level / dpr() / fitScale;
    ox = cx - ((cx - ox) * viewS()) / old;
    oy = cy - ((cy - oy) * viewS()) / old;
    redraw();
  }
  function moveCursor(e: PointerEvent) {
    const paint = (tool === 'brush' || tool === 'eraser') && !space;
    cursor.classList.toggle('hidden', !paint);
    if (!paint) return;
    const w = view.getBoundingClientRect();
    const d = brush.size * viewS();
    Object.assign(cursor.style, { width: `${d}px`, height: `${d}px`, left: `${e.clientX - w.left - d / 2}px`, top: `${e.clientY - w.top - d / 2}px` });
  }

  // --- Ebenen anlegen ---
  function insert(l: Layer) {
    if (layers.length >= EDIT_MAX_LAYERS) throw new Error(t('ie.tooMany', { n: EDIT_MAX_LAYERS }));
    const i = active ? layers.indexOf(active) + 1 : layers.length;
    layers.splice(i, 0, l);
    active = l;
  }
  const layerOf = (kind: Layer['kind'], name: string, extra: Partial<Layer> = {}): Layer => ({
    kind, name, visible: true, opacity: 1, blend: 'normal', x: 0, y: 0, scale: 1, flip: false, color: '#ffffff', canvas: null, src: null, ...extra,
  });
  /** Bild als Ebene: auf eine leere Fläche in Originalgröße, sonst eingepasst und mittig. */
  function placeImage(canvas: HTMLCanvasElement, name: string, src: LayerSource | null) {
    change(() => {
      if (!layers.length) {
        docW = canvas.width;
        docH = canvas.height;
        insert(layerOf('image', name, { canvas, src }));
        return;
      }
      const s = Math.min(1, docW / canvas.width, docH / canvas.height);
      insert(layerOf('image', name, { canvas, src, scale: s, x: Math.round((docW - canvas.width * s) / 2), y: Math.round((docH - canvas.height * s) / 2) }));
    });
  }
  function guard<T>(p: Promise<T>) {
    status.textContent = t('ie.loading');
    p.then(() => { status.textContent = ''; }, (e: Error) => { status.textContent = ''; error.textContent = e.message; });
  }
  function add(g: Generation) {
    error.textContent = '';
    if (g.video || g.status !== 'done') return void (error.textContent = t('ie.onlyImage'));
    guard(bitmap(imageUrl(g.id, 'full')).then((c) => placeImage(c, g.prompt.slice(0, 40) || t('ie.layerImage'), { kind: 'output', id: g.id })));
  }
  function addFile(file: File) {
    error.textContent = '';
    if (!file.type.startsWith('image/')) return void (error.textContent = t('ie.onlyImage'));
    guard(bitmap(file).then((c) => placeImage(c, file.name.replace(/\.[^.]+$/, '').slice(0, 40), null)));
  }
  function addPaint() {
    if (!docW) return void (error.textContent = t('ie.needCanvas'));
    const n = layers.filter((l) => l.name.startsWith(t('ie.layerPaint'))).length + 1;
    change(() => insert(layerOf('image', `${t('ie.layerPaint')} ${n}`, { canvas: canvasOf(docW, docH) })));
  }
  function addFill() {
    if (!docW) return void (error.textContent = t('ie.needCanvas'));
    change(() => insert(layerOf('fill', t('ie.layerFill'), { color: brush.color })));
  }
  function newCanvas() {
    const [w, hh] = sizeFor(newAspect, newMp);
    change(() => {
      docW = w;
      docH = hh;
      layers = [];
      active = null;
      insert(layerOf('fill', t('ie.layerBack'), { color: newColor }));
      insert(layerOf('image', `${t('ie.layerPaint')} 1`, { canvas: canvasOf(w, hh) }));
    });
    status.textContent = t('ie.newDone');
  }
  function crop() {
    if (!docW) return;
    const a = cropAspect;
    const w = docW / docH > a ? Math.round(docH * a) : docW;
    const hh = docW / docH > a ? docH : Math.round(docW / a);
    const dx = Math.round((docW - w) / 2);
    const dy = Math.round((docH - hh) / 2);
    change(() => {
      docW = w;
      docH = hh;
      for (const l of layers) { l.x -= dx; l.y -= dy; }
    });
  }

  // --- Projekt ---
  let saving: Promise<Generation> | null = null;
  /** Ein laufendes Speichern wird geteilt (Formular-Knopf und „An Edit schicken“ ergäben sonst zwei Einträge). */
  function save(): Promise<Generation> {
    commit();
    if (!docW || !layers.length) return Promise.reject(new Error(t('ie.nothing')));
    if (!dirty && lastSaved) return Promise.resolve(lastSaved);
    saving ??= saveNow().finally(() => { saving = null; });
    return saving;
  }
  /** Alles im selben Augenblick festhalten (toBlob kopiert die Pixel sofort), dann erst hochladen: Weitermalen ändert das Gespeicherte nicht. */
  async function saveNow(): Promise<Generation> {
    status.textContent = t('ie.saving');
    const startRev = rev;
    const w = docW;
    const hh = docH;
    const out = canvasOf(w, hh);
    compose(ctx2d(out), 1);
    const image = toBlob(out);
    const parts = layers.map((l) => ({
      l, src: l.src, pix: pixRev.get(l) ?? 0,
      blob: l.kind === 'image' && l.canvas && !l.src ? toBlob(l.canvas) : null,
      meta: { kind: l.kind, name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend, x: l.x, y: l.y, scale: l.scale, flip: l.flip, color: l.color },
    }));
    // Bricht ein Upload ab, sollen die übrigen Kodierungen nicht als unbehandelte Fehler auflaufen
    for (const p of [image, ...parts.map((x) => x.blob)]) p?.catch(() => {});
    try {
      const saved: EditLayer[] = [];
      for (const p of parts) {
        let src = p.src;
        if (p.blob) {
          src = { kind: 'input', id: (await api.upload(await p.blob)).inputId };
          if ((pixRev.get(p.l) ?? 0) === p.pix) p.l.src = src;
        }
        const { color, ...rest } = p.meta;
        saved.push(p.meta.kind === 'fill' ? { ...rest, color } : { ...rest, ...(src ? { src } : {}) });
      }
      const { inputId } = await api.upload(await image);
      const g = await api.imageEdit(inputId, { width: w, height: hh, layers: saved });
      if (rev === startRev) {
        dirty = false;
        lastSaved = g;
      }
      status.textContent = t('ie.saved');
      return g;
    } catch (e) {
      status.textContent = '';
      throw e;
    }
  }
  toEditBtn.addEventListener('click', () => {
    error.textContent = '';
    toEditBtn.disabled = true;
    save().then(onToEdit, (e: Error) => { error.textContent = e.message; }).finally(() => { toEditBtn.disabled = false; });
  });
  function open(g: Generation) {
    error.textContent = '';
    let raw: unknown = null;
    try {
      raw = typeof g.params.project === 'string' ? JSON.parse(g.params.project) : null;
    } catch {
      // unten gemeldet
    }
    const p = parseEditProject(raw);
    if (!p) return void (error.textContent = t('ie.badProject'));
    guard((async () => {
      const loaded: Layer[] = [];
      const lost: string[] = [];
      for (const l of p.layers) {
        if (l.kind === 'fill') {
          loaded.push(layerOf('fill', l.name, { ...l, color: l.color ?? '#ffffff' }));
          continue;
        }
        const src = l.src as LayerSource;
        try {
          const canvas = await bitmap(src.kind === 'output' ? imageUrl(src.id, 'full') : inputUrl(src.id));
          loaded.push(layerOf('image', l.name, { ...l, canvas, src }));
        } catch {
          lost.push(l.name || '?');
        }
      }
      change(() => {
        docW = p.width;
        docH = p.height;
        layers = loaded;
        active = loaded[loaded.length - 1] ?? null;
      });
      dirty = false;
      lastSaved = g;
      if (lost.length) error.textContent = t('ie.lost', { names: lost.join(', ') });
    })().then(() => { status.textContent = t('ie.opened'); }));
  }

  // --- Ablegen und Einfügen ---
  wrap.addEventListener('dragover', (e) => { e.preventDefault(); wrap.classList.add('over'); });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('over'));
  wrap.addEventListener('drop', (e) => {
    e.preventDefault();
    wrap.classList.remove('over');
    const id = e.dataTransfer?.getData(GEN_DRAG);
    if (id) return void api.generation(id).then(add, (err: Error) => { error.textContent = err.message; });
    for (const f of e.dataTransfer?.files ?? []) addFile(f);
  });
  window.addEventListener('paste', (e) => {
    if (!on) return;
    const file = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'))?.getAsFile();
    if (!file) return;
    e.preventDefault();
    addFile(file);
  });
  window.addEventListener('keydown', (e) => {
    if (!on || (e.target as HTMLElement | null)?.closest('input, textarea, select')) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
    if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); return redo(); }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === ' ') {
      e.preventDefault();
      if (!space) { space = true; view.classList.add('grab'); cursor.classList.add('hidden'); }
      return;
    }
    if (k === '0') { center(); redraw(); return; }
    if (k === '1' && docW) {
      const r = view.getBoundingClientRect();
      zoomTo(1, r.width / 2, r.height / 2);
      return;
    }
    const next = TOOL_HOTKEY[k];
    if (next) { tool = next; drawPanel(); return; }
    if (k === '[' || k === ']') {
      brush.size = Math.min(400, Math.max(1, Math.round(brush.size * (k === ']' ? 1.2 : 1 / 1.2))));
      drawPanel();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key !== ' ' || !space) return;
    space = false;
    view.classList.remove('grab');
  });
  window.addEventListener('blur', () => { space = false; view.classList.remove('grab'); });
  // Bitmaps liegen nur im Speicher: vor dem Schließen warnen, solange Ungespeichertes da ist
  window.addEventListener('beforeunload', (e) => { if (dirty && layers.length) e.preventDefault(); });

  // --- Links: Einstellungen ---
  const settings = h('div', { class: 'section ie-settings hidden' });
  const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'hidden' });
  fileInput.addEventListener('change', () => {
    for (const f of fileInput.files ?? []) addFile(f);
    fileInput.value = '';
  });

  /** Regler mit Zahlenfeld: live beim Ziehen, getippt mit Enter oder Wegklicken; ein Verlaufsschritt je Änderung (sofern hist). */
  function slider(label: string, min: number, max: number, step: number, value: number, unit: '%' | 'px', onInput: (v: number) => void, hist = true): HTMLElement {
    const f = unit === '%' ? 100 : 1;
    const input = h('input', { type: 'range', min, max, step, value: String(value) });
    const num = h('input', { type: 'number', class: 'ie-num', min: min * f, max: max * f, step: 'any', value: String(Math.round(value * f)) });
    const apply = (v: number) => {
      if (hist) begin();
      onInput(v);
      redraw();
    };
    input.addEventListener('input', () => {
      num.value = String(Math.round(Number(input.value) * f));
      apply(Number(input.value));
    });
    num.addEventListener('change', () => {
      const typed = Number(num.value.replace(',', '.'));
      const v = Number.isFinite(typed) && num.value !== '' ? Math.min(max, Math.max(min, typed / f)) : Number(input.value);
      num.value = String(Math.round(v * f));
      input.value = String(v);
      apply(v);
      if (hist) { commit(); drawPanel(); }
    });
    num.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); num.blur(); } });
    if (hist) input.addEventListener('change', () => { commit(); drawPanel(); });
    return h('label', {}, h('span', { class: 'lbl' }, label), h('div', { class: 'row' }, input, h('span', { class: 'ie-numbox' }, num, h('span', { class: 'ie-unit' }, unit))));
  }
  function segs<T extends string | number>(label: string | null, values: readonly T[], current: T, text: (v: T) => string, onPick: (v: T) => void): HTMLElement {
    const buttons = values.map((v) => h('button', { type: 'button', class: `seg${v === current ? ' on' : ''}`, onclick: () => onPick(v) }, text(v)));
    const row = h('div', { class: 'segs', style: `--n:${values.length}` }, ...buttons);
    return label ? h('div', { class: 'field' }, h('span', { class: 'lbl' }, label), row) : row;
  }
  const aspectSelect = (value: number, onPick: (v: number) => void) => {
    const s = h('select', {}, ...ASPECTS.map(([l, v]) => h('option', { value: String(v), selected: Math.abs(v - value) < 1e-6 }, l)));
    s.addEventListener('change', () => onPick(Number(s.value)));
    return s;
  };
  const colorInput = (value: string, onPick: (v: string) => void, onDone?: () => void) => {
    const c = h('input', { type: 'color', value, class: 'ie-color' });
    c.addEventListener('input', () => { onPick(c.value); redraw(); });
    if (onDone) c.addEventListener('change', onDone);
    return c;
  };

  let dragFrom: number | null = null;
  function layerRows(): HTMLElement {
    const rows = [...layers].reverse().map((l) => {
      const i = layers.indexOf(l);
      const eye = h('button', { type: 'button', class: `ie-eye${l.visible ? ' on' : ''}`, title: t('ie.visible') }, l.visible ? '●' : '○');
      eye.addEventListener('click', (e) => { e.stopPropagation(); change(() => { l.visible = !l.visible; }); });
      const swatch = h('span', { class: 'ie-swatch', style: l.kind === 'fill' ? `background:${l.color}` : '' }, l.kind === 'fill' ? '' : '▦');
      const row = h('div', { class: `ie-layer${l === active ? ' on' : ''}${l.visible ? '' : ' off'}`, draggable: true },
        eye, swatch, h('span', { class: 'ie-name' }, l.name || t('ie.layerImage')),
        h('span', { class: 'ie-mode' }, l.blend === 'normal' ? '' : t(BLEND_KEY[l.blend])),
        l.opacity < 1 ? h('span', { class: 'ie-mode' }, pct(l.opacity)) : null,
        h('button', { type: 'button', class: 'drop-clear ie-del', title: t('ie.remove'), onclick: (e: Event) => {
          e.stopPropagation();
          change(() => {
            layers.splice(layers.indexOf(l), 1);
            if (active === l) active = layers[Math.max(0, i - 1)] ?? null;
          });
        } }, '×'));
      row.addEventListener('click', () => { active = l; drawPanel(); });
      row.addEventListener('dragstart', (e) => { dragFrom = i; e.dataTransfer?.setData('text/plain', String(i)); });
      row.addEventListener('dragend', () => { dragFrom = null; });
      row.addEventListener('dragover', (e) => { if (dragFrom !== null) e.preventDefault(); });
      row.addEventListener('drop', (e) => {
        if (dragFrom === null) return;
        e.preventDefault();
        e.stopPropagation();
        const from = dragFrom;
        dragFrom = null;
        if (from === i) return;
        change(() => {
          const [moved] = layers.splice(from, 1);
          if (moved) layers.splice(i, 0, moved);
        });
      });
      return row;
    });
    return h('div', { class: 'ie-layers' }, ...(rows.length ? rows : [h('p', { class: 'cut-hint' }, t('ie.noLayers'))]));
  }

  function layerProps(l: Layer): HTMLElement[] {
    const blendSel = h('select', {}, ...BLEND_MODES.map((b) => h('option', { value: b, selected: b === l.blend }, t(BLEND_KEY[b]))));
    blendSel.addEventListener('change', () => change(() => { l.blend = blendSel.value as BlendMode; }));
    const out: HTMLElement[] = [
      h('div', { class: 'cut-grid' },
        h('label', {}, h('span', { class: 'lbl' }, t('ie.blend')), blendSel),
        l.kind === 'fill' ? h('label', {}, h('span', { class: 'lbl' }, t('ie.color')), colorInput(l.color, (v) => { begin(); l.color = v; }, () => { commit(); drawPanel(); })) : null),
      slider(t('ie.opacity'), 0, 1, 0.01, l.opacity, '%', (v) => { l.opacity = v; }),
    ];
    if (l.kind === 'image' && l.canvas) {
      const c = l.canvas;
      out.push(
        slider(t('ie.scale'), 0.05, 4, 0.01, l.scale, '%', (v) => {
          // Um die Mitte der Ebene skalieren
          l.x += (c.width * (l.scale - v)) / 2;
          l.y += (c.height * (l.scale - v)) / 2;
          l.scale = v;
        }),
        h('div', { class: 'pg-actions' },
          h('button', { type: 'button', class: 'button ghost', onclick: () => change(() => { l.flip = !l.flip; }) }, t('ie.flip')),
          h('button', { type: 'button', class: 'button ghost', onclick: () => change(() => {
            const s = Math.min(docW / c.width, docH / c.height);
            Object.assign(l, { scale: s, x: Math.round((docW - c.width * s) / 2), y: Math.round((docH - c.height * s) / 2) });
          }) }, t('ie.fit'))),
      );
    }
    return out;
  }

  function drawPanel() {
    const brushBox = tool === 'brush' || tool === 'eraser'
      ? [slider(t('ie.size'), 1, 400, 1, brush.size, 'px', (v) => { brush.size = v; }, false),
        slider(t('ie.hardness'), 0, 1, 0.05, brush.hardness, '%', (v) => { brush.hardness = v; }, false),
        slider(t('ie.flow'), 0.05, 1, 0.05, brush.opacity, '%', (v) => { brush.opacity = v; }, false)]
      : [];
    settings.replaceChildren(
      h('details', { class: 'ie-box', open: canvasOpen, ontoggle: (e: Event) => { canvasOpen = (e.target as HTMLDetailsElement).open; } },
        h('summary', {}, t('ie.canvas')),
        h('div', { class: 'cut-grid' },
          h('label', {}, h('span', { class: 'lbl' }, t('ie.aspect')), aspectSelect(newAspect, (v) => { newAspect = v; })),
          h('label', {}, h('span', { class: 'lbl' }, t('ie.fillColor')), colorInput(newColor, (v) => { newColor = v; }))),
        segs(t('ie.mp'), SIZES, newMp, (v) => `${v} MP`, (v) => { newMp = v; drawPanel(); }),
        h('button', { type: 'button', class: 'button ghost', onclick: newCanvas }, t('ie.new')),
        ...(docW ? [h('div', { class: 'cut-grid' },
          h('label', {}, h('span', { class: 'lbl' }, t('ie.crop')), aspectSelect(cropAspect, (v) => { cropAspect = v; })),
          h('div', { class: 'field ie-end' }, h('button', { type: 'button', class: 'button ghost', onclick: crop }, t('ie.cropDo'))))] : [])),
      segs(t('ie.tool'), TOOLS, tool, (v) => t(TOOL_KEY[v]), (v) => { tool = v; drawPanel(); }),
      ...(tool === 'brush' || tool === 'pick' ? [h('label', { class: 'ie-inline' }, h('span', { class: 'lbl' }, t('ie.color')),
        colorInput(brush.color, (v) => { brush.color = v; }))] : []),
      ...brushBox,
      h('p', { class: 'cut-hint' }, t(HINT_KEY[tool])),
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, t('ie.layers')), layerRows()),
      h('div', { class: 'pg-actions' },
        h('button', { type: 'button', class: 'button ghost', onclick: addPaint }, t('ie.addPaint')),
        h('button', { type: 'button', class: 'button ghost', onclick: addFill }, t('ie.addFill')),
        h('button', { type: 'button', class: 'button ghost', onclick: () => fileInput.click() }, t('ie.addFile'))),
      fileInput,
      ...(active ? layerProps(active) : []),
    );
    redraw();
  }

  drawPanel();
  drawHistory();
  fit();
  return {
    settings, stage, add, open, save,
    enter: () => { on = true; fit(); },
    leave: () => { on = false; release(); commit(); },
  };
}
