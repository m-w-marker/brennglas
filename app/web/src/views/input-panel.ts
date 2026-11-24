import type { DurationStats, FieldSpec, Figure, Text, GenerateRequest, Generation, ImageSource, Mode, ModelInfo, ParamValue, WorkflowInfo } from '@brennglas/shared';
import { api, GEN_DRAG, imageUrl, refUrl, videoUrl } from '../api.ts';
import { copyText, h } from '../dom.ts';
import { lang, t, tx } from '../i18n.ts';
import { commercialLabel, ensureLicense } from './license.ts';
import { BENCH_UNIT_MS, MIN_RUNS, benchTimes, shortDuration } from '../bench.ts';

/** Ein Bild der Leiste; file wird erst beim Absenden hochgeladen. */
interface Item {
  src: { kind: 'file'; file: Blob } | ImageSource;
  url: string;
  name: string;
}

interface Field {
  el: HTMLElement;
  get(): ParamValue | undefined;
  set(v: ParamValue | undefined): void;
  /** Nur Auswahlfelder: Optionen austauschen, der Wert bleibt wenn möglich. */
  setOptions?(options: string[], labels: Record<string, Text>): void;
}

interface ImageField {
  el: HTMLElement;
  max: number;
  get(): Item[];
  set(items: Item[]): void;
  add(it: Item): void;
  take(f: Blob | null | undefined, name?: string): void;
  /** Leert die Leiste und gibt die Bilder heraus, für den Umzug in ein anderes Formular. */
  drain(): Item[];
  /** Höchstzahl ändern, ohne Bilder zu verwerfen (Szene: Figuren belegen Referenzplätze). */
  limit(n: number): void;
}

/** Figuren für eine neue Szene: leere Fläche im Format, je Figur Porträt + Blatt als Referenz. → plan_referenz */
interface FigurePicker {
  el: HTMLElement;
  /** Format der leeren Fläche, eigenes Feld unter dem Figuren-Block, nur mit gewählten Figuren sichtbar. */
  format: HTMLElement;
  get(): string[];
  aspect(): number;
  set(ids: string[], aspect?: number): void;
  update(list: Figure[]): void;
}

interface WorkflowForm {
  wf: WorkflowInfo;
  section: HTMLElement;
  prompt: HTMLTextAreaElement | null;
  fields: Map<string, Field>;
  image: { key: string; field: ImageField } | null;
  figures: FigurePicker | null;
  /** Beim Zeigen des Formulars: veränderliche Auswahl (eigene LoRAs) neu holen. */
  refresh?: () => void;
}

export interface InputPanel {
  el: HTMLElement;
  /** Ergebnis als Eingangsbild in den Modus übernehmen, mit dem dort gewählten Modell. */
  continueFrom(g: Generation, mode: Mode): void;
  hasMode(mode: Mode): boolean;
  remix(g: Generation): void;
  /** Ergebnis als weiteres Bild in die Leiste, im Bearbeiten-Modus. */
  addReference(g: Generation): void;
  /** Kurzname des Zielmodells; g = null wie bei addReference (ohne Herkunft). */
  targetName(g: Generation | null, mode: Mode): string | null;
  /** Figurenliste hat sich geändert (angelegt, Blatt fertig, gelöscht). */
  setFigures(list: Figure[]): void;
  /** Fehlende Dateien neu übernehmen (z. B. sobald ComfyUI antwortet). */
  setModels(list: ModelInfo[]): void;
  /** In den Bearbeiten-Modus und diese Figur für die nächste Szene wählen. */
  useFigure(id: string): void;
  /** Ein Job ist fertig: eigene Laufzeiten neu holen. */
  refreshTimes(): void;
  /** Das Werkzeug (Schnitt) statt der Modell-Einstellungen zeigen. */
  openTool(): void;
  /** Zurück zum zuletzt gewählten Modell. */
  closeTool(): void;
}

/** Werkzeug (Reiter in der Kopfleiste): eigene Einstellungen links, der Absende-Knopf ruft submit. */
export interface Tool {
  section: HTMLElement;
  submitLabel: string;
  busyLabel: string;
  enter(): void;
  leave(): void;
  submit(): Promise<void>;
}

const lbl = (spec: FieldSpec, key: string) => h('span', { class: 'lbl' }, tx(spec.label) ?? key);

function selectField(key: string, spec: FieldSpec): Field {
  const sel = h('select', {}, ...(spec.options ?? []).map((o) => h('option', { value: o, selected: o === spec.default }, tx(spec.optionLabels?.[o]) ?? o)));
  const hint = h('small', { class: 'opt-hint' });
  const showHint = () => {
    hint.textContent = tx(spec.optionHints?.[sel.value]) ?? '';
    hint.classList.toggle('hidden', !hint.textContent);
  };
  sel.addEventListener('change', showHint);
  showHint();
  return {
    el: h('label', {}, lbl(spec, key), sel, hint),
    get: () => sel.value,
    set: (v) => { if (typeof v === 'string') sel.value = v; showHint(); },
    setOptions: (options, labels) => {
      const v = sel.value;
      sel.replaceChildren(...options.map((o) => h('option', { value: o }, tx(labels[o]) ?? o)));
      if (options.includes(v)) sel.value = v;
      showHint();
    },
  };
}

/** Bei MP zusätzlich die Kante eines gleich großen Quadrats in K: 4 MP ≈ 2K, 16 MP ≈ 4K. */
function unitText(v: number, unit: string): string {
  if (unit !== 'MP') return `${v} ${unit}`;
  const k = Math.round(Math.sqrt(v) * 10) / 10;
  return `${v} MP · ${k.toLocaleString(lang)}K`;
}

