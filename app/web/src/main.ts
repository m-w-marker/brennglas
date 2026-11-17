import './styles.css';
import type { Generation, ModelInfo } from '@brennglas/shared';
import { api, subscribe } from './api.ts';
import { h } from './dom.ts';
import { lang, setLang, t } from './i18n.ts';
import { CUT_ID, cutView } from './views/cut.ts';
import { figures, type Figures } from './views/figures.ts';
import { gallery, type Gallery } from './views/gallery.ts';
import { inputPanel, type InputPanel } from './views/input-panel.ts';
import { queuePanel } from './views/queue-panel.ts';
import { resultView } from './views/result-view.ts';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('#app fehlt');

const comfyLabel = h('span', {}, 'ComfyUI');
const comfy = h('div', { class: 'comfy' }, h('span', { class: 'dot' }), comfyLabel);
function setComfy(on: boolean) {
  comfy.className = on ? 'comfy on' : 'comfy off';
  comfyLabel.textContent = t(on ? 'comfy.on' : 'comfy.off');
}

let badgeMap = new Map<string, string>();
let showGeneration: ((g: Generation) => void) | null = null;
const queue = queuePanel((wf) => badgeMap.get(wf) ?? wf, (g) => showGeneration?.(g));

const memory = h('span', { class: 'memory hidden', title: t('mem.title') });
const gb = (b: number) => (b / 1024 ** 3).toLocaleString(lang, { maximumFractionDigits: b < 10 * 1024 ** 3 ? 1 : 0 });
function pollMemory() {
  if (document.hidden) return;
  api.memory()
    .then((m) => {
      const part = (name: string, x: { used: number; total: number }) => `${name} ${gb(x.used)}/${gb(x.total)} GB`;
      memory.textContent = [m.vram ? part('VRAM', m.vram) : null, part('RAM', m.ram)].filter(Boolean).join(' · ');
      memory.classList.remove('hidden');
    })
    .catch(() => memory.classList.add('hidden'));
}
pollMemory();
setInterval(pollMemory, 5000);

const freeBtn = h('button', { type: 'button', class: 'top-btn', title: t('vram.title') }, t('vram.free'));
freeBtn.addEventListener('click', () => {
  freeBtn.disabled = true;
  freeBtn.textContent = t('vram.busy');
  api.freeVram()
    .then(() => { freeBtn.textContent = t('vram.done'); pollMemory(); })
    .catch(() => { freeBtn.textContent = t('vram.fail'); })
    .finally(() => setTimeout(() => { freeBtn.disabled = false; freeBtn.textContent = t('vram.free'); }, 3000));
});

/** Etikett je Workflow in der Galerie: Modell-Kürzel, bei Edit mit Zusatz. */
function badges(models: ModelInfo[]): Map<string, string> {
  // Schnitte aus mehreren Shots (POST /api/concat) haben keinen Workflow
  const map = new Map<string, string>([['concat', t('gal.concat')]]);
  for (const m of models) {
    for (const [mode, wf] of Object.entries(m.modes)) if (wf) map.set(wf, mode === 'edit' ? `${m.short} · ${t('mode.edit')}` : m.short);
  }
  return map;
}

function langSwitch(): HTMLElement {
  return h('div', { class: 'lang' }, ...(['de', 'en'] as const).map((l) =>
    h('button', { type: 'button', class: l === lang ? 'on' : '', onclick: () => { if (l !== lang) setLang(l); } }, l.toUpperCase())));
}

const topbar = h('header', { class: 'topbar' },
  h('div', { class: 'brand' }, 'BRENNGLAS', h('span', {}, t('brand.sub'))),
  h('div', { class: 'top-right' }, queue.el, memory, freeBtn, langSwitch(), comfy));

