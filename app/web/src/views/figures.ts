import { MAX_EXTRA_VIEWS } from '@brennglas/shared';
import type { Figure, FigureKind, FigureSheetRequest, Generation, ImageSource, ModelInfo, SseEvent, WorkflowInfo } from '@brennglas/shared';
import { api, imageUrl, refUrl } from '../api.ts';
import { h } from '../dom.ts';
import { t, tx } from '../i18n.ts';
import { commercialLabel, ensureLicense } from './license.ts';

export interface Figures {
  el: HTMLElement;
  /** Anzahl für den Reiter in der Galerie. */
  count: HTMLElement;
  load(): Promise<void>;
  onEvent(ev: SseEvent): void;
  /** Dialog „Als Figur anlegen“ für ein fertiges Bild. */
  create(g: Generation): void;
}

/** Figurenleiste über der Galerie: Porträt, Name, Status des Blatts. → plan_referenz */
export function figures(
  workflows: WorkflowInfo[], models: ModelInfo[], onShow: (g: Generation) => void, onStarted: (id: string) => void,
  onList: (list: Figure[]) => void, onUse: (id: string) => void,
): Figures {
  const list = h('div', { class: 'fig-list' });
  const count = h('span');
  // Porträt per Upload: Datei hochladen, dann derselbe Dialog wie bei „Als Figur“
  const file = h('input', { type: 'file', accept: 'image/*', class: 'hidden' });
  const add = h('button', { type: 'button', class: 'fig-add', title: t('fig.addTitle') }, '+');
  add.addEventListener('click', () => file.click());
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    file.value = '';
    upErr.textContent = '';
    if (!f) return;
    void api.upload(f).then((u) => dialog({ kind: 'upload', id: u.inputId }, URL.createObjectURL(f))).catch((e: Error) => { upErr.textContent = e.message; });
  });
  const empty = h('p', { class: 'fig-empty' }, t('fig.empty'));
  const upErr = h('p', { class: 'form-error' });
  list.append(add);
  const el = h('div', { class: 'figures' }, list, upErr, empty, file);
  let all: Figure[] = [];

  // Nur Modelle, deren Bearbeiten-Workflow Referenzbilder nimmt; FLUX zuerst (H3-Lizenz schließt die EU aus)
  const refs = new Map(workflows.map((w) => [w.name, w.refs]));
  const editors = models.filter((m) => m.modes.edit && (refs.get(m.modes.edit) ?? 0) > 0)
    .sort((a, b) => Number(b.id === 'flux3') - Number(a.id === 'flux3') || a.order - b.order);

  function card(f: Figure): HTMLElement {
    const s = f.sheet;
    const state = !s ? t('fig.lost') : s.status === 'done' ? '' : s.status === 'error' || s.status === 'cancelled' ? t('fig.failed') : t('fig.busy');
    const del = h('button', { type: 'button', class: 'tile-x', title: t('fig.delete') }, '×');
    let armed: number | undefined;
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (armed === undefined) {
        del.classList.add('arm');
        del.textContent = t('gal.deleteConfirm');
        armed = window.setTimeout(() => { armed = undefined; del.classList.remove('arm'); del.textContent = '×'; }, 3000);
        return;
      }
      clearTimeout(armed);
      void api.deleteFigure(f.id).then(load).catch((err: Error) => { del.title = err.message; del.textContent = '!'; });
    });
    // Porträt = Referenz 1 des Blatt-Jobs
    return h('div', { class: 'fig-card', title: f.name },
      h('button', { type: 'button', class: 'fig-hit', onclick: () => { if (s) onShow(s); } },
        s ? h('img', { src: refUrl(s.id, 1), alt: '' }) : null,
        s?.status === 'done' ? h('img', { class: 'fig-sheet', src: imageUrl(s.id, 'thumb'), alt: '' }) : null),
      h('span', { class: 'fig-name' }, f.name, state ? h('small', {}, state) : null),
      s?.status === 'done' ? h('button', { type: 'button', class: 'fig-use', title: t('fig.useTitle'), onclick: () => onUse(f.id) }, t('fig.use')) : null, del);
  }

  async function load() {
    try {
      all = await api.figures();
    } catch {
      return;
    }
    list.replaceChildren(add, ...all.map(card));
    onList(all);
    count.textContent = String(all.length);
    empty.classList.toggle('hidden', all.length > 0);
  }

  // Offener Dialog hört mit, damit seine Vorschau erscheint, sobald das Blatt fertig ist
  let listener: ((ev: SseEvent) => void) | null = null;

  function onEvent(ev: SseEvent) {
    listener?.(ev);
    // Nur Endzustände; done auch für unbekannte Blätter, sonst fehlen per MCP angelegte Figuren
    if (ev.type === 'done') void load();
    else if ((ev.type === 'error' || ev.type === 'status') && all.some((f) => f.sheetId === ev.id)) void load();
  }

  function create(g: Generation) {
    dialog({ kind: 'output', id: g.id }, imageUrl(g.id, 'thumb'));
  }

  /** Bildfeld: Klick oder Datei hineinziehen, lädt hoch und merkt sich die Quelle. */
  function slot(label: string, onChange: () => void) {
    let src: ImageSource | null = null;
    let url = '';
    let gone = false;
    const file = h('input', { type: 'file', accept: 'image/*', class: 'hidden' });
    const text = h('span', {}, label);
    const box = h('button', { type: 'button', class: 'fig-slot', title: label }, text);
    const take = (f: File | undefined) => {
      if (!f) return;
      box.classList.remove('bad');
      void api.upload(f).then((u) => {
        if (gone) return;
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(f);
        src = { kind: 'upload', id: u.inputId };
        box.replaceChildren(h('img', { src: url, alt: '' }), text);
        onChange();
      }).catch((e: Error) => { box.title = e.message; box.classList.add('bad'); });
    };
    box.addEventListener('click', () => file.click());
    file.addEventListener('change', () => { take(file.files?.[0]); file.value = ''; });
    box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('over'); });
    box.addEventListener('dragleave', () => box.classList.remove('over'));
    box.addEventListener('drop', (e) => { e.preventDefault(); box.classList.remove('over'); take(e.dataTransfer?.files[0]); });
    return {
      el: h('div', {}, box, file),
      get: () => src,
      label: (l: string) => { text.textContent = l; box.title = l; },
      dispose: () => { gone = true; if (url) URL.revokeObjectURL(url); },
    };
  }

  /** Erst Vorschau rechnen, dann speichern; Fehlversuche bleiben normale Galerie-Einträge. → plan_figurenblatt */
  function dialog(portrait: ImageSource, preview: string) {
    const name = h('input', { type: 'text', maxlength: 60, placeholder: t('fig.namePh') });
    const kind = h('select', {},
      h('option', { value: 'person' }, t('fig.person')), h('option', { value: 'creature' }, t('fig.creature')), h('option', { value: 'product' }, t('fig.product')));
    const way = h('select', {},
      h('option', { value: 'model' }, t('fig.wayModel')), h('option', { value: 'views' }, t('fig.wayViews')), h('option', { value: 'sheet' }, t('fig.waySheet')));
    const outfit = h('input', { type: 'text', maxlength: 200, placeholder: t('fig.outfitPh') });
    const outfitLbl = h('span', { class: 'lbl' }, t('fig.outfit'));
    const model = h('select', {}, ...editors.map((m) =>
      h('option', { value: m.id }, `${tx(m.name) ?? m.id} · ${commercialLabel(m)}${m.missing?.length ? ` – ${t('model.notInstalled')}` : ''}`)));
    // Personen und Kreaturen: Qwen hält die Gesichtszüge (gemessen, plan_modellhilfe); Produkte: FLUX, kommerziell nutzbar
    const pick = () => {
      const want = kind.value === 'product' ? ['flux3', 'qwen21'] : ['qwen21', 'flux3'];
      const ready = [...want.map((id) => editors.find((m) => m.id === id)), ...editors].find((m) => m && !m.missing?.length);
      if (ready) model.value = ready.id;
    };
    pick();

    const shot = h('div', { class: 'fig-shot' }, h('span', {}, t('fig.shotEmpty')));
    const err = h('p', { class: 'form-error' });
    const run = h('button', { type: 'button', class: 'button' }, t('fig.preview'));
    const save = h('button', { type: 'button', class: 'primary', disabled: true }, t('fig.save'));
    const cancel = h('button', { type: 'button', class: 'button ghost' }, t('lic.cancel'));
    let sheetId: string | null = null;
    let done = false;
    let ticket = 0;
    // Eine Vorschau gilt nur für die Eingaben, aus denen sie entstand; ticket verwirft Antworten auf ältere
    const stale = () => {
      ticket++;
      sheetId = null;
      done = false;
      save.disabled = true;
      run.textContent = t('fig.preview');
    };

    const extra = Array.from({ length: MAX_EXTRA_VIEWS }, (_, i) => slot(`${t('fig.extraOne')} ${i + 1}`, stale));
    const viewLabels = () => t(kind.value === 'creature' ? 'fig.viewsCreature' : kind.value === 'product' ? 'fig.viewsProduct' : 'fig.viewsPerson').split('|');
    const views = viewLabels().map((l) => slot(l, stale));
    const sheet = slot(t('fig.sheetSlot'), stale);
    // FLUX übernimmt Hautoberfläche und Eigenschaftswörter wörtlich, Blätter streuen stark (gemessen 23.11.2026)
    const fluxNote = h('p', { class: 'lic-note' }, t('fig.fluxHint'));
    const modelRows = h('div', {},
      h('label', {}, h('span', { class: 'lbl' }, t('model.label')), model), fluxNote,
      h('label', {}, outfitLbl, outfit),
      h('span', { class: 'lbl' }, t('fig.extra')), h('div', { class: 'fig-slots' }, ...extra.map((s) => s.el)));
    const viewRows = h('div', {}, h('p', { class: 'lic-note' }, t('fig.viewsHint')), h('div', { class: 'fig-slots' }, ...views.map((s) => s.el)));
    const sheetRows = h('div', {}, h('div', { class: 'fig-slots' }, sheet.el));
    const sync = () => {
      const k = kind.value;
      outfitLbl.textContent = t(k === 'person' ? 'fig.outfit' : 'fig.details');
      outfit.placeholder = t(k === 'person' ? 'fig.outfitPh' : 'fig.detailsPh');
      viewLabels().forEach((l, i) => views[i]?.label(l));
      modelRows.classList.toggle('hidden', way.value !== 'model');
      viewRows.classList.toggle('hidden', way.value !== 'views');
      sheetRows.classList.toggle('hidden', way.value !== 'sheet');
      fluxNote.classList.toggle('hidden', k !== 'person' || model.value !== 'flux3');
      stale();
    };
    kind.addEventListener('change', () => { pick(); sync(); });
    way.addEventListener('change', sync);
    model.addEventListener('change', sync);
    outfit.addEventListener('input', stale);

    const show = (g: Generation) => {
      if (g.id !== sheetId) return;
      if (g.status === 'done') {
        done = true;
        shot.replaceChildren(h('img', { src: imageUrl(g.id, 'preview'), alt: '' }));
        save.disabled = false;
      } else if (g.status === 'error' || g.status === 'cancelled') {
        shot.replaceChildren(h('span', {}, `${t('fig.failed')}${g.error ? `: ${g.error}` : ''}`));
      }
    };
    listener = (ev) => {
      if (ev.type === 'done') show(ev.generation);
      else if (ev.type === 'error' && ev.id === sheetId) shot.replaceChildren(h('span', {}, `${t('fig.failed')}: ${ev.error}`));
      else if (ev.type === 'status' && ev.status === 'cancelled' && ev.id === sheetId) shot.replaceChildren(h('span', {}, t('fig.failed')));
    };

    const dlg = h('dialog', { class: 'lic-dialog fig-dialog' },
      h('h3', {}, t('fig.createTitle')),
      h('p', { class: 'lic-note' }, t('fig.createHint')),
      h('img', { class: 'fig-preview', src: preview, alt: '' }),
      h('div', { class: 'fig-row' },
        h('label', {}, h('span', { class: 'lbl' }, t('fig.name')), name),
        h('label', {}, h('span', { class: 'lbl' }, t('fig.kind')), kind),
        h('label', {}, h('span', { class: 'lbl' }, t('fig.way')), way)),
      modelRows, viewRows, sheetRows, shot,
      err, h('div', { class: 'lic-actions' }, cancel, run, save));
    sync();
    const close = () => {
      listener = null;
      dlg.close();
      dlg.remove();
      for (const s of [...extra, ...views, sheet]) s.dispose();
      if (preview.startsWith('blob:')) URL.revokeObjectURL(preview);
    };
    cancel.addEventListener('click', close);
    dlg.addEventListener('cancel', close);

    run.addEventListener('click', () => {
      const m = editors.find((x) => x.id === model.value);
      if (!m?.modes.edit) return;
      const req: FigureSheetRequest = { kind: kind.value as FigureKind, portrait, workflow: m.modes.edit };
      if (way.value === 'model') {
        const more = extra.map((s) => s.get()).filter((s): s is ImageSource => !!s);
        if (more.length) req.extra = more;
        if (outfit.value.trim()) req.outfit = outfit.value.trim();
      } else if (way.value === 'views') {
        const all = views.map((s) => s.get());
        if (all.some((s) => !s)) return void (err.textContent = t('fig.viewsMissing'));
        req.views = all as ImageSource[];
      } else {
        const s = sheet.get();
        if (!s) return void (err.textContent = t('fig.sheetMissing'));
        req.sheet = s;
      }
      run.disabled = true;
      err.textContent = '';
      void (async () => {
        try {
          if (way.value === 'model' && !(await ensureLicense(m))) return;
          stale();
          const mine = ticket;
          shot.replaceChildren(h('span', {}, t('fig.busy')));
          const id = (await api.figureSheet(req)).sheetId;
          if (mine !== ticket) return void shot.replaceChildren(h('span', {}, t('fig.shotEmpty')));
          sheetId = id;
          run.textContent = t('fig.again');
          // Blätter aus Fotos sind fertig, bevor die Antwort da ist – ihr done-Ereignis kam schon vorher
          show(await api.generation(id));
        } catch (e) {
          err.textContent = (e as Error).message;
        } finally {
          run.disabled = false;
        }
      })();
    });

    save.addEventListener('click', () => {
      if (!name.value.trim()) return void name.focus();
      if (!sheetId || !done) return;
      save.disabled = true;
      err.textContent = '';
      void api.createFigure({ name: name.value.trim(), kind: kind.value as FigureKind, sheetId }).then(async (f) => {
        close();
        await load();
        onStarted(f.sheetId);
      }).catch((e: Error) => { err.textContent = e.message; save.disabled = false; });
    });
    document.body.append(dlg);
    dlg.showModal();
    name.focus();
  }

  return { el, count, load, onEvent, create };
}