function presetField(key: string, spec: FieldSpec): Field {
  const presets = spec.presets ?? [];
  let value = Number(spec.default ?? presets[0]?.value);
  const buttons = presets.map((p) =>
    h('button', { type: 'button', class: 'seg', onclick: () => pick(p.value) }, tx(p.label) ?? '', spec.unit ? h('small', {}, unitText(p.value, spec.unit)) : null));
  function pick(v: number) {
    value = v;
    buttons.forEach((b, i) => b.classList.toggle('on', presets[i]?.value === v));
  }
  pick(value);
  return {
    el: h('div', { class: 'field' }, lbl(spec, key), h('div', { class: 'segs', style: `--n:${presets.length}` }, ...buttons)),
    get: () => value,
    set: (v) => { if (typeof v === 'number') pick(v); },
  };
}

function seedField(key: string, spec: FieldSpec): Field {
  const input = h('input', { type: 'text', inputmode: 'numeric', placeholder: t('form.random') });
  const dice = h('button', { type: 'button', class: 'icon', title: t('form.randomTitle'), onclick: () => { input.value = ''; } }, '↻');
  return {
    el: h('label', {}, lbl(spec, key), h('div', { class: 'row' }, input, dice)),
    // Keine Zahl: als Text schicken, damit der Server sie mit Meldung ablehnt statt NaN → null → 0
    get: () => {
      const s = input.value.trim();
      return s === '' ? undefined : Number.isFinite(Number(s)) ? Number(s) : s;
    },
    set: (v) => { input.value = v === undefined ? '' : String(v); },
  };
}

function sliderField(key: string, spec: FieldSpec): Field {
  const input = h('input', { type: 'range', min: spec.min, max: spec.max, step: spec.step, value: String(spec.default ?? spec.min) });
  const out = h('span', { class: 'slider-val' });
  const show = () => { out.textContent = spec.max === 1 ? `${Math.round(Number(input.value) * 100)} %` : input.value; };
  input.addEventListener('input', show);
  show();
  return {
    el: h('label', {}, lbl(spec, key), h('div', { class: 'row' }, input, out), spec.hint ? h('small', { class: 'opt-hint' }, tx(spec.hint) ?? '') : null),
    get: () => Number(input.value),
    set: (v) => { if (typeof v === 'number') { input.value = String(v); show(); } },
  };
}

function textField(key: string, spec: FieldSpec): Field {
  const input = h('input', { type: 'text', spellcheck: false, placeholder: tx(spec.placeholder) ?? '', value: typeof spec.default === 'string' ? spec.default : '' });
  return {
    el: h('label', {}, lbl(spec, key), input, spec.hint ? h('small', { class: 'opt-hint' }, tx(spec.hint) ?? '') : null),
    // Optional: leer heißt bewusst leer (kein Trigger), nicht „Server, nimm den Standard“
    get: () => (input.value.trim() === '' && !spec.optional ? undefined : input.value.trim()),
    set: (v) => { input.value = v === undefined ? '' : String(v); },
  };
}

function numberField(key: string, spec: FieldSpec): Field {
  const input = h('input', {
    type: 'number', min: spec.min, max: spec.max, step: spec.type === 'int' ? 1 : 'any',
    value: spec.default === undefined ? undefined : String(spec.default),
  });
  return {
    el: h('label', {}, lbl(spec, key), input),
    get: () => (input.value === '' ? undefined : Number(input.value)),
    set: (v) => { input.value = v === undefined ? '' : String(v); },
  };
}

function boolField(key: string, spec: FieldSpec): Field {
  const input = h('input', { type: 'checkbox', checked: spec.default !== false });
  return {
    el: h('label', { class: 'check' }, tx(spec.label) ?? key, input),
    get: () => input.checked,
    set: (v) => { if (typeof v === 'boolean') input.checked = v; },
  };
}

const refToken = (token: string, n: number) => token.replace('{n}', String(n)).replace('{i}', String(n - 1));

// Beschriftung wie das Format-Feld bei Text zu Bild
const ASPECTS: [string, number][] = [['16:9 (Widescreen)', 16 / 9], ['9:16 (Portrait Widescreen)', 9 / 16], ['1:1 (Square)', 1],
  ['4:3 (Standard)', 4 / 3], ['3:4 (Portrait Standard)', 3 / 4], ['3:2 (Photo)', 3 / 2], ['2:3 (Portrait Photo)', 2 / 3], ['21:9 (Ultrawide)', 21 / 9]];

function figurePicker(token: string, onChange: (n: number) => void): FigurePicker {
  let list: Figure[] = [];
  let chosen: string[] = [];
  // Nur die gewählten als Chips, der Rest im Dropdown – bleibt kurz, auch bei vielen Figuren
  const chips = h('div', { class: 'fig-chips' });
  const add = h('select', { class: 'fig-add-select' });
  add.addEventListener('change', () => {
    if (add.value) chosen = [...chosen, add.value];
    render();
  });
  const aspect = h('select', {}, ...ASPECTS.map(([l, v]) => h('option', { value: String(v) }, l)));
  const hint = h('small', { class: 'opt-hint' });
  const format = h('label', { class: 'hidden' }, h('span', { class: 'lbl' }, t('scene.format')), aspect);
  const el = h('div', { class: 'field hidden' }, h('span', { class: 'lbl' }, t('scene.figures')), h('div', { class: 'fig-pick' }, chips, add), hint);

  function render() {
    const ready = list.filter((f) => f.sheet?.status === 'done');
    chosen = chosen.filter((id) => ready.some((f) => f.id === id)).slice(0, 3);
    chips.replaceChildren(...chosen.map((id) => {
      const f = ready.find((x) => x.id === id);
      return h('span', { class: 'fig-chip' }, f?.name ?? id,
        h('button', { type: 'button', title: t('drop.remove'), onclick: () => { chosen = chosen.filter((x) => x !== id); render(); } }, '×'));
    }));
    const rest = ready.filter((f) => !chosen.includes(f.id));
    add.replaceChildren(h('option', { value: '' }, t(chosen.length ? 'scene.addMore' : 'scene.add')), ...rest.map((f) => h('option', { value: f.id }, f.name)));
    add.value = '';
    add.classList.toggle('hidden', chosen.length >= 3 || rest.length === 0);
    el.classList.toggle('hidden', ready.length === 0);
    format.classList.toggle('hidden', chosen.length === 0);
    const names = chosen.map((id) => list.find((f) => f.id === id)?.name).join(', ');
    hint.textContent = chosen.length ? t('scene.hint', { names, next: refToken(token, 2 + 2 * chosen.length) }) : t('scene.pick');
    onChange(chosen.length);
  }
  render();
  return {
    el,
    format,
    get: () => [...chosen],
    aspect: () => Number(aspect.value),
    set: (ids, a) => {
      chosen = ids;
      if (a !== undefined) {
        const near = ASPECTS.reduce((b, x) => (Math.abs(x[1] - a) < Math.abs(b[1] - a) ? x : b));
        aspect.value = String(near[1]);
      }
      render();
    },
    update: (l) => { list = l; render(); },
  };
}