try {
  const [workflows, models] = await Promise.all([api.workflows(), api.models()]);
  if (workflows.length === 0) throw new Error(t('fatal.noWorkflows'));

  const videoWfs = new Set(workflows.filter((w) => w.kind === 'video').map((w) => w.name));
  let gal: Gallery | null = null;
  let input: InputPanel | null = null;
  let figs: Figures | null = null;
  // Schnittplatz: nur sichtbar, solange er im Modell-Menü gewählt ist; dann ersetzt er die Mitte
  let cutOn = false;
  const cut = cutView(() => gal?.setMarks(cutOn ? cut.marks() : new Map()));
  const toCut = (g: Generation, open = false) => {
    input?.openTool();
    if (open) cut.open(g);
    else cut.add(g);
  };
  const result = resultView({
    onChange: (id) => gal?.select(id),
    onContinue: (g) => input?.continueFrom(g, 'edit'),
    onRemix: (g) => input?.remix(g),
    onUpscale: models.some((m) => m.modes.upscale) ? (g) => input?.continueFrom(g, 'upscale') : undefined,
    onReference: workflows.some((w) => w.refs > 0) ? (g) => input?.addReference(g) : undefined,
    onFigure: models.some((m) => m.modes.edit && (workflows.find((w) => w.name === m.modes.edit)?.refs ?? 0) > 0) ? (g) => figs?.create(g) : undefined,
    onVideo: models.some((m) => m.modes.i2v) ? (g) => input?.continueFrom(g, 'i2v') : undefined,
    targetName: (g, md) => input?.targetName(g, md) ?? null,
    isVideo: (g) => videoWfs.has(g.workflow),
    onAddCut: (g) => toCut(g),
    onOpenCut: (g) => toCut(g, true),
  });
  badgeMap = badges(models);
  showGeneration = (g) => result.show(g);
  figs = figures(workflows, models, (g) => result.show(g), (id) => result.follow(id), (list) => input?.setFigures(list), (id) => input?.useFigure(id));
  // Im Schnitt legt ein Klick auf ein Video es hinein oder nimmt es heraus
  gal = gallery((g) => (cutOn ? g.video && cut.toggle(g) : result.show(g)), badgeMap, figs, (g) => toCut(g));
  const showCut = (on: boolean) => {
    cutOn = on;
    // Ausgeblendete Player verstummen, sonst läuft der Ton unsichtbar weiter
    (on ? result.el : cut.stage).querySelectorAll('video').forEach((v) => v.pause());
    result.el.classList.toggle('hidden', on);
    cut.stage.classList.toggle('hidden', !on);
    gal?.setMarks(on ? cut.marks() : new Map());
  };
  input = inputPanel(workflows, models, async (req, follow) => {
    const { id } = await api.generate(req);
    if (follow) result.follow(id);
  }, () => result.refreshActions(), {
    id: CUT_ID, label: t('cut.name'), group: t('group.tools'), section: cut.settings,
    submitLabel: t('cut.render'), busyLabel: t('cut.rendering'),
    enter: () => showCut(true), leave: () => showCut(false), submit: () => cut.render(),
  });

  root.replaceChildren(h('div', { class: 'app' }, topbar, h('main', { class: 'layout' }, input.el, result.el, cut.stage, gal.el)));
  subscribe((ev) => {
    if (ev.type === 'comfy') setComfy(ev.connected);
    if (ev.type === 'queue') queue.setCount(ev.remaining);
    queue.onEvent(ev);
    result.onEvent(ev);
    gal?.onEvent(ev);
    figs?.onEvent(ev);
  }, () => {
    void figs?.load();
    syncHealth();
    result.resync();
    gal?.resync();
  });
  const syncHealth = () => void api.health()
    .then((hl) => { setComfy(hl.comfy); queue.setCount(hl.queueRunning + hl.queuePending); })
    .catch(() => setComfy(false));
  syncHealth();
  await Promise.all([gal.load(), figs.load()]);
  // Nach dem Neuladen gleich dem laufenden Job folgen, sonst fehlt der Abbrechen-Knopf
  const open = (await api.generations(null, {}, 20).catch(() => null))?.items.find((g) => g.status === 'queued' || g.status === 'running');
  if (open && !result.current()) result.show(open);
} catch (e) {
  root.replaceChildren(h('p', { class: 'fatal' }, t('fatal.backend', { msg: (e as Error).message })));
}
