import type { Figure, FigureKind, Generation, ImageSource, ModelInfo, SseEvent, WorkflowInfo } from '@brennglas/shared';
import { api, imageUrl, refUrl } from '../api.ts';
import { h } from '../dom.ts';
import { t } from '../i18n.ts';
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
    list.replaceChildren(...all.map(card), add);
    onList(all);
    count.textContent = String(all.length);
    empty.classList.toggle('hidden', all.length > 0);
  }

  function onEvent(ev: SseEvent) {
    // Nur Endzustände; done auch für unbekannte Blätter, sonst fehlen per MCP angelegte Figuren
    if (ev.type === 'done') void load();
    else if ((ev.type === 'error' || ev.type === 'status') && all.some((f) => f.sheetId === ev.id)) void load();
  }

  function create(g: Generation) {
    dialog({ kind: 'output', id: g.id }, imageUrl(g.id, 'thumb'));
  }

  function dialog(portrait: ImageSource, preview: string) {
    const name = h('input', { type: 'text', maxlength: 60, placeholder: t('fig.namePh') });
    const kind = h('select', {}, h('option', { value: 'person' }, t('fig.person')), h('option', { value: 'product' }, t('fig.product')));
    const outfit = h('input', { type: 'text', maxlength: 200, placeholder: t('fig.outfitPh') });
    const outfitLbl = h('span', { class: 'lbl' }, t('fig.outfit'));
    const outfitRow = h('label', {}, outfitLbl, outfit);
    kind.addEventListener('change', () => {
      const person = kind.value === 'person';
      outfitLbl.textContent = t(person ? 'fig.outfit' : 'fig.details');
      outfit.placeholder = t(person ? 'fig.outfitPh' : 'fig.detailsPh');
    });
    const model = h('select', {}, ...editors.map((m) =>
      h('option', { value: m.id }, `${m.name} · ${commercialLabel(m)}${m.missing?.length ? ` – ${t('model.notInstalled')}` : ''}`)));
    // Personen: Qwen hält die Gesichtszüge (gemessen, plan_modellhilfe); Produkte: FLUX, kommerziell nutzbar
    const pick = () => {
      const want = kind.value === 'person' ? ['qwen21', 'flux3'] : ['flux3', 'qwen21'];
      const ready = [...want.map((id) => editors.find((m) => m.id === id)), ...editors].find((m) => m && !m.missing?.length);
      if (ready) model.value = ready.id;
    };
    pick();
    kind.addEventListener('change', pick);
    const err = h('p', { class: 'form-error' });
    const ok = h('button', { type: 'button', class: 'primary' }, t('fig.start'));
    const cancel = h('button', { type: 'button', class: 'button ghost' }, t('lic.cancel'));
    const dlg = h('dialog', { class: 'lic-dialog fig-dialog' },
      h('h3', {}, t('fig.createTitle')),
      h('p', { class: 'lic-note' }, t('fig.createHint')),
      h('img', { class: 'fig-preview', src: preview, alt: '' }),
      h('label', {}, h('span', { class: 'lbl' }, t('fig.name')), name),
      h('label', {}, h('span', { class: 'lbl' }, t('fig.kind')), kind),
      outfitRow,
      h('label', {}, h('span', { class: 'lbl' }, t('model.label')), model),
      err, h('div', { class: 'lic-actions' }, cancel, ok));
    const close = () => { dlg.close(); dlg.remove(); if (preview.startsWith('blob:')) URL.revokeObjectURL(preview); };
    cancel.addEventListener('click', close);
    dlg.addEventListener('cancel', close);
    ok.addEventListener('click', () => {
      const m = editors.find((x) => x.id === model.value);
      if (!name.value.trim()) return void name.focus();
      if (!m?.modes.edit) return;
      ok.disabled = true;
      err.textContent = '';
      void (async () => {
        try {
          if (!(await ensureLicense(m))) return;
          const f = await api.createFigure({
            name: name.value.trim(), kind: kind.value as FigureKind, portrait, workflow: m.modes.edit ?? '',
            ...(outfit.value.trim() ? { outfit: outfit.value.trim() } : {}),
          });
          close();
          await load();
          onStarted(f.sheetId);
        } catch (e) {
          err.textContent = (e as Error).message;
        } finally {
          ok.disabled = false;
        }
      })();
    });
    document.body.append(dlg);
    dlg.showModal();
    name.focus();
  }

  return { el, count, load, onEvent, create };
}