/** Bildleiste: Bild 1 wird bearbeitet, weitere sind Referenzen; bei max 1 ein einzelnes Feld. */
function imageBar(key: string, spec: FieldSpec, max: number, token: string, onError: (msg: string) => void): ImageField {
  let list: Item[] = [];
  let cap = max;
  let dragFrom: number | null = null;
  const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: max > 1, class: 'hidden' });
  const box = h('div', { class: 'imgbar' });
  const hint = max > 1 && token ? h('p', { class: 'bar-hint' }, t('bar.hint', { n: max, a: refToken(token, 2), b: refToken(token, 3) })) : null;

  // Nach dem Hochladen ist src kein 'file' mehr, die Vorschau-URL bleibt aber ein Blob
  const release = (it: Item) => { if (it.url.startsWith('blob:')) URL.revokeObjectURL(it.url); };

  function render() {
    if (list.length === 0) {
      const empty = h('div', { class: 'drop', tabindex: 0 }, h('div', { class: 'drop-text' }, h('strong', {}, t('drop.title')), t('drop.sub')));
      empty.addEventListener('click', () => fileInput.click());
      empty.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
      return box.replaceChildren(empty);
    }
    const tiles = list.map((it, i) => {
      const rm = h('button', { type: 'button', class: 'drop-clear', title: t('drop.remove') }, '×');
      rm.addEventListener('click', (e) => { e.stopPropagation(); release(it); list.splice(i, 1); render(); });
      const tile = h('div', { class: i === 0 ? 'bar-tile main' : 'bar-tile', draggable: max > 1, title: it.name },
        h('img', { src: it.url, alt: '' }),
        max > 1 ? h('span', { class: 'bar-n' }, String(i + 1)) : null,
        max === 1 ? h('span', { class: 'drop-name' }, it.name) : null, rm);
      tile.addEventListener('dragstart', (e) => { dragFrom = i; e.dataTransfer?.setData('text/plain', String(i)); });
      tile.addEventListener('dragend', () => { dragFrom = null; });
      tile.dataset.i = String(i);
      return tile;
    });
    const plus = list.length < cap ? h('button', { type: 'button', class: 'bar-add', title: t('bar.add') }, '+') : null;
    plus?.addEventListener('click', () => fileInput.click());
    box.replaceChildren(...tiles, ...(plus ? [plus] : []));
  }

  function add(it: Item) {
    if (max === 1) {
      list.forEach(release);
      list = [];
    }
    if (list.length >= cap) { release(it); return onError(t('bar.full', { n: cap })); }
    onError('');
    list.push(it);
    render();
  }

  function take(f: Blob | null | undefined, fallback = t('drop.pasted')) {
    if (!f) return;
    if (!f.type.startsWith('image/')) return onError(t('drop.notImage'));
    add({ src: { kind: 'file', file: f }, url: URL.createObjectURL(f), name: f instanceof File ? f.name : fallback });
  }

  box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('over'); });
  box.addEventListener('dragleave', () => box.classList.remove('over'));
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    box.classList.remove('over');
    const gen = e.dataTransfer?.getData(GEN_DRAG);
    const target = (e.target as HTMLElement).closest<HTMLElement>('.bar-tile')?.dataset.i;
    if (dragFrom !== null) {
      const to = target === undefined ? list.length - 1 : Number(target);
      const [moved] = list.splice(dragFrom, 1);
      if (moved) list.splice(to, 0, moved);
      dragFrom = null;
      return render();
    }
    if (gen) return add({ src: { kind: 'output', id: gen }, url: imageUrl(gen, 'thumb'), name: t('src.gallery') });
    for (const file of [...(e.dataTransfer?.files ?? [])]) take(file);
  });
  fileInput.addEventListener('change', () => { for (const file of [...(fileInput.files ?? [])]) take(file); fileInput.value = ''; });

  render();
  return {
    el: h('div', { class: 'field' }, lbl(spec, key), box, hint, fileInput),
    max,
    get: () => list,
    set: (items) => { list.forEach(release); items.slice(max).forEach(release); list = items.slice(0, max); render(); },
    add,
    take,
    drain: () => { const out = list; list = []; render(); return out; },
    // Zu viele bleiben stehen und der Server meldet es – stilles Wegwerfen verlöre Bilder
    limit: (n) => { cap = Math.min(max, Math.max(0, n)); render(); },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Layout-Video: Datei oder Galerie-Video, wird sofort hochgeladen; der Wert ist die ID. → plan_layout_render */
function videoField(key: string, spec: FieldSpec, onError: (msg: string) => void): Field {
  let value: string | undefined;
  let url = '';
  // Zählt jede Änderung: eine Upload-Antwort zu einem inzwischen ersetzten Video wird verworfen
  let ticket = 0;
  const fileInput = h('input', { type: 'file', accept: 'video/mp4,video/webm,video/quicktime', class: 'hidden' });
  const box = h('div', { class: 'imgbar' });
  const release = () => { if (url.startsWith('blob:')) URL.revokeObjectURL(url); url = ''; };

  function render(name = '') {
    if (value === undefined) {
      const empty = h('div', { class: 'drop', tabindex: 0 }, h('div', { class: 'drop-text' }, h('strong', {}, t('vid.title')), t('vid.sub')));
      empty.addEventListener('click', () => fileInput.click());
      empty.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
      return box.replaceChildren(empty);
    }
    const rm = h('button', { type: 'button', class: 'drop-clear', title: t('drop.remove') }, '×');
    rm.addEventListener('click', () => { ticket++; release(); value = undefined; render(); });
    const preview = url ? h('video', { src: url, muted: true, loop: true, autoplay: true, playsinline: true }) : null;
    // das muted-Attribut per setAttribute schaltet den Ton nicht ab, nur die Eigenschaft
    if (preview) preview.muted = true;
    box.replaceChildren(h('div', { class: 'bar-tile main' }, preview, h('span', { class: 'drop-name' }, name), rm));
  }

  function take(f: File | undefined) {
    if (!f) return;
    if (!f.type.startsWith('video/')) return onError(t('vid.notVideo'));
    onError('');
    release();
    value = undefined;
    const mine = ++ticket;
    box.replaceChildren(h('div', { class: 'drop' }, h('div', { class: 'drop-text' }, t('vid.uploading'))));
    void api.upload(f).then((u) => {
      if (mine !== ticket) return;
      value = u.inputId;
      url = URL.createObjectURL(f);
      render(f.name);
    }).catch((e: Error) => { if (mine === ticket) { onError(e.message); render(); } });
  }

  function set(v: ParamValue | undefined) {
    ticket++;
    release();
    value = typeof v === 'string' && v ? v : undefined;
    // Galerie-Video hat eine URL; ein alter Upload nur seine ID
    if (value && UUID.test(value)) url = videoUrl(value);
    render(value ? t(UUID.test(value) ? 'src.gallery' : 'vid.uploaded') : '');
  }

  box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('over'); });
  box.addEventListener('dragleave', () => box.classList.remove('over'));
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    box.classList.remove('over');
    const gen = e.dataTransfer?.getData(GEN_DRAG);
    if (gen) return set(gen);
    take(e.dataTransfer?.files[0]);
  });
  fileInput.addEventListener('change', () => { take(fileInput.files?.[0]); fileInput.value = ''; });

  render();
  return { el: h('div', { class: 'field' }, lbl(spec, key), box, fileInput, spec.hint ? h('small', { class: 'opt-hint' }, tx(spec.hint) ?? '') : null), get: () => value, set };
}

