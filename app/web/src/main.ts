import './styles.css';
import type { Generation, ModelInfo } from '@brennglas/shared';
import { api, subscribe } from './api.ts';
import { h } from './dom.ts';
import { lang, setLang, t } from './i18n.ts';
import { openClaudeHelp } from './views/claude-help.ts';
import { cutView } from './views/cut.ts';
import { figures, type Figures } from './views/figures.ts';
import { gallery, type Gallery } from './views/gallery.ts';
import { imageEditView } from './views/image-edit.ts';
import { inputPanel, type InputPanel, type Tool } from './views/input-panel.ts';
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
      memory.textContent = [typeof m.gpu === 'number' ? `GPU ${m.gpu} %` : null, m.vram ? part('VRAM', m.vram) : null, part('RAM', m.ram)].filter(Boolean).join(' · ');
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
  const map = new Map<string, string>([['concat', t('gal.concat')], ['imageedit', t('gal.imageedit')]]);
  for (const m of models) {
    for (const [mode, wf] of Object.entries(m.modes)) if (wf) map.set(wf, mode === 'edit' ? `${m.short} · ${t('mode.edit')}` : m.short);
  }
  return map;
}

function langSwitch(): HTMLElement {
  return h('div', { class: 'lang' }, ...(['de', 'en'] as const).map((l) =>
    h('button', { type: 'button', class: l === lang ? 'on' : '', onclick: () => { if (l !== lang) setLang(l); } }, l.toUpperCase())));
}

const VIEW = 'brennglas.view';
const storedView = () => {
  try {
    return localStorage.getItem(VIEW);
  } catch {
    return null;
  }
};
const genTab =h('button', { type: 'button', class: 'view-tab on' }, t('view.generate'));
const cutTab = h('button', { type: 'button', class: 'view-tab' }, t('cut.name'));
const imgTab = h('button', { type: 'button', class: 'view-tab' }, t('ie.name'));
const topbar = h('header', { class: 'topbar' },
  h('div', { class: 'top-left' }, h('div', { class: 'brand' }, 'BRENNGLAS', h('span', {}, t('brand.sub'))),
    h('nav', { class: 'view-tabs' }, genTab, cutTab, imgTab)),
  h('div', { class: 'top-right' }, queue.el, memory, freeBtn,
    h('button', { type: 'button', class: 'top-btn', onclick: openClaudeHelp }, t('claude.button')), langSwitch(), comfy));

