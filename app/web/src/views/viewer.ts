import { h } from '../dom.ts';
import { t } from '../i18n.ts';

const MAX_SCALE = 8;
const STEP = 1.25;

export interface Viewer {
  el: HTMLElement;
  setImage(previewUrl: string, fullUrl: string, width: number, height: number, beforeUrl?: string): void;
  clear(): void;
}

/** Zoom/Pan-Ansicht. 100 % = ein Bildpixel pro Bildschirmpixel, darum durch devicePixelRatio geteilt. */
export function viewer(): Viewer {
  let natW = 0, natH = 0, scale = 1, x = 0, y = 0;
  let fitMode = true;
  let fullUrl = '', previewW = 0, hiRes = false, token = 0;

  let compare = false, hasBefore = false, splitX = 0.5, splitSet = false;

  const img = h('img', { class: 'vimg', alt: '', draggable: 'false' });
  const before = h('img', { class: 'vimg before hidden', alt: '', draggable: 'false' });
  const handle = h('div', { class: 'split hidden' }, h('span', {}, '‹ ›'));
  const tagBefore = h('span', { class: 'vtag left hidden' }, t('view.before'));
  const tagAfter = h('span', { class: 'vtag right hidden' }, t('view.after'));
  const pct = h('span', { class: 'pct' });
  const src = h('span', { class: 'src' });
  const box = h('div', { class: 'viewport empty', 'data-empty': t('view.empty') }, img, before, handle, tagBefore, tagAfter);
  const btn = (label: string, title: string, fn: () => void) =>
    h('button', { type: 'button', title, onclick: (e: Event) => { e.stopPropagation(); fn(); } }, label);
  const cmpBtn = btn(t('view.compare'), t('view.compareTitle'), () => setCompare(!compare));
  const cmpSep = h('i');
  const bar = h('div', { class: 'vbar hidden' },
    btn('Fit', t('view.fitTitle'), fit), btn('100%', t('view.actualTitle'), actual),
    h('i'), btn('−', t('view.zoomOut'), () => zoomBy(1 / STEP)), pct, btn('+', t('view.zoomIn'), () => zoomBy(STEP)),
    cmpSep, cmpBtn, h('i'), src);

  function setCompare(on: boolean) {
    compare = on && hasBefore;
    for (const e of [before, handle, tagBefore, tagAfter]) e.classList.toggle('hidden', !compare);
    cmpBtn.classList.toggle('on', compare);
    apply();
  }
  const el = h('div', { class: 'viewer' }, box, bar);

  const dpr = () => window.devicePixelRatio || 1;
  const one = () => 1 / dpr();
  const fitScale = () => Math.min(box.clientWidth / natW, box.clientHeight / natH, one());

  function apply() {
    img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    if (compare) {
      // Die Teilung bleibt am Bildschirm stehen, der Ausschnitt im Bild wandert beim Zoomen/Pannen mit.
      const sx = splitX * box.clientWidth;
      const f = Math.min(Math.max((sx - x) / (natW * scale), 0), 1);
      before.style.transform = img.style.transform;
      before.style.clipPath = `inset(0 ${(1 - f) * 100}% 0 0)`;
      handle.style.left = `${sx}px`;
    }
    pct.textContent = `${Math.round(scale * dpr() * 100)}%`;
    box.classList.toggle('zoomed', !fitMode);
    // Die Preview reicht bis ~2560 px; darüber hinaus das Original nachladen.
    if (!hiRes && previewW > 0 && scale * natW * dpr() > previewW * 1.05) loadFull();
  }

  function center() {
    x = (box.clientWidth - natW * scale) / 2;
    y = (box.clientHeight - natH * scale) / 2;
  }

  function fit() {
    if (!natW) return;
    fitMode = true;
    scale = fitScale();
    center();
    apply();
  }

  function zoomTo(s: number, cx = box.clientWidth / 2, cy = box.clientHeight / 2) {
    if (!natW) return;
    const next = Math.min(Math.max(s, fitScale() * 0.5), MAX_SCALE);
    const px = (cx - x) / scale;
    const py = (cy - y) / scale;
    scale = next;
    x = cx - px * scale;
    y = cy - py * scale;
    fitMode = false;
    apply();
  }

  function zoomBy(f: number) { zoomTo(scale * f); }
  function actual() { zoomTo(one()); }

  function loadFull() {
    hiRes = true;
    const mine = token;
    src.textContent = t('view.loading');
    const hi = new Image();
    hi.onload = () => {
      if (mine !== token) return;
      img.src = fullUrl;
      src.textContent = t('view.original');
    };
    hi.onerror = () => { if (mine === token) src.textContent = t('view.preview'); };
    hi.src = fullUrl;
  }

  img.addEventListener('load', () => {
    if (!hiRes) previewW = img.naturalWidth;
    if (fitMode) fit(); else apply();
  });

  box.addEventListener('wheel', (e) => {
    if (!natW) return;
    e.preventDefault();
    const r = box.getBoundingClientRect();
    zoomTo(scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  let splitting = false;
  handle.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    splitting = true;
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!splitting) return;
    const r = box.getBoundingClientRect();
    splitX = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
    splitSet = true;
    apply();
  });
  handle.addEventListener('pointerup', () => { splitting = false; });
  handle.addEventListener('lostpointercapture', () => { splitting = false; });
  handle.addEventListener('dblclick', (e) => e.stopPropagation());

  let drag: { px: number; py: number; x: number; y: number } | null = null;
  box.addEventListener('pointerdown', (e) => {
    if (!natW || e.button !== 0) return;
    drag = { px: e.clientX, py: e.clientY, x, y };
    box.setPointerCapture(e.pointerId);
    box.classList.add('dragging');
  });
  box.addEventListener('pointermove', (e) => {
    if (!drag) return;
    x = drag.x + e.clientX - drag.px;
    y = drag.y + e.clientY - drag.py;
    fitMode = false;
    apply();
  });
  const endDrag = () => { drag = null; box.classList.remove('dragging'); };
  box.addEventListener('pointerup', endDrag);
  box.addEventListener('pointercancel', endDrag);
  box.addEventListener('dblclick', (e) => {
    const r = box.getBoundingClientRect();
    if (fitMode) zoomTo(one(), e.clientX - r.left, e.clientY - r.top);
    else fit();
  });

  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (!natW || e.ctrlKey || e.altKey || t.closest('input, textarea, select')) return;
    if (e.key === 'f' || e.key === 'F') fit();
    else if (e.key === '1') actual();
    else if (e.key === '+' || e.key === '=') zoomBy(STEP);
    else if (e.key === '-') zoomBy(1 / STEP);
    else if (e.key === 'v' || e.key === 'V') setCompare(!compare);
  });

  new ResizeObserver(() => { if (fitMode) fit(); }).observe(box);

  function setImage(previewUrl: string, full: string, width: number, height: number, beforeUrl?: string) {
    token++;
    hasBefore = !!beforeUrl;
    if (beforeUrl) {
      before.src = beforeUrl;
      before.style.width = `${width}px`;
      before.style.height = `${height}px`;
    } else {
      before.removeAttribute('src');
    }
    if (!splitSet) splitX = 0.5;
    cmpBtn.classList.toggle('hidden', !hasBefore);
    cmpSep.classList.toggle('hidden', !hasBefore);
    setCompare(hasBefore);
    natW = width;
    natH = height;
    fullUrl = full;
    hiRes = false;
    previewW = 0;
    fitMode = true;
    img.style.width = `${width}px`;
    img.style.height = `${height}px`;
    img.src = previewUrl;
    src.textContent = t('view.preview');
    box.classList.remove('empty');
    bar.classList.remove('hidden');
  }

  function clear() {
    token++;
    natW = 0;
    hasBefore = false;
    setCompare(false);
    img.removeAttribute('src');
    before.removeAttribute('src');
    box.classList.add('empty');
    bar.classList.add('hidden');
  }

  return { el, setImage, clear };
}