const MODES: readonly Mode[] = ['t2i', 'edit', 't2v', 'i2v', 'flf2v', 'l2v', 'upscale', 'video', 'prompt'];
const MODE_KEY = {
  t2i: 'mode.t2i', edit: 'mode.edit', upscale: 'mode.upscale', video: 'mode.video', t2v: 'mode.t2v', i2v: 'mode.i2v', flf2v: 'mode.flf2v', l2v: 'mode.l2v', prompt: 'mode.prompt',
} as const;
const PICK = 'brennglas.model';

/** Gruppe im Dropdown, abgeleitet aus den Modi des Modells. */
const GROUPS = ['image', 'movie', 'upscale', 'text'] as const;
const GROUP_KEY = { image: 'group.image', movie: 'group.movie', upscale: 'group.upscale', text: 'group.text' } as const;
const groupOf = (m: ModelInfo): (typeof GROUPS)[number] =>
  m.modes.t2i || m.modes.edit ? 'image' : m.modes.t2v || m.modes.i2v || m.modes.l2v ? 'movie' : m.modes.prompt ? 'text' : 'upscale';

function remembered(): string | null {
  try {
    return localStorage.getItem(PICK);
  } catch {
    return null;
  }
}

function remember(id: string): void {
  try {
    localStorage.setItem(PICK, id);
  } catch {
    // nur Bequemlichkeit
  }
}