// Mit pnpm dev kann die Oberfläche vor dem Backend da sein: sichtbar warten statt gleich Fehlerseite
const startData = async () => {
  for (let s = 1; ; s++) {
    try {
      return await Promise.all([api.workflows(), api.models()]);
    } catch (e) {
      if (s > 15) throw e;
      root.replaceChildren(h('p', { class: 'start-wait' }, t('start.wait', { s })));
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
};

try {
  const [workflows, models] = await startData();
  if (workflows.length === 0) throw new Error(t('fatal.noWorkflows'));

  const videoWfs = new Set(workflows.filter((w) => w.kind === 'video').map((w) => w.name));
  let gal: Gallery | null = null;
  let input: InputPanel | null = null;
  let figs: Figures | null = null;
  // Schnitt und Bildbearbeitung: nur sichtbar, solange ihr Reiter gewählt ist; dann ersetzen sie die Mitte
  type View = 'generate' | 'cut' | 'image';
  let view: View = 'generate';
  const cut = cutView(() => gal?.setMarks(view === 'cut' ? cut.marks() : new Map()));
  const edit = imageEditView((g) => input?.continueFrom(g, 'edit'));
  const tools: Record<'cut' | 'image', Tool> = {
    cut: {
      section: cut.settings, submitLabel: t('cut.render'), busyLabel: t('cut.rendering'),
      enter: () => showView('cut'), leave: () => showView('generate'), submit: () => cut.render(),
    },
    image: {
      section: edit.settings, submitLabel: t('ie.save'), busyLabel: t('ie.saving'),
      enter: () => { showView('image'); edit.enter(); }, leave: () => { edit.leave(); showView('generate'); }, submit: async () => { await edit.save(); },
    },
  };
  const toCut = (g: Generation, open = false) => {
    input?.openTool(tools.cut);
    if (open) cut.open(g);
    else cut.add(g);
  };
  const toEdit = (g: Generation) => {
    input?.openTool(tools.image);
    if (g.workflow === 'imageedit') edit.open(g);
    else edit.add(g);
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
    onImageEdit: toEdit,
  });
  badgeMap = badges(models);
  showGeneration = (g) => result.show(g);
  figs = figures(workflows, models, (g) => result.show(g), (id) => result.follow(id), (list) => input?.setFigures(list), (id) => input?.useFigure(id));
  // Im Schnitt legt ein Klick auf ein Video es hinein oder nimmt es heraus
  // Video = Filmmodi, Video-Upscale und Schnitt; alles andere zeigt der Filter als Bild
  const isWf = (w: string | undefined): w is string => !!w;
  const groups = {
    video: [...new Set([...models.flatMap((m) => [m.modes.t2v, m.modes.i2v, m.modes.flf2v, m.modes.l2v]).filter(isWf), ...videoWfs, 'concat'])],
    models: [...models.map((m) => ({ id: m.id, label: m.short, workflows: Object.values(m.modes).filter(isWf) })),
      { id: 'concat', label: t('gal.concat'), workflows: ['concat'] }, { id: 'imageedit', label: t('gal.imageedit'), workflows: ['imageedit'] }],
  };
  gal = gallery((g) => {
    if (view === 'cut') return void (g.video && cut.toggle(g));
    if (view === 'image') return edit.add(g);
    result.show(g);
  }, badgeMap, figs, (g) => toCut(g), groups);
  function showView(v: View) {
    view = v;
    const stages: [View, HTMLElement, HTMLElement][] = [['generate', result.el, genTab], ['cut', cut.stage, cutTab], ['image', edit.stage, imgTab]];
    for (const [k, el, tab] of stages) {
      // Ausgeblendete Player verstummen, sonst läuft der Ton unsichtbar weiter
      if (k !== v) el.querySelectorAll('video').forEach((x) => x.pause());
      el.classList.toggle('hidden', k !== v);
      tab.classList.toggle('on', k === v);
    }
    gal?.setMarks(v === 'cut' ? cut.marks() : new Map());
    try {
      localStorage.setItem(VIEW, v);
    } catch {
      // nur Bequemlichkeit
    }
  }
  genTab.addEventListener('click', () => input?.closeTool());
  cutTab.addEventListener('click', () => input?.openTool(tools.cut));
  imgTab.addEventListener('click', () => input?.openTool(tools.image));
  input = inputPanel(workflows, models, async (req, follow) => {
    const { id } = await api.generate(req);
    if (follow) result.follow(id);
  }, () => result.refreshActions(), [tools.cut, tools.image]);
  const stored = storedView();
  if (stored === 'cut' || stored === 'image') input.openTool(tools[stored]);

  root.replaceChildren(h('div', { class: 'app' }, topbar, h('main', { class: 'layout' }, input.el, result.el, cut.stage, edit.stage, gal.el)));
  subscribe((ev) => {
    if (ev.type === 'comfy') setComfy(ev.connected);
    // Startete ComfyUI nach der Seite, war „Dateien vorhanden?" noch unbekannt
    if (ev.type === 'comfy' && ev.connected) void api.models().then((list) => input?.setModels(list), () => {});
    if (ev.type === 'queue') queue.setCount(ev.remaining);
    queue.onEvent(ev);
    result.onEvent(ev);
    gal?.onEvent(ev);
    figs?.onEvent(ev);
    if (ev.type === 'done') input?.refreshTimes();
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
