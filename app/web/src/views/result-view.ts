import type { Generation, Mode, SseEvent } from '@brennglas/shared';
import { api, imageUrl, videoUrl } from '../api.ts';
import { copyText, h } from '../dom.ts';
import { lang, t } from '../i18n.ts';
import { clock, eta, type Tick } from '../progress.ts';
import { viewer } from './viewer.ts';

const STAGES: Record<string, Parameters<typeof t>[0]> = {
  TextGenerateV2: 'stage.expand',
  TextGenerate: 'stage.expand',
  TextGenerateLTX2Prompt: 'stage.expand',
  TextEncodeQwenImage21: 'stage.encode',
  KSamplerAdvanced: 'stage.render',
  LTXVLatentUpsampler: 'stage.upscale',
  LTXVAudioVAEDecode: 'stage.audio',
  CreateVideo: 'stage.saveVideo',
  SaveVideo: 'stage.saveVideo',
  LTXVPreprocess: 'stage.image',
  LTXVImgToVideoInplace: 'stage.image',
  LTXVAddGuide: 'stage.image',
  WanCameraImageToVideo: 'stage.image',
  VAEEncodeTiled: 'stage.image',
  LatentUpscaleModelLoader: 'stage.load',
  CLIPTextEncode: 'stage.encode',
  MiniMaxH3ImageConditioning: 'stage.encode',
  KSampler: 'stage.render',
  SamplerCustomAdvanced: 'stage.render',
  VAEDecode: 'stage.decode',
  VAEDecodeTiled: 'stage.decode',
  SaveImage: 'stage.save',
  UNETLoader: 'stage.load',
  CLIPLoader: 'stage.load',
  VAELoader: 'stage.load',
};
const SLOW_MS = 60_000;

export interface ResultView {
  el: HTMLElement;
  current(): string | null;
  follow(id: string): void;
  show(g: Generation): void;
  onEvent(ev: SseEvent): void;
  /** Knöpfe neu beschriften, z. B. nach einem Modellwechsel im Formular. */
  refreshActions(): void;
  /** Nach SSE-Wiederverbindung: verpasstes Ende des verfolgten Jobs nachholen. */
  resync(): void;
}

interface Callbacks {
  onChange(id: string | null): void;
  onContinue(g: Generation): void;
  onRemix(g: Generation): void;
  /** Fehlt, wenn kein Upscale-Workflow geladen ist. */
  onUpscale?: (g: Generation) => void;
  /** Fehlt, wenn kein Workflow Referenzbilder nimmt. */
  onReference?: (g: Generation) => void;
  /** Kurzname des Zielmodells für einen Knopf, null = ohne Zusatz. */
  targetName?: (g: Generation | null, mode: Mode) => string | null;
  /** Fehlt, wenn kein Modell mit Referenzbildern bearbeiten kann. */
  onFigure?: (g: Generation) => void;
  /** Fehlt, wenn kein Modell Bild → Video kann. */
  onVideo?: (g: Generation) => void;
  /** Video-Shots: Ergebnis liegt im Zielordner, die Vorschau ist nur der letzte Frame. */
  isVideo?: (g: Generation) => boolean;
  /** Schnittplatz: Video hineinlegen, fertigen Schnitt wieder öffnen. */
  onAddCut?: (g: Generation) => void;
  onOpenCut?: (g: Generation) => void;
}