function buildForm(wf: WorkflowInfo, send: () => void, setError: (msg: string) => void, sceneable: boolean): WorkflowForm | null {
  const fields = new Map<string, Field>();
  let image: WorkflowForm['image'] = null;
  // Szene: Fläche + je Figur zwei Referenzen, die Leiste trägt nur den Rest
  const figures = sceneable && wf.refToken && wf.refs >= 2
    ? figurePicker(wf.refToken, (n) => {
      image?.field.limit(n ? wf.refs - 2 * n : 1 + wf.refs);
      fields.get('denoise')?.el.classList.toggle('hidden', n > 0); // Szene hat kein Original, der Server nimmt dann 100 %
    }) : null;
  let prompt: HTMLTextAreaElement | null = null;
  const section = h('div', { class: 'section hidden' });
  const advanced = h('div', { class: 'adv-body' });

  for (const [key, spec] of Object.entries(wf.inputs)) {
    if (key === 'prompt') {
      prompt = h('textarea', { rows: 7, placeholder: `${tx(spec.placeholder) ?? ''}  (${t('form.submitHint')})`.trim() });
      prompt.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send();
      });
      section.append(h('label', {}, lbl(spec, key), prompt));
      continue;
    }
    if (spec.type === 'image') {
      const field = imageBar(key, spec, 1 + wf.refs, wf.refToken ?? '', setError);
      image = { key, field };
      if (figures) section.append(figures.el, figures.format);
      section.append(field.el);
      continue;
    }
    if (spec.type === 'video') {
      const field = videoField(key, spec, setError);
      fields.set(key, field);
      section.append(field.el);
      continue;
    }
    const field = spec.type === 'enum' ? selectField(key, spec)
      : spec.presets ? presetField(key, spec)
      : spec.random ? seedField(key, spec)
      : spec.type === 'bool' ? boolField(key, spec)
      : spec.type === 'string' ? textField(key, spec)
      : spec.step !== undefined && spec.min !== undefined && spec.max !== undefined ? sliderField(key, spec)
      : numberField(key, spec);
    fields.set(key, field);
    (spec.advanced ? advanced : section).append(field.el);
  }
  // Felder mit showIf folgen ihrem Schalter, auch wenn Remix ihn setzt
  for (const [key, spec] of Object.entries(wf.inputs)) {
    const sw = spec.showIf ? fields.get(spec.showIf) : undefined;
    const field = fields.get(key);
    if (!sw || !field) continue;
    const sync = () => field.el.classList.toggle('hidden', sw.get() !== true || sw.el.classList.contains('hidden'));
    const set = sw.set;
    sw.set = (v) => { set(v); sync(); };
    sw.el.addEventListener('change', sync);
    sync();
  }
  const refresh = loraWiring(wf, fields);
  if (advanced.childElementCount > 0) {
    section.append(h('details', { class: 'adv' }, h('summary', {}, t('form.advanced')), advanced));
  }
  return prompt || image || wf.kind === 'video' ? { wf, section, prompt, fields, image, figures, refresh } : null;
}

const TRIGGERS = 'brennglas.loraTriggers';
function storedTriggers(): Record<string, string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(TRIGGERS) ?? '{}');
    return v && typeof v === 'object' ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** LoRA: Trigger folgt der Auswahl (eigene Änderung je Datei gemerkt), ohne passende LoRA kein Schalter. */
function loraWiring(wf: WorkflowInfo, fields: Map<string, Field>): (() => void) | undefined {
  const key = Object.keys(wf.inputs).find((k) => wf.inputs[k]?.loras);
  const spec = key ? wf.inputs[key] : undefined;
  const sel = key ? fields.get(key) : undefined;
  if (!key || !spec || !sel) return undefined;
  const trigKey = Object.keys(wf.inputs).find((k) => wf.inputs[k]?.fillFrom === key);
  const trig = trigKey ? fields.get(trigKey) : undefined;
  const sw = spec.showIf ? fields.get(spec.showIf) : undefined;
  const file = () => String(sel.get() ?? '');
  const fill = () => trig?.set(storedTriggers()[file()] ?? spec.triggers?.[file()] ?? '');
  sel.el.addEventListener('change', fill);
  trig?.el.addEventListener('input', () => {
    try {
      localStorage.setItem(TRIGGERS, JSON.stringify({ ...storedTriggers(), [file()]: String(trig.get() ?? '') }));
    } catch {
      // nur Bequemlichkeit
    }
  });
  const apply = () => {
    sel.setOptions?.(spec.options ?? [], spec.optionLabels ?? {});
    sw?.el.classList.toggle('hidden', !spec.options?.length);
    // Versteckter Schalter darf nicht an bleiben, sonst stünden die LoRA-Felder mit leerer Auswahl da
    if (!spec.options?.length) sw?.set(false);
  };
  apply();
  fill();
  return () => void api.loras(wf.name).then((r) => {
    const before = file();
    Object.assign(spec, { options: r.options, optionLabels: r.optionLabels, triggers: r.triggers });
    apply();
    if (file() !== before) fill();
  }, () => {});
}

