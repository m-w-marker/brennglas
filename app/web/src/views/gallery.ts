import type { Generation, GenerationFilter, SseEvent } from '@brennglas/shared';
import { api, GEN_DRAG, imageUrl } from '../api.ts';
import { h } from '../dom.ts';
import { t } from '../i18n.ts';

export interface Gallery {
  el: HTMLElement;
  load(): Promise<void>;
  onEvent(ev: SseEvent): void;
  select(id: string | null): void;
  /** Nach SSE-Wiederverbindung: offene Kacheln und verpasste neue Einträge nachholen. */
  resync(): void;
  /** Positionen im Schnitt je Video-ID, als Nummer auf der Kachel. */
  setMarks(marks: Map<string, string>): void;
}

/** Workflows je Art und Modell für die Filter; was nicht unter video steht, gilt als Bild. */
export interface GalleryGroups {
  video: string[];
  models: { id: string; label: string; workflows: string[] }[];
}

const FILTER_KEY = 'brennglas.galFilter';

function readFilter(): { kind: string; model: string } {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(FILTER_KEY) ?? '{}');
    const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    return { kind: ['image', 'video'].includes(o.kind as string) ? (o.kind as string) : '', model: typeof o.model === 'string' ? o.model : '' };
  } catch {
    return { kind: '', model: '' };
  }
}

const FOLDER_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h6l2 2h10v11H3z"/></svg>';

