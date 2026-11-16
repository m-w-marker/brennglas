import './styles.css';
import type { Generation, ModelInfo } from '@brennglas/shared';
import { api, subscribe } from './api.ts';
import { h } from './dom.ts';
import { lang, setLang, t } from './i18n.ts';
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
    for (const [mode, wf] of Object.entries(m.modes)) if (wf) map.set(wf, mode === 'edit' ? `${m.short} · Edit` : m.short);
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
  const result = resultView({
    onChange: (id) => gal?.select(id),
    onContinue: (g) => input?.continueFrom(g, 'edit'),
    onRemix: (g) => input?.remix(g),
    onUpscale: models.some((m) => m.modes.upscale) ? (g) => input?.continueFrom(g, 'upscale') : undefined,
    onReference: workflows.some((w) => w.refs > 0) ? (g) => input?.addReference(g) : undefined,
    onVideo: models.some((m) => m.modes.i2v) ? (g) => input?.continueFrom(g, 'i2v') : undefined,
    targetName: (g, md) => input?.targetName(g, md) ?? null,
    isVideo: (g) => videoWfs.has(g.workflow),
  });
  badgeMap = badges(models);
  showGeneration = (g) => result.show(g);
  gal = gallery((g) => result.show(g), badgeMap);
  input = inputPanel(workflows, models, async (req, follow) => {
    const { id } = await api.generate(req);
    if (follow) result.follow(id);
  }, () => result.refreshActions());

  root.replaceChildren(h('div', { class: 'app' }, topbar, h('main', { class: 'layout' }, input.el, result.el, gal.el)));
  subscribe((ev) => {
    if (ev.type === 'comfy') setComfy(ev.connected);
    if (ev.type === 'queue') queue.setCount(ev.remaining);
    queue.onEvent(ev);
    result.onEvent(ev);
    gal?.onEvent(ev);
  });
  void api.health()
    .then((hl) => { setComfy(hl.comfy); queue.setCount(hl.queueRunning + hl.queuePending); })
    .catch(() => setComfy(false));
  await gal.load();
  // Nach dem Neuladen gleich dem laufenden Job folgen, sonst fehlt der Abbrechen-Knopf
  const open = (await api.generations(null, {}, 20).catch(() => null))?.items.find((g) => g.status === 'queued' || g.status === 'running');
  if (open && !result.current()) result.show(open);
} catch (e) {
  root.replaceChildren(h('p', { class: 'fatal' }, t('fatal.backend', { msg: (e as Error).message })));
}