/** Modus-Tabs, darunter die Modelle dieses Modus; das Formular entsteht aus der *.map.json. */
export function inputPanel(
  workflows: WorkflowInfo[], models: ModelInfo[], onSubmit: (req: GenerateRequest, follow: boolean) => Promise<void>, onModelChange: () => void = () => {},
  tool: Tool | null = null,
): InputPanel {
  const error = h('p', { class: 'form-error' });
  const setError = (msg: string) => { error.textContent = msg; };
  const submit = h('button', { type: 'submit', class: 'primary' });
  const count = h('select', { class: 'count', title: t('form.countTitle') }, ...[1, 2, 4, 8].map((n) => h('option', { value: n }, `${n}×`)));
  const sections = h('div', { class: 'sections' });
  // Prompt-Assistent: Ergebnis zum Kopieren oder zurück ins Formular, aus dem man kam
  const pgOut = h('textarea', { rows: 9, class: 'pg-out' });
  const pgCopy = h('button', { type: 'button', class: 'button ghost' }, t('res.copy'));
  const pgUse = h('button', { type: 'button', class: 'button ghost' }, t('pg.use'));
  const pgBox = h('div', { class: 'pg-box hidden' }, h('label', {}, h('span', { class: 'lbl' }, t('pg.result')), pgOut),
    h('div', { class: 'pg-actions' }, pgCopy, pgUse));
  let lastWork: { modelId: string; mode: Mode } | null = null;
  pgCopy.addEventListener('click', () => void copyText(pgOut.value).then((ok) => {
    pgCopy.textContent = ok ? t('res.copied') : t('res.copyFail');
    setTimeout(() => { pgCopy.textContent = t('res.copy'); }, 1500);
  }));
  pgUse.addEventListener('click', () => {
    const text = pgOut.value.trim();
    if (!text || !lastWork) return;
    select(lastWork.modelId, lastWork.mode);
    if (active?.prompt) {
      active.prompt.value = text;
      active.prompt.focus();
    }
  });
  const forms = new Map<string, WorkflowForm>();
  const editFlows = new Set(models.map((m) => m.modes.edit));
  for (const wf of workflows) {
    const f = buildForm(wf, () => void send(), setError, editFlows.has(wf.name));
    if (!f) continue;
    forms.set(wf.name, f);
    sections.append(f.section);
  }

  // Modelle nur mit Modi, die hier keinen Reiter haben, bleiben draußen
  const usable = models.filter((m) => Object.values(m.modes).every((w) => w !== undefined && forms.has(w)) && MODES.some((md) => m.modes[md]));
  const modes = MODES.filter((md) => usable.some((m) => m.modes[md]));
  const ready = (m: ModelInfo) => m.missing?.length === 0;

  const tabs = modes.map((md) => h('button', { type: 'button', class: 'tab', onclick: () => select(model?.id, md) }, t(MODE_KEY[md])));
  const optionText = (x: ModelInfo) => x.missing?.length ? `${tx(x.name) ?? x.id} – ${t('model.notInstalled')}` : tx(x.name) ?? x.id;
  const option = (x: ModelInfo) => h('option', { value: x.id }, optionText(x));
  const modelSelect = h('select', { class: 'model-select' }, ...GROUPS.map((g) => {
    const list = usable.filter((x) => groupOf(x) === g);
    return list.length ? h('optgroup', { label: t(GROUP_KEY[g]) }, ...list.map(option)) : null;
  }).filter((x) => x !== null));
  const licence = h('div', { class: 'lic-line' });
  const benchLine = h('div', { class: 'lic-line bench-line' });
  const ramLine = h('div', { class: 'lic-line bench-line' });
  const ownLine = h('div', { class: 'lic-line bench-line' });
  let stats: DurationStats = {};
  let statsAt = 0;
  const missing = h('p', { class: 'model-missing hidden' });
  const tabsEl = h('div', { class: 'tabs' }, ...tabs);
  const modelRow = h('div', { class: 'model-row' }, h('label', {}, h('span', { class: 'lbl' }, t('model.label')), modelSelect), licence, h('div', { class: 'bench' }, benchLine, ramLine, ownLine), missing);
  modelSelect.addEventListener('change', () => select(modelSelect.value));
  let toolOn = false;

  function openTool() {
    if (!tool || toolOn) return;
    toolOn = true;
    for (const x of [modelRow, tabsEl, count, pgBox, ...[...forms.values()].map((o) => o.section)]) x.classList.add('hidden');
    tool.section.classList.remove('hidden');
    submit.textContent = busy ? tool.busyLabel : tool.submitLabel;
    submit.disabled = busy;
    setError('');
    tool.enter();
  }

  function closeTool() {
    if (!tool || !toolOn) return;
    toolOn = false;
    tool.section.classList.add('hidden');
    modelRow.classList.remove('hidden');
    tabsEl.classList.remove('hidden');
    tool.leave();
  }

  let mode: Mode = modes[0] ?? 't2i';
  let model: ModelInfo | null = null;
  let active: WorkflowForm | null = null;
  let busy = false;

  function showMissing(m: ModelInfo) {
    const links = (m.missing ?? []).flatMap((file, i) => {
      const url = m.downloads[file];
      return [i ? ', ' : ' ', url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, file) : file];
    });
    if (m.missing === null) missing.replaceChildren(t('model.unknown'));
    else missing.replaceChildren(...(m.missing.length ? [t('model.missing'), ...links] : []));
    missing.classList.toggle('hidden', m.missing !== null && !m.missing.length);
    if (!toolOn) submit.disabled = busy || !!m.missing?.length;
  }

  function setModels(list: ModelInfo[]) {
    for (const x of list) {
      const m = usable.find((u) => u.id === x.id);
      if (m) m.missing = x.missing;
    }
    for (const o of modelSelect.querySelectorAll('option')) {
      const m = usable.find((u) => u.id === o.value);
      if (m) o.textContent = optionText(m);
    }
    if (model) showMissing(model);
  }

  /** Das Modell ist global gewählt; die Tabs zeigen nur, was es kann. Fehlt der Modus, gilt der erste. */
  function select(modelId?: string, md?: Mode) {
    const m = usable.find((x) => x.id === modelId) ?? usable.find((x) => x.id === remembered()) ?? usable.find(ready) ?? usable[0];
    if (!m) return;
    const next = [md, mode, ...MODES].find((x): x is Mode => x !== undefined && m.modes[x] !== undefined);
    const wfName = next ? m.modes[next] : undefined;
    const f = wfName ? forms.get(wfName) : undefined;
    if (!next || !f) return;
    closeTool();
    // Beim Modellwechsel im selben Modus Prompt und Bildleiste mitnehmen
    if (next === mode && active?.prompt && f.prompt && f !== active && !f.prompt.value.trim()) f.prompt.value = active.prompt.value;
    if (next === mode && f !== active && active?.figures && f.figures) f.figures.set(active.figures.get(), active.figures.aspect());
    let cut = 0;
    if (next === mode && f !== active && active?.image && f.image) {
      const moving = active.image.field.drain();
      if (moving.length) f.image.field.set(moving);
      cut = Math.max(0, moving.length - f.image.field.max);
    }
    const changed = m !== model;
    mode = next;
    model = m;
    active = f;
    remember(m.id);
    modelSelect.value = m.id;
    tabs.forEach((b, i) => {
      b.classList.toggle('on', modes[i] === next);
      b.classList.toggle('hidden', m.modes[modes[i] as Mode] === undefined);
    });
    for (const o of forms.values()) o.section.classList.toggle('hidden', o !== f);
    f.refresh?.();
    licence.replaceChildren(t('lic.label'), ' ',
      h('a', { href: m.license.url, target: '_blank', rel: 'noopener noreferrer' }, m.license.name), ` · ${commercialLabel(m)}`);
    licence.title = tx(m.license.summary) ?? '';
    showBench(m, next);
    showMissing(m);
    submit.textContent = tx(f.wf.submit) ?? t(f.image ? 'form.edit' : 'form.generate');
    count.classList.toggle('hidden', f.wf.kind === 'video' || f.wf.kind === 'text');
    pgBox.classList.toggle('hidden', f.wf.kind !== 'text' || !pgOut.value);
    if (f.wf.kind !== 'text') lastWork = { modelId: m.id, mode: next };
    pgUse.disabled = !lastWork;
    setError(cut ? t('bar.cut', { n: cut, max: f.image?.field.max ?? 0 }) : '');
    if (changed) onModelChange();
  }

  window.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
    if (!item || toolOn) return;
    // Text aus Office bringt ein Bild mit; im Textfeld gewinnt der Text
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, textarea') && e.clipboardData?.types.includes('text/plain')) return;
    if (!active?.image) switchTo('edit');
    if (!active?.image) return;
    e.preventDefault();
    active.image.field.take(item.getAsFile());
  });

  async function send(e?: Event) {
    e?.preventDefault();
    if (toolOn && tool) {
      if (busy) return;
      setError('');
      busy = true;
      submit.disabled = true;
      submit.textContent = tool.busyLabel;
      try {
        await tool.submit();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        busy = false;
        // Während des Renderns kann ein Modell gewählt worden sein, dessen Dateien fehlen
        submit.disabled = toolOn ? false : !!model?.missing?.length;
        if (toolOn) submit.textContent = tool.submitLabel;
      }
      return;
    }
    const f = active;
    const m = model;
    if (!f || !m || busy || submit.disabled) return;
    setError('');
    const text = f.prompt?.value.trim() ?? '';
    if (f.prompt && !text) return void f.prompt.focus();
    busy = true;
    submit.disabled = true;
    try {
      if (!(await ensureLicense(m))) return;
      const params: Record<string, ParamValue> = {};
      for (const [key, field] of f.fields) {
        // Ausgeblendet (LoRA aus/ohne Auswahl): Backend nimmt den Default, eine leere Auswahl wäre keine erlaubte Option
        if (field.el.classList.contains('hidden')) continue;
        const v = field.get();
        if (v !== undefined) params[key] = v;
      }
      const req: GenerateRequest = { workflow: f.wf.name, params };
      if (f.prompt) req.prompt = text;
      if (f.image) {
        const items = f.image.field.get();
        const figs = f.figures?.get() ?? [];
        if (items.length === 0 && !figs.length && !f.wf.inputs[f.image.key]?.optional) throw new Error(t('form.needImage'));
        if (figs.length && f.figures) {
          req.figures = figs;
          req.aspect = f.figures.aspect();
        }
        req.images = [];
        // Hochgeladenes merken, damit ein zweites Absenden nicht erneut hochlädt
        for (const it of items) {
          if (it.src.kind === 'file') it.src = { kind: 'upload', id: (await api.upload(it.src.file)).inputId };
          req.images.push(it.src);
        }
      }
      if (f.wf.kind === 'text') {
        pgOut.value = '';
        pgOut.placeholder = t('pg.busy');
        pgBox.classList.remove('hidden');
        pgOut.value = (await api.enhance(req)).text;
        return;
      }
      // Serie: fester Seed zählt hoch, ohne Seed würfelt der Server je Job
      const n = f.wf.kind === 'video' ? 1 : Number(count.value);
      const seed = Object.entries(f.wf.inputs).find(([, s]) => s.random);
      const seriesId = n > 1 ? crypto.randomUUID() : null;
      for (let i = 0; i < n; i++) {
        const p = { ...params };
        const base = seed ? params[seed[0]] : undefined;
        if (seed && typeof base === 'number' && i > 0) p[seed[0]] = (base + i) % ((seed[1].max ?? Number.MAX_SAFE_INTEGER) + 1);
        await onSubmit({ ...req, params: p, ...(seriesId ? { series: { id: seriesId, index: i + 1, size: n } } : {}) }, i === 0);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      busy = false;
      submit.disabled = !!model?.missing?.length;
    }
  }

  /** Reihenfolge: Modell des Bildes, dann das gewählte, dann die Liste – installierte vor fehlenden. */
  function targetFor(g: Generation | null, md: Mode): ModelInfo | undefined {
    const origin = g ? usable.find((x) => Object.values(x.modes).includes(g.workflow)) : undefined;
    const cands = [origin, model, ...usable].filter((x): x is ModelInfo => !!x?.modes[md]);
    return cands.find(ready) ?? cands[0];
  }

  /** Zeit auf der RTX 3090, eigene oder geschätzte Zeit, RAM-Empfehlung; Laufzeiten höchstens alle 20 s neu holen. */
  function showBench(m: ModelInfo, md: Mode, fresh = false) {
    const b = m.bench;
    benchLine.classList.toggle('hidden', !b);
    ramLine.classList.toggle('hidden', !b);
    ownLine.classList.add('hidden');
    if (!b) return;
    const d = (ms: number) => shortDuration(ms, lang);
    const speed = b.speed[md];
    const enh = b.speedEnhanced?.[md];
    const times = benchTimes(models, stats, m, md);
    // Referenz der RTX 3090, darunter RAM, dann die eigene GPU (gemessen oder geschätzt)
    const pair = (a: number | undefined, e: number | undefined) =>
      [a !== undefined ? d(a) : null, e !== undefined ? t('bench.enh', { s: d(e) }) : null].filter(Boolean).join(' · ');
    const ref = speed === undefined ? null
      : t('bench.ref', { s: pair(speed * BENCH_UNIT_MS, enh === undefined ? undefined : enh * BENCH_UNIT_MS) }) + (tx(b.basis) ? ` (${tx(b.basis)})` : '');
    benchLine.textContent = ref ?? '';
    benchLine.classList.toggle('hidden', !ref);
    benchLine.title = t('bench.title');
    ramLine.textContent = t('bench.ram', { n: b.ramGB });
    ramLine.title = t('bench.title');
    const { plain, enhanced } = times;
    const wf = m.modes[md];
    if (plain || enhanced) {
      const est = !(plain?.own ?? true) || !(enhanced?.own ?? true);
      ownLine.textContent = t(est ? 'bench.mineEst' : 'bench.mine', { s: pair(plain?.ms, enhanced?.ms) });
    } else if (wf) {
      const n = Math.max(stats[wf]?.n ?? 0, stats[`${wf}+pe`]?.n ?? 0);
      ownLine.textContent = t('bench.minePending', { n: Math.min(n, MIN_RUNS), max: MIN_RUNS });
    }
    ownLine.title = t('bench.title');
    ownLine.classList.toggle('hidden', !(plain || enhanced || wf));
    if (!fresh && Date.now() - statsAt > 20_000) {
      statsAt = Date.now();
      void api.durations().then((s) => { stats = s; if (model) showBench(model, mode, true); }).catch(() => {});
    }
  }

  function switchTo(md: Mode, g: Generation | null = null) {
    const m = targetFor(g, md);
    if (m) select(m.id, md);
  }

  function continueFrom(g: Generation, md: Mode) {
    switchTo(md, g);
    const f = active;
    if (mode !== md || !f?.image) return;
    f.figures?.set([]);
    // Neu ansetzen: Referenzen des letzten Schritts gehören nicht automatisch zum nächsten
    f.image.field.set([{ src: { kind: 'output', id: g.id }, url: imageUrl(g.id, 'thumb'), name: t('src.result', { w: g.width ?? 0, h: g.height ?? 0 }) }]);
    if (f.prompt) {
      f.prompt.value = '';
      f.prompt.focus();
    }
  }

  /** Parameter eines Bildes zurück ins Formular, inklusive Seed – zum Variieren den Seed leeren. */
  function remix(g: Generation) {
    const hit = usable.flatMap((m) => MODES.filter((md) => m.modes[md] === g.workflow).map((md) => ({ m, md })))[0];
    if (!hit) return setError(t('form.notLoaded', { name: g.workflow }));
    select(hit.m.id, hit.md);
    const f = active;
    if (!f) return;
    if (f.prompt) f.prompt.value = g.prompt;
    // Fehlt ein Wert (Bild älter als das Feld), gilt der Default – nicht der zufällig gerade eingestellte
    for (const [key, field] of f.fields) field.set(g.params[key] ?? f.wf.inputs[key]?.default);
    // Szene aus Figuren: Auswahl und Format zurück, die Leiste trug nur Zusatzbilder
    const figs = typeof g.params.figures === 'string' ? g.params.figures.split(',').filter(Boolean) : [];
    f.figures?.set(figs, typeof g.params.aspect === 'number' ? g.params.aspect : undefined);
    // Referenzen der Szene: erst je Figur Porträt + Blatt, danach die Zusatzbilder der Leiste
    if (figs.length) f.image?.field.set(Array.from({ length: Math.max(0, g.refCount - 2 * figs.length) }, (_, k): Item => {
      const i = 2 * figs.length + 1 + k;
      return { src: { kind: 'input', id: g.id, index: i }, url: refUrl(g.id, i), name: t('src.ref', { n: i + 1 }) };
    }));
    if (f.image && g.hasInput) {
      const main: Item = g.parentId
        ? { src: { kind: 'output', id: g.parentId }, url: imageUrl(g.parentId, 'thumb'), name: t('src.chain') }
        : { src: { kind: 'input', id: g.id, index: 0 }, url: imageUrl(g.id, 'input'), name: t('src.upload') };
      const refs = Array.from({ length: g.refCount }, (_, i): Item => (
        { src: { kind: 'input', id: g.id, index: i + 1 }, url: refUrl(g.id, i + 1), name: t('src.ref', { n: i + 2 }) }));
      f.image.field.set([main, ...refs]);
    }
    f.prompt?.focus();
  }

  /** Referenz gehört zur laufenden Arbeit: gewähltes Modell vor der Herkunft des Bildes. */
  function addReference(g: Generation) {
    switchTo('edit');
    if (mode !== 'edit' || !active?.image) return;
    active.image.field.add({ src: { kind: 'output', id: g.id }, url: imageUrl(g.id, 'thumb'), name: t('src.gallery') });
  }

  function setFigures(list: Figure[]) {
    for (const f of forms.values()) f.figures?.update(list);
  }

  function useFigure(id: string) {
    switchTo('edit');
    const p = active?.figures;
    if (mode !== 'edit' || !p) return;
    p.set([...p.get().filter((x) => x !== id), id]);
    active?.prompt?.focus();
  }

  select();
  if (tool) sections.append(tool.section);
  const el = h('form', { class: 'panel input-panel', onsubmit: (e: Event) => void send(e) },
    modelRow, tabsEl,
    sections, h('div', { class: 'submit-row' }, submit, count), error, pgBox);
  // select() stellt Modell-Zeile, Formular und Absende-Knopf wieder her
  const leaveTool = () => toolOn && select(model?.id, mode);
  return { el, continueFrom, remix, addReference, hasMode: (md) => modes.includes(md), targetName: (g, md) => targetFor(g, md)?.short ?? null, setFigures, setModels, useFigure, openTool, closeTool: leaveTool,
    refreshTimes: () => { statsAt = 0; if (model) showBench(model, mode); } };
}