export function gallery(
  onPick: (g: Generation) => void, badges: Map<string, string>, figs: { el: HTMLElement; count: HTMLElement } | null = null,
  onCut: ((g: Generation) => void) | null = null,
  groups: GalleryGroups = { video: [], models: [] },
): Gallery {
  const items = new Map<string, Generation>();
  const tiles = new Map<string, HTMLElement>();
  let marks = new Map<string, string>();
  const menu = h('div', { class: 'ctx-menu hidden' });
  document.addEventListener('click', () => menu.classList.add('hidden'));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') menu.classList.add('hidden'); });
  document.body.append(menu);
  /** Rechtsklick auf ein fertiges Video: in den Schnitt, ohne erst den Schnittplatz zu öffnen. */
  function context(e: MouseEvent, g: Generation) {
    if (!onCut || !g.video || g.status !== 'done') return;
    e.preventDefault();
    menu.replaceChildren(h('button', { type: 'button', onclick: () => { menu.classList.add('hidden'); onCut(items.get(g.id) ?? g); } }, t('cut.addTo')));
    menu.style.left = `${Math.min(e.clientX, innerWidth - 180)}px`;
    menu.style.top = `${Math.min(e.clientY, innerHeight - 50)}px`;
    menu.classList.remove('hidden');
  }
  const markEl = (id: string) => (marks.has(id) ? h('span', { class: 'cut-mark' }, marks.get(id) ?? '') : null);
  let cursor: number | null = null;
  let selected: string | null = null;
  let filter: GenerationFilter = {};
  let loadToken = 0;

  const grid = h('div', { class: 'grid' });
  const count = h('span');
  const empty = h('p', { class: 'empty-note hidden' }, t('gal.empty'));
  const more = h('button', { type: 'button', class: 'more hidden', onclick: () => {
    // Doppelklick holte sonst dieselbe Seite zweimal
    more.disabled = true;
    void page().catch(() => {}).finally(() => { more.disabled = false; });
  } }, t('gal.more'));
  const search = h('input', { type: 'search', placeholder: t('gal.search'), class: 'search' });
  const favBtn = h('button', { type: 'button', class: 'icon fav-filter', title: t('gal.favOnly') }, '★');
  const folderBtn = h('button', { type: 'button', class: 'icon folder', title: t('gal.folder') });
  folderBtn.innerHTML = FOLDER_SVG;
  folderBtn.addEventListener('click', () => void api.openFolder(selected ?? undefined).catch(() => {}));

  // Art und Modell: gemerkt über den Neustart, gefiltert im Backend (sonst blieben Seiten fast leer)
  const opt = (value: string, text: string) => h('option', { value }, text);
  const kindSel = h('select', { class: 'gal-select' }, opt('', t('gal.allKinds')), opt('image', t('gal.images')), opt('video', t('gal.videos')));
  const modelSel = h('select', { class: 'gal-select' });
  const used = new Set<string>();
  const saved = readFilter();
  kindSel.value = saved.kind;
  let modelId = saved.model;
  function fillModels() {
    const list = groups.models.filter((m) => m.id === modelId || m.workflows.some((w) => used.has(w)));
    modelSel.replaceChildren(opt('', t('gal.allModels')), ...list.map((m) => opt(m.id, m.label)));
    modelSel.value = modelId;
  }
  function applyGroups() {
    const v = groups.video;
    let wf = groups.models.find((m) => m.id === modelId)?.workflows;
    let not: string[] | undefined;
    if (kindSel.value === 'video') wf = wf ? wf.filter((w) => v.includes(w)) : v;
    if (kindSel.value === 'image') {
      if (wf) wf = wf.filter((w) => !v.includes(w));
      else not = v;
    }
    filter = { ...filter, workflows: wf, notWorkflows: not };
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify({ kind: kindSel.value, model: modelId }));
    } catch {
      // ohne Speicher gilt die Auswahl nur bis zum Neuladen
    }
  }
  fillModels();
  applyGroups();
  kindSel.addEventListener('change', () => { applyGroups(); void reload(); });
  modelSel.addEventListener('change', () => { modelId = modelSel.value; applyGroups(); void reload(); });
  void api.usedWorkflows().then((list) => { list.forEach((w) => used.add(w)); fillModels(); }).catch(() => {});

  const matches = (g: Generation) => {
    if (filter.workflows && !filter.workflows.includes(g.workflow)) return false;
    if (filter.notWorkflows?.includes(g.workflow)) return false;
    if (filter.favorite && !g.favorite) return false;
    const q = filter.q?.trim().toLowerCase();
    return !q || g.prompt.toLowerCase().includes(q) || (g.expandedPrompt ?? '').toLowerCase().includes(q);
  };

  function tile(g: Generation): HTMLElement {
    const inner = g.status === 'done'
      ? h('img', { src: imageUrl(g.id, 'thumb'), alt: g.prompt, loading: 'lazy' })
      : h('span', { class: `ph ${g.status}` }, g.status === 'error' ? t('gal.error') : g.status === 'cancelled' ? t('gal.cancelled') : '…');
    // Fertige Bilder lassen sich als Referenz in die Bildleiste ziehen
    // Serie: gemeinsamer Akzentstrich, Farbe aus der Serien-ID, damit zwei Serien nebeneinander unterscheidbar sind
    const hue = g.series ? [...g.series.id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 0) : 0;
    return h('div', {
      class: `tile${g.id === selected ? ' sel' : ''}${g.series ? ' in-series' : ''}`, draggable: g.status === 'done',
      style: g.series ? `--series: hsl(${hue} 70% 60%)` : undefined,
      ondragstart: (e: Event) => (e as DragEvent).dataTransfer?.setData(GEN_DRAG, g.id),
      oncontextmenu: (e: Event) => context(e as MouseEvent, g),
    }, h('button', { type: 'button', class: 'tile-hit', title: g.prompt, onclick: () => onPick(items.get(g.id) ?? g) }, inner), markEl(g.id),
    g.favorite ? h('span', { class: 'badge' }, '★') : null,
    g.series ? h('span', { class: 'series', title: t('gal.series') }, `${g.series.index}/${g.series.size}`) : null, h('span', { class: 'kind' }, `${g.video ? '▶ ' : ''}${badges.get(g.workflow) ?? g.workflow}`), tileX(g));
  }

  /** Laufend: abbrechen. Sonst löschen, mit zweitem Klick als Bestätigung statt Dialog. */
  function tileX(g: Generation): HTMLElement {
    const open = g.status === 'queued' || g.status === 'running';
    const x = h('button', { type: 'button', class: 'tile-x', title: t(open ? 'gal.cancel' : 'gal.delete') }, '×');
    let armed: number | undefined;
    x.addEventListener('click', () => {
      if (open) return void api.cancel(g.id).catch((e: Error) => { x.title = e.message; });
      if (armed === undefined) {
        x.classList.add('arm');
        x.textContent = t('gal.deleteConfirm');
        armed = window.setTimeout(() => { armed = undefined; x.classList.remove('arm'); x.textContent = '×'; }, 3000);
        return;
      }
      clearTimeout(armed);
      x.disabled = true;
      api.remove(g.id).catch((e: Error) => { x.disabled = false; x.title = e.message; x.textContent = '!'; });
    });
    return x;
  }

  function remove(id: string) {
    tiles.get(id)?.remove();
    tiles.delete(id);
    items.delete(id);
    count.textContent = String(items.size);
    empty.classList.toggle('hidden', items.size > 0);
  }

  function upsert(g: Generation, top: boolean) {
    if (!matches(g)) return remove(g.id);
    items.set(g.id, g);
    const fresh = tile(g);
    const old = tiles.get(g.id);
    if (old) old.replaceWith(fresh);
    else if (top) grid.prepend(fresh);
    else grid.append(fresh);
    tiles.set(g.id, fresh);
    count.textContent = String(items.size);
    empty.classList.add('hidden');
  }

  function select(id: string | null) {
    if (selected) tiles.get(selected)?.classList.remove('sel');
    selected = id;
    if (id) tiles.get(id)?.classList.add('sel');
  }

  async function page() {
    const token = loadToken;
    const p = await api.generations(cursor, filter);
    if (token !== loadToken) return; // Filter hat sich inzwischen geändert
    for (const g of p.items) upsert(g, false);
    cursor = p.nextCursor;
    more.classList.toggle('hidden', cursor === null);
    empty.classList.toggle('hidden', items.size > 0);
  }

  async function reload() {
    loadToken++;
    grid.replaceChildren();
    items.clear();
    tiles.clear();
    cursor = null;
    count.textContent = '0';
    await page();
  }

  async function refresh(id: string) {
    try {
      upsert(await api.generation(id), !tiles.has(id));
    } catch {
      // Eintrag weg oder Backend kurz aus – die nächste Meldung holt es nach
    }
  }

  let debounce = 0;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = window.setTimeout(() => {
      filter = { ...filter, q: search.value.trim() || undefined };
      void reload();
    }, 250);
  });
  favBtn.addEventListener('click', () => {
    filter = { ...filter, favorite: !filter.favorite || undefined };
    favBtn.classList.toggle('on', !!filter.favorite);
    void reload();
  });

  function onEvent(ev: SseEvent) {
    if (ev.type === 'deleted') return remove(ev.id);
    if (ev.type === 'done' && !used.has(ev.generation.workflow)) {
      used.add(ev.generation.workflow);
      fillModels();
    }
    if (ev.type === 'done') upsert(ev.generation, !tiles.has(ev.generation.id));
    else if (ev.type === 'status' || ev.type === 'error') void refresh(ev.id);
    else if (ev.type === 'favorite') {
      const g = items.get(ev.id);
      if (g) upsert({ ...g, favorite: ev.favorite }, false);
      else if (ev.favorite) void refresh(ev.id);
    }
  }

  function resync() {
    for (const g of items.values()) if (g.status === 'queued' || g.status === 'running') void refresh(g.id);
    const token = loadToken;
    void api.generations(null, filter, 20).then((p) => {
      if (token === loadToken) for (const g of [...p.items].reverse()) if (!tiles.has(g.id)) upsert(g, true);
    }).catch(() => {});
  }

  // Reiter „Bilder | Figuren“; ohne Figuren-Ansicht bleibt die schlichte Überschrift
  const images = h('div', { class: 'gal-images' }, h('div', { class: 'gal-tools' }, search, favBtn, folderBtn),
    h('div', { class: 'gal-filters' }, kindSel, modelSel), grid, empty, more);
  const tabImages = h('button', { type: 'button', class: 'gal-tab on' }, t('gal.title'), count);
  const tabFigs = figs ? h('button', { type: 'button', class: 'gal-tab' }, t('fig.title'), figs.count) : null;
  const show = (f: boolean) => {
    images.classList.toggle('hidden', f);
    figs?.el.classList.toggle('hidden', !f);
    tabImages.classList.toggle('on', !f);
    tabFigs?.classList.toggle('on', f);
  };
  tabImages.addEventListener('click', () => show(false));
  tabFigs?.addEventListener('click', () => show(true));
  figs?.el.classList.add('hidden');
  const el = h('aside', { class: 'panel gallery' },
    figs ? h('div', { class: 'gal-tabs' }, tabImages, tabFigs) : h('h2', {}, t('gal.title'), count),
    images, figs?.el);
  function setMarks(m: Map<string, string>) {
    marks = m;
    for (const [id, el] of tiles) {
      el.querySelector('.cut-mark')?.remove();
      const n = markEl(id);
      if (n) el.append(n);
    }
  }

  return { el, load: page, onEvent, select, resync, setMarks };
}
