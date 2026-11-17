import type { FieldSpec, Figure, GenerateRequest, Generation, ImageSource, Mode, ModelInfo, ParamValue, WorkflowInfo } from '@brennglas/shared';
import { api, GEN_DRAG, imageUrl, refUrl } from '../api.ts';
import { copyText, h } from '../dom.ts';
import { lang, t, tx } from '../i18n.ts';
import { commercialLabel, ensureLicense } from './license.ts';

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
  /** In den Bearbeiten-Modus und diese Figur für die nächste Szene wählen. */
  useFigure(id: string): void;
  /** Das Werkzeug (Schnitt) statt eines Modells zeigen. */
  openTool(): void;
}

/** Werkzeug im Modell-Menü: eigene Einstellungen links, der Absende-Knopf ruft submit. */
export interface Tool {
  id: string;
  label: string;
  group: string;
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
    el: h('label', {}, lbl(spec, key), h('div', { class: 'row' }, input, out)),
    get: () => Number(input.value),
    set: (v) => { if (typeof v === 'number') { input.value = String(v); show(); } },
  };
}

function textField(key: string, spec: FieldSpec): Field {
  const input = h('input', { type: 'text', spellcheck: false, placeholder: tx(spec.placeholder) ?? '', value: typeof spec.default === 'string' ? spec.default : '' });
  return {
    el: h('label', {}, lbl(spec, key), input),
    get: () => (input.value.trim() === '' ? undefined : input.value.trim()),
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

const ASPECTS: [string, number][] = [['16:9', 16 / 9], ['9:16', 9 / 16], ['1:1', 1], ['4:3', 4 / 3], ['3:4', 3 / 4], ['3:2', 3 / 2], ['2:3', 2 / 3], ['21:9', 21 / 9]];

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
  const aspect = h('select', { class: 'fig-aspect' }, ...ASPECTS.map(([l, v]) => h('option', { value: String(v) }, l)));
  const hint = h('small', { class: 'opt-hint' });
  const row = h('div', { class: 'row hidden' }, h('span', { class: 'lbl' }, t('scene.format')), aspect);
  const el = h('div', { class: 'field hidden' }, h('span', { class: 'lbl' }, t('scene.figures')), h('div', { class: 'fig-pick' }, chips, add), row, hint);

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
    row.classList.toggle('hidden', chosen.length === 0);
    const names = chosen.map((id) => list.find((f) => f.id === id)?.name).join(', ');
    hint.textContent = chosen.length ? t('scene.hint', { names, next: refToken(token, 2 + 2 * chosen.length) }) : t('scene.pick');
    onChange(chosen.length);
  }
  render();
  return {
    el,
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

const MODES: readonly Mode[] = ['t2i', 'edit', 't2v', 'i2v', 'flf2v', 'upscale', 'video', 'prompt'];
const MODE_KEY = {
  t2i: 'mode.t2i', edit: 'mode.edit', upscale: 'mode.upscale', video: 'mode.video', t2v: 'mode.t2v', i2v: 'mode.i2v', flf2v: 'mode.flf2v', prompt: 'mode.prompt',
} as const;
const PICK = 'brennglas.model';

/** Gruppe im Dropdown, abgeleitet aus den Modi des Modells. */
const GROUPS = ['image', 'movie', 'upscale', 'text'] as const;
const GROUP_KEY = { image: 'group.image', movie: 'group.movie', upscale: 'group.upscale', text: 'group.text' } as const;
const groupOf = (m: ModelInfo): (typeof GROUPS)[number] =>
  m.modes.t2i || m.modes.edit ? 'image' : m.modes.t2v || m.modes.i2v ? 'movie' : m.modes.prompt ? 'text' : 'upscale';

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
    ? figurePicker(wf.refToken, (n) => image?.field.limit(n ? wf.refs - 2 * n : 1 + wf.refs)) : null;
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
      if (figures) section.append(figures.el);
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
  if (advanced.childElementCount > 0) {
    section.append(h('details', { class: 'adv' }, h('summary', {}, t('form.advanced')), advanced));
  }
  return prompt || image || wf.kind === 'video' ? { wf, section, prompt, fields, image, figures } : null;
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

  const usable = models.filter((m) => Object.values(m.modes).every((w) => w !== undefined && forms.has(w)));
  const modes = MODES.filter((md) => usable.some((m) => m.modes[md]));
  const ready = (m: ModelInfo) => m.missing?.length === 0;

  const tabs = modes.map((md) => h('button', { type: 'button', class: 'tab', onclick: () => select(model?.id, md) }, t(MODE_KEY[md])));
  const option = (x: ModelInfo) => h('option', { value: x.id }, x.missing?.length ? `${tx(x.name) ?? x.id} – ${t('model.notInstalled')}` : tx(x.name) ?? x.id);
  const modelSelect = h('select', { class: 'model-select' }, ...GROUPS.map((g) => {
    const list = usable.filter((x) => groupOf(x) === g);
    return list.length ? h('optgroup', { label: t(GROUP_KEY[g]) }, ...list.map(option)) : null;
  }).filter((x) => x !== null), tool ? h('optgroup', { label: tool.group }, h('option', { value: tool.id }, tool.label)) : null);
  const licence = h('div', { class: 'lic-line' });
  const missing = h('p', { class: 'model-missing hidden' });
  const tabsEl = h('div', { class: 'tabs' }, ...tabs);
  modelSelect.addEventListener('change', () => (modelSelect.value === tool?.id ? openTool() : select(modelSelect.value)));
  let toolOn = false;

  function openTool() {
    if (!tool) return;
    toolOn = true;
    remember(tool.id);
    modelSelect.value = tool.id;
    for (const x of [tabsEl, licence, missing, count, pgBox, ...[...forms.values()].map((o) => o.section)]) x.classList.add('hidden');
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
    tabsEl.classList.remove('hidden');
    licence.classList.remove('hidden');
    tool.leave();
  }

  let mode: Mode = modes[0] ?? 't2i';
  let model: ModelInfo | null = null;
  let active: WorkflowForm | null = null;
  let busy = false;

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
    licence.replaceChildren(t('lic.label'), ' ',
      h('a', { href: m.license.url, target: '_blank', rel: 'noopener noreferrer' }, m.license.name), ` · ${commercialLabel(m)}`);
    licence.title = tx(m.license.summary) ?? '';
    const links = (m.missing ?? []).flatMap((file, i) => {
      const url = m.downloads[file];
      return [i ? ', ' : ' ', url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, file) : file];
    });
    if (m.missing === null) missing.replaceChildren(t('model.unknown'));
    else missing.replaceChildren(...(m.missing.length ? [t('model.missing'), ...links] : []));
    missing.classList.toggle('hidden', m.missing !== null && !m.missing.length);
    submit.disabled = busy || !!m.missing?.length;
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
    for (const [key, field] of f.fields) field.set(g.params[key]);
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

  const startTool = !!tool && remembered() === tool.id;
  select();
  if (tool) sections.append(tool.section);
  const el = h('form', { class: 'panel input-panel', onsubmit: (e: Event) => void send(e) },
    h('div', { class: 'model-row' }, h('label', {}, h('span', { class: 'lbl' }, t('model.label')), modelSelect), licence, missing),
    tabsEl,
    sections, h('div', { class: 'submit-row' }, submit, count), error, pgBox);
  if (startTool) openTool();
  return { el, continueFrom, remix, addReference, hasMode: (md) => modes.includes(md), targetName: (g, md) => targetFor(g, md)?.short ?? null, setFigures, useFigure, openTool };
}