export function resultView({ onChange, onContinue, onRemix, onUpscale, onReference, onFigure, onVideo, targetName, isVideo, onAddCut, onOpenCut }: Callbacks): ResultView {
  let current: string | null = null;
  let shown: Generation | null = null;
  let lastEventAt = 0;

  const status = h('div', { class: 'status' }, t('res.idle'));
  const bar = h('div', { class: 'bar' });
  const progress = h('div', { class: 'progress hidden' }, bar);
  const hint = h('p', { class: 'hint hidden' }, t('res.slow'));
  const view = viewer();
  const live = h('img', { class: 'live hidden', alt: '' });
  /** Das Zwischenbild steht an der Stelle des Betrachters, solange der Job läuft. */
  function setLive(url: string | null) {
    live.classList.toggle('hidden', !url);
    if (url) live.src = url;
    else live.removeAttribute('src');
    view.el.classList.toggle('hidden', !!url || !player.classList.contains('hidden'));
  }
  const hideLive = () => setLive(null);
  const player = h('video', { class: 'player hidden', controls: true, loop: true, playsinline: true, preload: 'metadata' });
  /** Ein Video-Ergebnis zeigt den Player statt des Bildbetrachters. */
  function setPlayer(g: Generation | null) {
    const on = !!g?.video;
    player.classList.toggle('hidden', !on);
    view.el.classList.toggle('hidden', on);
    if (on && g) {
      player.poster = imageUrl(g.id, 'preview');
      player.src = videoUrl(g.id);
    } else if (player.getAttribute('src')) {
      player.pause();
      player.removeAttribute('src');
      player.load();
    }
  }
  const caption = h('details', { class: 'caption hidden', open: true });
  const meta = h('div', { class: 'meta' });
  const actions = h('div', { class: 'actions' });
  const chain = h('div', { class: 'chain hidden' });

  setInterval(() => {
    const waiting = current !== null && !progress.classList.contains('hidden');
    hint.classList.toggle('hidden', !(waiting && Date.now() - lastEventAt > SLOW_MS));
  }, 5000);
  // Laufende Uhr seit dem letzten Lebenszeichen: zeigt in Phasen ohne Prozente, dass es weitergeht
  let base = '';
  let ticking = false;
  let first: (Tick & { pass: number | undefined }) | null = null;
  setInterval(() => {
    if (!ticking || progress.classList.contains('hidden')) return;
    const since = Date.now() - lastEventAt;
    status.textContent = since >= 3000 ? `${base} · ${clock(since)}` : base;
  }, 1000);

  function setCurrent(id: string | null) {
    if (shown?.id !== id) shown = null;
    current = id;
    onChange(id);
  }

  function setProgress(value: number, max: number, determinate: boolean) {
    progress.classList.remove('hidden');
    progress.classList.toggle('indeterminate', !determinate);
    bar.style.width = determinate && max > 0 ? `${Math.round((value / max) * 100)}%` : '';
  }

  function follow(id: string) {
    setCurrent(id);
    setPlayer(null);
    lastEventAt = Date.now();
    status.textContent = base = t('res.queued');
    ticking = true;
    first = null;
    status.className = 'status';
    setProgress(0, 0, false);
    hideLive();
    view.clear();
    caption.classList.add('hidden');
    meta.textContent = '';
    const cancel = h('button', { type: 'button', class: 'button ghost danger' }, t('res.cancel'));
    cancel.addEventListener('click', () => {
      cancel.disabled = true;
      api.cancel(id).catch((e: Error) => { status.textContent = base = t('res.cancelFail', { msg: e.message }); cancel.disabled = false; });
    });
    actions.replaceChildren(cancel);
    chain.classList.add('hidden');
    // Ein schneller Job kann fertig sein, bevor follow() läuft – seine Meldungen gingen dann ins Leere
    catchUp(id);
  }

  function catchUp(id: string) {
    void api.generation(id).then((g) => {
      const waiting = current === id && !progress.classList.contains('hidden');
      if (waiting && g.status !== 'queued' && g.status !== 'running') show(g);
    }).catch(() => {});
  }

  function promptBlock(head: string | null, text: string): HTMLElement {
    const copy = h('button', { type: 'button', class: 'copy', title: t('res.copy') }, t('res.copy'));
    copy.addEventListener('click', () => void copyText(text).then((ok) => {
      copy.textContent = ok ? t('res.copied') : t('res.copyFail');
      setTimeout(() => { copy.textContent = t('res.copy'); }, 1500);
    }));
    return h('div', { class: 'cap-block' }, h('div', { class: 'cap-head' }, head ? h('span', {}, head) : null, copy), h('p', {}, text));
  }

  function starButton(g: Generation): HTMLButtonElement {
    const b = h('button', { type: 'button', class: g.favorite ? 'button ghost star on' : 'button ghost star', title: t('res.favorite') }, g.favorite ? '★' : '☆');
    b.addEventListener('click', () => void api.favorite(g.id, !g.favorite).catch(() => {}));
    return b;
  }

  async function loadChain(g: Generation) {
    if (!g.parentId) return chain.classList.add('hidden');
    const list = await api.chain(g.id).catch(() => [] as Generation[]);
    if (current !== g.id || list.length < 2) return;
    chain.replaceChildren(h('span', { class: 'lbl' }, t('res.chain', { n: list.length })), ...list.map((c, i) =>
      h('button', { type: 'button', class: c.id === g.id ? 'link on' : 'link', title: c.prompt, onclick: () => show(c) },
        h('img', { src: imageUrl(c.id, 'thumb'), alt: '' }), h('small', {}, String(i)))));
    chain.classList.remove('hidden');
  }

  function show(g: Generation) {
    setCurrent(g.id);
    shown = g;
    progress.classList.add('hidden');
    hint.classList.add('hidden');
    if (g.status === 'queued' || g.status === 'running') return follow(g.id);
    hideLive();
    if (g.status !== 'done') {
      setPlayer(null);
      status.textContent = g.status === 'cancelled' ? t('res.cancelled') : t('res.error', { msg: g.error ?? t('res.unknown') });
      status.className = 'status err';
      view.clear();
      caption.classList.add('hidden');
      meta.textContent = g.prompt;
      actions.replaceChildren(h('button', { type: 'button', class: 'button ghost', onclick: () => onRemix(g) }, t('res.remix')));
      chain.classList.add('hidden');
      return;
    }
    status.className = 'status';
    setPlayer(g);
    // Der Prompt steht unten mit Kopieren-Knopf; oben nur, was sonst nirgends steht
    status.textContent = isVideo?.(g) ? t('res.videoDone') : g.prompt ? '' : t('res.upscaled', { w: g.width ?? 0, h: g.height ?? 0 });
    if (!g.video) {
      view.setImage(imageUrl(g.id, 'preview'), imageUrl(g.id, 'full'), g.width ?? 0, g.height ?? 0,
        g.hasInput ? imageUrl(g.id, 'input') : undefined);
    }
    void loadChain(g);
    // Ohne Erweiterung liefert der Workflow den Prompt unverändert zurück – dann nur ein Block
    const expanded = g.expandedPrompt && g.expandedPrompt.trim() !== g.prompt.trim() ? g.expandedPrompt : null;
    caption.replaceChildren(h('summary', {}, t('res.prompt')),
      promptBlock(expanded ? t('res.original') : null, g.prompt),
      ...(expanded ? [promptBlock(t('res.expanded'), expanded)] : []));
    caption.classList.toggle('hidden', !g.prompt);
    const secs = g.durationMs ? `${Math.round(g.durationMs / 1000)} s` : '';
    meta.textContent = [`${g.width ?? 0}×${g.height ?? 0}`, g.params.seed === undefined ? '' : `seed ${String(g.params.seed)}`, secs].filter(Boolean).join('   ·   ');
    renderActions(g);
  }

  /** Ziel steht im Knopf, damit „Weiter bearbeiten“ nicht still bei einem anderen Modell landet. */
  function renderActions(g: Generation) {
    const to = (text: string, md: Mode, from: Generation | null = g) => {
      const name = targetName?.(from, md);
      return name ? [text, h('small', { class: 'to' }, ` · ${name}`)] : [text];
    };
    if (g.video) {
      const ext = g.params.format === 'webm' ? 'webm' : 'mp4';
      // Ein Schnitt hat keinen Workflow zum Remixen, er öffnet sich im Schnittplatz
      const again = g.workflow === 'concat' && onOpenCut
        ? h('button', { type: 'button', class: 'button ghost', onclick: () => onOpenCut(g) }, t('cut.openIn'))
        : h('button', { type: 'button', class: 'button ghost', title: t('res.remixTitle'), onclick: () => onRemix(g) }, t('res.remix'));
      return actions.replaceChildren(starButton(g), again,
        ...(onAddCut ? [h('button', { type: 'button', class: 'button ghost', onclick: () => onAddCut(g) }, t('cut.addTo'))] : []),
        h('a', { class: 'button', href: videoUrl(g.id), download: `brennglas-${g.id.slice(0, 8)}.${ext}` }, t('res.downloadVideo', { fmt: ext.toUpperCase() })));
    }
    if (isVideo?.(g)) {
      return actions.replaceChildren(starButton(g),
        h('button', { type: 'button', class: 'button ghost', title: t('res.remixTitle'), onclick: () => onRemix(g) }, t('res.remix')),
        h('button', { type: 'button', class: 'button', onclick: () => void api.openFolder(g.id).catch(() => {}) }, t('res.openTarget')));
    }
    actions.replaceChildren(
      starButton(g),
      h('button', { type: 'button', class: 'button ghost', title: t('res.remixTitle'), onclick: () => onRemix(g) }, t('res.remix')),
      h('button', { type: 'button', class: 'button ghost', onclick: () => onContinue(g) }, ...to(t('res.continue'), 'edit')),
      ...(onReference ? [h('button', { type: 'button', class: 'button ghost', title: t('res.asRefTitle'), onclick: () => onReference(g) }, ...to(t('res.asRef'), 'edit', null))] : []),
      ...(onFigure ? [h('button', { type: 'button', class: 'button ghost', title: t('fig.asTitle'), onclick: () => onFigure(g) }, t('fig.as'))] : []),
      ...(onUpscale ? [h('button', { type: 'button', class: 'button ghost', onclick: () => onUpscale(g) }, t('res.upscale'))] : []),
      ...(onVideo ? [h('button', { type: 'button', class: 'button ghost', title: t('res.toVideoTitle'), onclick: () => onVideo(g) }, ...to(t('res.toVideo'), 'i2v'))] : []),
      h('a', { class: 'button', href: imageUrl(g.id, 'full'), download: `brennglas-${g.id.slice(0, 8)}.png` }, t('res.download')),
    );
  }

  function refreshActions() {
    if (shown?.status === 'done' && current === shown.id) renderActions(shown);
  }

  function onEvent(ev: SseEvent) {
    const id = ev.type === 'done' ? ev.generation.id : 'id' in ev ? ev.id : null;
    if (!id || id !== current) return;
    if (ev.type === 'deleted') {
      setCurrent(null);
      setPlayer(null);
      hideLive();
      shown = null;
      progress.classList.add('hidden');
      view.clear();
      caption.classList.add('hidden');
      meta.textContent = '';
      actions.replaceChildren();
      chain.classList.add('hidden');
      status.className = 'status';
      status.textContent = t('res.deleted');
      return;
    }
    if (ev.type === 'favorite') {
      // Nur die Knöpfe, ein volles show() setzte Zoom und Vergleich zurück
      if (shown?.status === 'done') renderActions(shown = { ...shown, favorite: ev.favorite });
      return;
    }
    lastEventAt = Date.now();
    if (ev.type === 'preview') {
      setLive(ev.url);
      return;
    }
    if ((ev.type === 'status' && ev.status === 'cancelled') || ev.type === 'error') hideLive();
    if (ev.type === 'status' && ev.status === 'running') status.textContent = base = t('res.running');
    if (ev.type === 'status' && ev.status === 'cancelled') {
      progress.classList.add('hidden');
      status.textContent = t('res.cancelled');
      status.className = 'status err';
      actions.replaceChildren();
    }
    if (ev.type === 'progress') {
      const stage = ev.stage ? STAGES[ev.stage] : undefined;
      const label = t(stage ?? 'stage.prepare');
      const pass = ev.passes ? ` · ${t('res.pass', { v: ev.pass ?? 1, max: ev.passes })}` : '';
      ticking = true;
      // TextGenerate meldet Tokens bis zum Maximum 8192, endet aber weit davor – kein echter Balken.
      if (ev.stage === 'video') {
        base = t('res.frames', { v: ev.value, max: ev.max });
        setProgress(ev.value, ev.max, true);
      } else if (ev.stage === 'encode') {
        base = `${t('res.encoding')} …`;
        setProgress(0, 0, false);
      } else if (stage === 'stage.render' && ev.max > 0 && ev.value > 0) {
        const now = { t: Date.now(), v: ev.value };
        if (!first || first.pass !== ev.pass || ev.value < first.v) first = { ...now, pass: ev.pass };
        const e = eta(first, now, ev.max);
        const rate = e ? ` · ${t('res.eta', { s: (e.perStep / 1000).toLocaleString(lang, { maximumFractionDigits: e.perStep < 10_000 ? 1 : 0 }), left: clock(e.left) })}` : '';
        base = `${label}${pass} — ${t('res.step', { v: ev.value, max: ev.max })}${rate}`;
        setProgress(ev.value, ev.max, true);
      } else if (stage === 'stage.render') {
        // Vor dem ersten Schritt lädt ComfyUI das Modell – oft der längste stille Abschnitt
        base = `${label}${pass} — ${t('stage.loadModel')} …`;
        setProgress(0, 0, false);
      } else {
        base = (ev.stage === 'TextGenerateV2' || ev.stage === 'TextGenerate') && ev.value > 0 ? `${label} — ${t('res.tokens', { n: ev.value })}` : `${label} …`;
        setProgress(0, 0, false);
      }
      status.textContent = base;
    }
    if (ev.type === 'done') show(ev.generation);
    if (ev.type === 'error') {
      actions.replaceChildren();
      progress.classList.add('hidden');
      status.textContent = t('res.error', { msg: ev.error });
      status.className = 'status err';
    }
  }

  const el = h('section', { class: 'panel result' },
    status, progress, hint, live, view.el, player, h('div', { class: 'footer' }, caption, meta, actions), chain);
  return { el, current: () => current, follow, show, onEvent, refreshActions, resync: () => { if (current) catchUp(current); } };
}
