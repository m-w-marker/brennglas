import type { Generation, ParamValue } from '@brennglas/shared';
import { api, GEN_DRAG, imageUrl, videoUrl } from '../api.ts';
import { h } from '../dom.ts';
import { lang, t } from '../i18n.ts';

/** Schnittplatz → plan_schnitt: links die Einstellungen, in der Mitte Player, Prüfbereich und Filmstreifen. */
export const CUT_ID = '__cut';
const STORE = 'brennglas.cut';
const KINDS = ['cut', 'fade', 'fadeblack', 'fadewhite', 'wipeleft', 'slideleft'] as const;
type Kind = (typeof KINDS)[number];
const KIND_KEY = {
  cut: 'cut.kind.cut', fade: 'cut.kind.fade', fadeblack: 'cut.kind.fadeblack', fadewhite: 'cut.kind.fadewhite', wipeleft: 'cut.kind.wipeleft', slideleft: 'cut.kind.slideleft',
} as const;
const SPEEDS = [0.5, 0.75, 1, 1.5, 2];
const FADES = [0, 0.5, 1, 2];
const CORNERS = ['tl', 'tr', 'bl', 'br'] as const;
type Corner = (typeof CORNERS)[number];
const CORNER_KEY = { tl: 'cut.pos.tl', tr: 'cut.pos.tr', bl: 'cut.pos.bl', br: 'cut.pos.br' } as const;

interface Shot { id: string; duration: number | null; start: number; end: number | null; speed: number }
interface Trans { kind: Kind; duration: number }
interface State {
  shots: Shot[];
  /** joins[i] liegt zwischen shots[i] und shots[i + 1]. */
  joins: Trans[];
  /** Vorgabe für neue Übergänge und den Übergang zur Endkarte. */
  def: Trans;
  fadeIn: number;
  fadeOut: number;
  music: { path: string; name: string } | null;
  musicVolume: number;
  shotVolume: number;
  logo: string | null;
  logoPosition: Corner;
  logoScale: number;
  endcard: string | null;
  endcardSeconds: number;
  format: 'mp4' | 'webm';
}

const fresh = (): State => ({
  shots: [], joins: [], def: { kind: 'fade', duration: 0.5 }, fadeIn: 0, fadeOut: 0, music: null, musicVolume: 0.8, shotVolume: 0.35,
  logo: null, logoPosition: 'br', logoScale: 0.12, endcard: null, endcardSeconds: 2, format: 'mp4',
});

/** Fremde Daten aus dem Speicher: jedes Feld prüfen, sonst Vorgabe – ein alter Stand darf die App nie am Start hindern. */
function sane(raw: unknown): State {
  const f = fresh();
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, d: number, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d);
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const trans = (v: unknown, d: Trans): Trans => {
    const j = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    return { kind: KINDS.includes(j.kind as Kind) ? (j.kind as Kind) : d.kind, duration: num(j.duration, d.duration, 0.1, 2) };
  };
  const shots = (Array.isArray(o.shots) ? o.shots : []).flatMap((x): Shot[] => {
    const s = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    if (typeof s.id !== 'string') return [];
    const duration = typeof s.duration === 'number' && s.duration > 0 ? s.duration : null;
    return [{ id: s.id, duration, start: num(s.start, 0, 0, 1e6), end: typeof s.end === 'number' ? s.end : null, speed: SPEEDS.includes(s.speed as number) ? (s.speed as number) : 1 }];
  });
  const def = trans(o.def, f.def);
  const m = (o.music && typeof o.music === 'object' ? o.music : {}) as Record<string, unknown>;
  return {
    shots, def,
    joins: shots.slice(1).map((_, i) => trans((Array.isArray(o.joins) ? o.joins : [])[i], def)),
    fadeIn: FADES.includes(o.fadeIn as number) ? (o.fadeIn as number) : 0,
    fadeOut: FADES.includes(o.fadeOut as number) ? (o.fadeOut as number) : 0,
    music: str(m.path) ? { path: m.path as string, name: str(m.name) ?? (m.path as string) } : null,
    musicVolume: num(o.musicVolume, f.musicVolume, 0, 1.5),
    shotVolume: num(o.shotVolume, f.shotVolume, 0, 1),
    logo: str(o.logo),
    logoPosition: CORNERS.includes(o.logoPosition as Corner) ? (o.logoPosition as Corner) : f.logoPosition,
    logoScale: num(o.logoScale, f.logoScale, 0.05, 0.3),
    endcard: str(o.endcard),
    endcardSeconds: num(o.endcardSeconds, f.endcardSeconds, 1, 5),
    format: o.format === 'webm' ? 'webm' : 'mp4',
  };
}

function load(): State {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) return sane(JSON.parse(raw));
  } catch {
    // gesperrt oder kaputt: leer anfangen
  }
  return fresh();
}

const sec = (x: number) => `${x.toLocaleString(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
const pct = (x: number) => `${Math.round(x * 100)} %`;
const len = (s: Shot) => (s.duration === null ? null : ((s.end ?? s.duration) - s.start) / s.speed);
const blend = (j: Trans) => (j.kind === 'cut' ? 0 : j.duration);

export interface Cut {
  settings: HTMLElement;
  stage: HTMLElement;
  /** Galerie-Klick im Schnitt: Video hinein, schon drin → heraus. */
  toggle(g: Generation): void;
  add(g: Generation): void;
  /** Position(en) je Video für die Galerie-Kacheln. */
  marks(): Map<string, string>;
  /** Rendern in voller Qualität; wirft mit Meldung für das Formular. */
  render(): Promise<void>;
  /** Fertigen Schnitt aus der Galerie wieder öffnen. */
  open(g: Generation): void;
}

export function cutView(onMarks: () => void): Cut {
  let st = load();
  let sel: { kind: 'shot' | 'join'; i: number } | null = null;
  /** Stand vor „Im Schnitt öffnen“, zum Zurückholen. */
  let prev: State | null = null;
  const missing = new Set<string>();

  function normalize() {
    while (st.joins.length < st.shots.length - 1) st.joins.push({ ...st.def });
    st.joins.length = Math.max(0, st.shots.length - 1);
  }
  normalize();

  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify(st));
    } catch {
      // nur Bequemlichkeit
    }
    onMarks();
    drawStrip();
  }

  // --- Mitte: Player, Prüfbereich, Filmstreifen ---
  const status = h('div', { class: 'status' });
  const total = h('div', { class: 'cut-total' });
  const player = h('video', { class: 'player cut-player', controls: true, playsinline: true, preload: 'metadata' });
  const inspector = h('div', { class: 'cut-inspect' });
  const strip = h('div', { class: 'cut-strip' });
  const error = h('p', { class: 'form-error' });
  const undo = h('button', { type: 'button', class: 'button ghost hidden' }, t('cut.undoOpen'));
  const stage = h('section', { class: 'result cut-stage hidden' }, h('div', { class: 'cut-head' }, status, undo, total), player, inspector, strip, error);

  // Nur beim Abspielen in der Kürzung schleifen; ein Seek ans Ende (Ende-Regler) löst selbst timeupdate aus
  player.addEventListener('timeupdate', () => {
    const s = sel?.kind === 'shot' ? st.shots[sel.i] : undefined;
    if (s?.end != null && !player.paused && !player.seeking && player.currentTime >= s.end) player.currentTime = s.start;
  });

  /** Gelöschte Galerie-Videos auch dann erkennen, wenn die Dauer schon gemerkt ist. */
  function check(s: Shot) {
    void api.generation(s.id)
      .then((g) => { if (!g.video || g.status !== 'done') throw new Error(); })
      .catch(() => { missing.add(s.id); drawStrip(); });
  }

  function play(url: string, text: string, at = 0, rate = 1) {
    if (player.getAttribute('src') !== url) player.src = url;
    player.playbackRate = rate;
    const seek = () => { player.currentTime = at; };
    if (player.readyState >= 1) seek();
    else player.addEventListener('loadedmetadata', seek, { once: true });
    status.textContent = text;
  }

  function probe(s: Shot) {
    if (s.duration !== null) return;
    const v = h('video', { preload: 'metadata' });
    v.addEventListener('loadedmetadata', () => {
      s.duration = v.duration;
      v.removeAttribute('src');
      save();
      if (sel?.kind === 'shot' && st.shots[sel.i] === s) drawInspector();
    }, { once: true });
    v.addEventListener('error', () => { missing.add(s.id); drawStrip(); }, { once: true });
    v.src = videoUrl(s.id);
  }

  function select(kind: 'shot' | 'join', i: number) {
    sel = { kind, i };
    const s = st.shots[kind === 'shot' ? i : i + 1];
    if (kind === 'shot' && s) play(videoUrl(s.id), t('cut.showShot', { n: i + 1 }), s.start, s.speed);
    // Übergang: den Anfang des zweiten Shots zeigen
    if (kind === 'join' && s) play(videoUrl(s.id), t('cut.showJoin', { a: i + 1, b: i + 2 }), s.start, s.speed);
    drawInspector();
    drawStrip();
  }

  /** onInput darf den Wert begrenzen und zurückgeben; Regler und Anzeige folgen dann dem echten Wert. */
  function slider(label: string, min: number, max: number, step: number, value: number, show: (v: number) => string, onInput: (v: number) => number | void): HTMLElement {
    const input = h('input', { type: 'range', min, max, step, value: String(value) });
    const out = h('span', { class: 'slider-val' }, show(value));
    input.addEventListener('input', () => {
      const v = onInput(Number(input.value)) ?? Number(input.value);
      if (v !== Number(input.value)) input.value = String(v);
      out.textContent = show(v);
    });
    return h('label', {}, h('span', { class: 'lbl' }, label), h('div', { class: 'row' }, input, out));
  }

  function segs<T extends string | number>(label: string, values: readonly T[], current: T, text: (v: T) => string, onPick: (v: T) => void): HTMLElement {
    const buttons = values.map((v) => h('button', { type: 'button', class: `seg${v === current ? ' on' : ''}`, onclick: () => {
      buttons.forEach((b, k) => b.classList.toggle('on', values[k] === v));
      onPick(v);
    } }, text(v)));
    return h('div', { class: 'field' }, h('span', { class: 'lbl' }, label), h('div', { class: 'segs', style: `--n:${values.length}` }, ...buttons));
  }

  function drawInspector() {
    const s = sel?.kind === 'shot' ? st.shots[sel.i] : undefined;
    const j = sel?.kind === 'join' ? st.joins[sel.i] : undefined;
    if (s && sel) {
      const n = sel.i + 1;
      if (s.duration === null) return void inspector.replaceChildren(h('p', { class: 'cut-hint' }, t('cut.loading')));
      const d = s.duration;
      const seek = (x: number) => { player.pause(); player.currentTime = x; };
      inspector.replaceChildren(
        h('div', { class: 'cut-inspect-head' }, h('strong', {}, t('cut.shot', { n })),
          h('button', { type: 'button', class: 'button ghost', onclick: () => { s.start = 0; s.end = null; s.speed = 1; save(); select('shot', sel?.i ?? 0); } }, t('cut.whole'))),
        h('div', { class: 'cut-grid' },
          slider(t('cut.start'), 0, d, 0.04, s.start, sec, (v) => { s.start = Math.max(0, Math.min(v, (s.end ?? d) - 0.1)); seek(s.start); save(); return s.start; }),
          slider(t('cut.end'), 0, d, 0.04, s.end ?? d, sec, (v) => {
            s.end = v >= d - 0.02 ? null : Math.max(v, s.start + 0.1);
            seek(s.end ?? d);
            save();
            return s.end ?? d;
          })),
        segs(t('cut.speed'), SPEEDS, s.speed, (v) => `${v.toLocaleString(lang)}×`, (v) => { s.speed = v; player.playbackRate = v; save(); }),
      );
      return;
    }
    if (j && sel) {
      const i = sel.i;
      const dur = slider(t('cut.duration'), 0.1, 2, 0.1, j.duration, sec, (v) => { j.duration = v; save(); });
      dur.classList.toggle('hidden', j.kind === 'cut');
      inspector.replaceChildren(
        h('div', { class: 'cut-inspect-head' }, h('strong', {}, t('cut.join', { a: i + 1, b: i + 2 }))),
        segs(t('cut.kind'), KINDS, j.kind, (k) => t(KIND_KEY[k]), (k) => { j.kind = k; dur.classList.toggle('hidden', k === 'cut'); save(); }),
        dur,
      );
      return;
    }
    inspector.replaceChildren(h('p', { class: 'cut-hint' }, t(st.shots.length ? 'cut.hintSelect' : 'cut.hintEmpty')));
  }

  /** Blende länger als einer der beiden Shots: ffmpeg lehnte ab, darum vorher markieren. */
  function tooLong(i: number): boolean {
    const a = st.shots[i];
    const b = st.shots[i + 1];
    const j = st.joins[i];
    const la = a ? len(a) : null;
    const lb = b ? len(b) : null;
    return !!j && la !== null && lb !== null && blend(j) >= Math.min(la, lb);
  }

  let dragFrom: number | null = null;
  function drawStrip() {
    const cards: HTMLElement[] = [];
    st.shots.forEach((s, i) => {
      if (i > 0) {
        const j = st.joins[i - 1] as Trans;
        const chip = h('button', {
          type: 'button', class: `cut-join${tooLong(i - 1) ? ' bad' : ''}${sel?.kind === 'join' && sel.i === i - 1 ? ' on' : ''}`,
          title: tooLong(i - 1) ? t('cut.tooLong') : t('cut.joinTitle'), onclick: () => select('join', i - 1),
        }, h('span', {}, t(KIND_KEY[j.kind])), j.kind === 'cut' ? null : h('small', {}, sec(j.duration)));
        // Ablegen auf einem Übergang = vor den Shot dahinter
        chip.dataset.before = String(i);
        cards.push(chip);
      }
      const l = len(s);
      const rm = h('button', { type: 'button', class: 'drop-clear', title: t('drop.remove') }, '×');
      rm.addEventListener('click', (e) => { e.stopPropagation(); remove(i); });
      const card = h('div', {
        class: `cut-shot${sel?.kind === 'shot' && sel.i === i ? ' on' : ''}${missing.has(s.id) ? ' gone' : ''}`, draggable: true, title: missing.has(s.id) ? t('cut.gone') : '',
      }, h('img', { src: imageUrl(s.id, 'thumb'), alt: '' }), h('span', { class: 'bar-n' }, String(i + 1)),
      h('span', { class: 'cut-len' }, l === null ? '…' : sec(l), s.speed !== 1 ? ` · ${s.speed.toLocaleString(lang)}×` : ''), rm);
      card.dataset.i = String(i);
      card.addEventListener('click', () => select('shot', i));
      card.addEventListener('dragstart', (e) => { dragFrom = i; e.dataTransfer?.setData('text/plain', String(i)); });
      card.addEventListener('dragend', () => { dragFrom = null; });
      cards.push(card);
    });
    const lastLen = st.shots.length ? len(st.shots[st.shots.length - 1] as Shot) : null;
    const endBad = !!st.endcard && lastLen !== null && blend(st.def) >= Math.min(lastLen, st.endcardSeconds);
    if (st.endcard && st.shots.length) {
      cards.push(h('span', { class: `cut-join fixed${endBad ? ' bad' : ''}`, title: endBad ? t('cut.tooLong') : t('cut.endJoin') },
        h('span', {}, t(KIND_KEY[st.def.kind])), st.def.kind === 'cut' ? null : h('small', {}, sec(st.def.duration))));
      cards.push(h('div', { class: 'cut-shot fixed' }, h('img', { src: imageUrl(st.endcard, 'thumb'), alt: '' }), h('span', { class: 'cut-len' }, `${t('cut.endcard')} · ${sec(st.endcardSeconds)}`)));
    }
    strip.replaceChildren(...(cards.length ? cards : [h('p', { class: 'cut-empty' }, t('cut.empty'))]));
    const lengths = st.shots.map(len);
    total.classList.remove('bad');
    total.title = '';
    if (lengths.some((l) => l === null) || !lengths.length) total.textContent = st.shots.length ? '…' : '';
    else {
      const end = st.endcard ? st.endcardSeconds - blend(st.def) : 0;
      const sum = (lengths as number[]).reduce((a, b) => a + b, 0) - st.joins.reduce((a, j) => a + blend(j), 0) + end;
      total.textContent = t('cut.total', { d: sec(Math.max(0, sum)) });
      if (st.fadeIn + st.fadeOut > sum) {
        total.classList.add('bad');
        total.title = t('cut.fadesTooLong');
      }
    }
  }

  strip.addEventListener('dragover', (e) => { e.preventDefault(); strip.classList.add('over'); });
  strip.addEventListener('dragleave', () => strip.classList.remove('over'));
  strip.addEventListener('drop', (e) => {
    e.preventDefault();
    strip.classList.remove('over');
    // Aus der Galerie zuerst: ein hängengebliebenes dragFrom machte sonst aus dem Hinzufügen ein Umsortieren
    const id = e.dataTransfer?.getData(GEN_DRAG);
    if (id) {
      dragFrom = null;
      return void api.generation(id).then((g) => add(g)).catch((err: Error) => { error.textContent = err.message; });
    }
    if (dragFrom === null) return;
    const hit = (e.target as HTMLElement).closest<HTMLElement>('.cut-shot[data-i], .cut-join[data-before]');
    // Übergänge bleiben an ihrer Stelle im Streifen, nur die Shots wandern
    let to = st.shots.length - 1;
    if (hit?.dataset.i !== undefined) to = Number(hit.dataset.i);
    else if (hit?.dataset.before !== undefined) to = Number(hit.dataset.before) - (dragFrom < Number(hit.dataset.before) ? 1 : 0);
    const [moved] = st.shots.splice(dragFrom, 1);
    if (moved) st.shots.splice(to, 0, moved);
    dragFrom = null;
    sel = null;
    drawInspector();
    save();
  });

  function add(g: Generation) {
    if (!g.video || g.status !== 'done') return void (error.textContent = t('cut.onlyVideo'));
    error.textContent = '';
    if (st.shots.length) st.joins.push({ ...st.def });
    const s: Shot = { id: g.id, duration: null, start: 0, end: null, speed: 1 };
    st.shots.push(s);
    probe(s);
    save();
    drawInspector();
  }

  function remove(i: number) {
    st.shots.splice(i, 1);
    st.joins.splice(Math.max(0, i - 1), 1);
    normalize();
    sel = null;
    drawInspector();
    save();
  }

  function toggle(g: Generation) {
    const last = st.shots.map((s) => s.id).lastIndexOf(g.id);
    if (last >= 0) remove(last);
    else add(g);
  }

  function marks(): Map<string, string> {
    const m = new Map<string, number[]>();
    st.shots.forEach((s, i) => m.set(s.id, [...(m.get(s.id) ?? []), i + 1]));
    return new Map([...m].map(([id, n]) => [id, n.join(',')]));
  }

  // --- Links: Einstellungen ---
  const settings = h('div', { class: 'section cut-settings hidden' });
  const musicInput = h('input', { type: 'file', accept: 'audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg', class: 'hidden' });
  const previewBtn = h('button', { type: 'button', class: 'button ghost' }, t('cut.preview'));
  const clearBtn = h('button', { type: 'button', class: 'button ghost' }, t('cut.clear'));

  function imageDrop(label: string, value: string | null, onSet: (id: string | null) => void): HTMLElement {
    const box = value
      ? h('div', { class: 'bar-tile' }, h('img', { src: imageUrl(value, 'thumb'), alt: '' }),
        h('button', { type: 'button', class: 'drop-clear', title: t('drop.remove'), onclick: () => onSet(null) }, '×'))
      : h('div', { class: 'drop cut-drop' }, h('div', { class: 'drop-text' }, t('cut.dropImage')));
    box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('over'); });
    box.addEventListener('dragleave', () => box.classList.remove('over'));
    box.addEventListener('drop', (e) => {
      e.preventDefault();
      const id = e.dataTransfer?.getData(GEN_DRAG);
      if (id) onSet(id);
    });
    return h('div', { class: 'field' }, h('span', { class: 'lbl' }, label), box);
  }

  function drawSettings() {
    const redraw = () => { save(); drawSettings(); };
    const defDur = slider(t('cut.duration'), 0.1, 2, 0.1, st.def.duration, sec, (v) => { st.def.duration = v; save(); });
    defDur.classList.toggle('hidden', st.def.kind === 'cut');
    const kindSel = h('select', {}, ...KINDS.map((k) => h('option', { value: k, selected: k === st.def.kind }, t(KIND_KEY[k]))));
    kindSel.addEventListener('change', () => { st.def.kind = kindSel.value as Kind; defDur.classList.toggle('hidden', st.def.kind === 'cut'); save(); });
    const fadeSel = (value: number, onPick: (v: number) => void) => {
      const s = h('select', {}, ...FADES.map((f) => h('option', { value: f, selected: f === value }, f ? sec(f) : t('cut.off'))));
      s.addEventListener('change', () => { onPick(Number(s.value)); save(); });
      return s;
    };
    const musicRow = st.music
      ? h('div', { class: 'bar-tile' }, h('span', { class: 'drop-name' }, `♪ ${st.music.name}`),
        h('button', { type: 'button', class: 'drop-clear', title: t('drop.remove'), onclick: () => { st.music = null; redraw(); } }, '×'))
      : h('button', { type: 'button', class: 'button ghost', onclick: () => musicInput.click() }, t('cut.musicPick'));
    const posSel = h('select', {}, ...CORNERS.map((c) => h('option', { value: c, selected: c === st.logoPosition }, t(CORNER_KEY[c]))));
    posSel.addEventListener('change', () => { st.logoPosition = posSel.value as Corner; save(); });

    settings.replaceChildren(
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, t('cut.defJoin')), kindSel),
      defDur,
      h('button', { type: 'button', class: 'button ghost', onclick: () => { st.joins = st.joins.map(() => ({ ...st.def })); save(); drawInspector(); } }, t('cut.applyAll')),
      h('div', { class: 'cut-grid' },
        h('label', {}, h('span', { class: 'lbl' }, t('cut.fadeIn')), fadeSel(st.fadeIn, (v) => { st.fadeIn = v; })),
        h('label', {}, h('span', { class: 'lbl' }, t('cut.fadeOut')), fadeSel(st.fadeOut, (v) => { st.fadeOut = v; }))),
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, t('cut.music')), musicRow, musicInput),
      ...(st.music ? [
        slider(t('cut.musicVolume'), 0, 1.5, 0.05, st.musicVolume, pct, (v) => { st.musicVolume = v; save(); }),
        slider(t('cut.shotVolume'), 0, 1, 0.05, st.shotVolume, pct, (v) => { st.shotVolume = v; save(); }),
      ] : []),
      imageDrop(t('cut.logo'), st.logo, (id) => { st.logo = id; redraw(); }),
      ...(st.logo ? [h('label', {}, h('span', { class: 'lbl' }, t('cut.logoPos')), posSel),
        slider(t('cut.logoSize'), 0.05, 0.3, 0.01, st.logoScale, pct, (v) => { st.logoScale = v; save(); })] : []),
      imageDrop(t('cut.endcard'), st.endcard, (id) => { st.endcard = id; redraw(); }),
      ...(st.endcard ? [slider(t('cut.endcardSeconds'), 1, 5, 0.5, st.endcardSeconds, sec, (v) => { st.endcardSeconds = v; save(); })] : []),
      segs(t('cut.format'), ['mp4', 'webm'] as const, st.format, (f) => f.toUpperCase(), (f) => { st.format = f; save(); }),
      h('div', { class: 'pg-actions' }, previewBtn, clearBtn),
    );
  }

  musicInput.addEventListener('change', () => {
    const file = musicInput.files?.[0];
    musicInput.value = '';
    if (!file) return;
    error.textContent = t('cut.uploading');
    api.uploadAudio(file)
      .then(({ path }) => { st.music = { path, name: file.name }; error.textContent = ''; save(); drawSettings(); })
      .catch((e: Error) => { error.textContent = e.message; });
  });

  let armed: number | undefined;
  clearBtn.addEventListener('click', () => {
    if (armed === undefined) {
      clearBtn.textContent = t('cut.clearConfirm');
      armed = window.setTimeout(() => { armed = undefined; clearBtn.textContent = t('cut.clear'); }, 3000);
      return;
    }
    clearTimeout(armed);
    armed = undefined;
    clearBtn.textContent = t('cut.clear');
    st = { ...fresh(), def: st.def, format: st.format };
    prev = null;
    undo.classList.add('hidden');
    sel = null;
    player.removeAttribute('src');
    player.load();
    status.textContent = '';
    save();
    drawSettings();
    drawInspector();
  });

  function body(preview: boolean) {
    if (st.shots.length < 2) throw new Error(t('cut.needTwo'));
    const gone = st.shots.flatMap((s, i) => (missing.has(s.id) ? [i + 1] : []));
    if (gone.length) throw new Error(t('cut.goneShots', { n: gone.join(', ') }));
    const join = (j: Trans) => (j.kind === 'cut' ? { duration: 0 } : { duration: j.duration, type: j.kind });
    return {
      ids: st.shots.map((s) => s.id),
      fade: blend(st.def),
      joins: st.joins.map(join),
      endJoin: join(st.def),
      edits: st.shots.map((s) => ({ ...(s.start > 0 ? { start: s.start } : {}), ...(s.end !== null ? { end: s.end } : {}), ...(s.speed !== 1 ? { speed: s.speed } : {}) })),
      fadeIn: st.fadeIn,
      fadeOut: st.fadeOut,
      format: st.format,
      preview,
      ...(st.music ? { music: st.music.path, musicVolume: st.musicVolume, shotVolume: st.shotVolume } : {}),
      ...(st.logo ? { logo: st.logo, logoPosition: st.logoPosition, logoScale: st.logoScale } : {}),
      ...(st.endcard ? { endcard: st.endcard, endcardSeconds: st.endcardSeconds } : {}),
    };
  }

  previewBtn.addEventListener('click', () => {
    error.textContent = '';
    let req;
    try {
      req = body(true);
    } catch (e) {
      error.textContent = (e as Error).message;
      return;
    }
    previewBtn.disabled = true;
    previewBtn.textContent = t('cut.previewBusy');
    status.textContent = t('cut.previewBusy');
    api.concatPreview(req)
      .then((r) => {
        sel = null;
        drawInspector();
        drawStrip();
        play(`${r.url}?t=${Date.now()}`, t('cut.previewShown', { d: sec(r.duration) }));
        void player.play().catch(() => {});
      })
      .catch((e: Error) => { error.textContent = e.message; status.textContent = ''; })
      .finally(() => { previewBtn.disabled = false; previewBtn.textContent = t('cut.preview'); });
  });

  async function render() {
    error.textContent = '';
    status.textContent = t('cut.rendering');
    try {
      const g = await api.concat(body(false));
      sel = null;
      drawInspector();
      drawStrip();
      play(videoUrl(g.id), t('cut.done'));
    } catch (e) {
      status.textContent = '';
      throw e;
    }
  }

  function open(g: Generation) {
    const p = g.params;
    const ids = typeof p.shots === 'string' ? p.shots.split(',').filter(Boolean) : [];
    const json = <T>(v: ParamValue | undefined): T | null => {
      try {
        return typeof v === 'string' ? (JSON.parse(v) as T) : null;
      } catch {
        return null;
      }
    };
    const num = (v: ParamValue | undefined, d: number) => (typeof v === 'number' ? v : d);
    const joins = json<{ duration: number; type?: Kind }[]>(p.joins);
    const edits = json<{ start?: number; end?: number; speed?: number }[]>(p.edits);
    const fade = num(p.fade, 0);
    const end = json<{ duration: number; type?: Kind }>(p.endJoin);
    const asTrans = (j: { duration: number; type?: Kind }): Trans => (j.duration ? { kind: j.type ?? 'fade', duration: j.duration } : { kind: 'cut', duration: 0.5 });
    const def: Trans = asTrans(end ?? { duration: fade });
    // Laufende Arbeit nicht wegwerfen: zurückholbar, bis etwas Neues geöffnet oder geleert wird
    if (st.shots.length) {
      prev = structuredClone(st);
      undo.classList.remove('hidden');
    }
    st = {
      ...fresh(),
      def,
      shots: ids.map((id, i) => ({ id, duration: null, start: edits?.[i]?.start ?? 0, end: edits?.[i]?.end ?? null, speed: edits?.[i]?.speed ?? 1 })),
      joins: ids.slice(1).map((_, i) => {
        const j = joins?.[i];
        return j ? asTrans(j) : { ...def };
      }),
      fadeIn: num(p.fadeIn, 0),
      fadeOut: num(p.fadeOut, 0),
      music: typeof p.music === 'string' ? { path: p.music, name: p.music.split(/[\\/]/).pop() ?? p.music } : null,
      musicVolume: num(p.musicVolume, 0.8),
      shotVolume: num(p.shotVolume, 0.35),
      logo: typeof p.logo === 'string' ? p.logo : null,
      logoPosition: CORNERS.includes(p.logoPosition as Corner) ? (p.logoPosition as Corner) : 'br',
      logoScale: num(p.logoScale, 0.12),
      endcard: typeof p.endcard === 'string' ? p.endcard : null,
      endcardSeconds: num(p.endcardSeconds, 2),
      format: p.format === 'webm' ? 'webm' : 'mp4',
    };
    normalize();
    sel = null;
    st.shots.forEach((s) => { probe(s); check(s); });
    save();
    drawSettings();
    drawInspector();
    play(videoUrl(g.id), t('cut.opened'));
  }

  undo.addEventListener('click', () => {
    if (!prev) return;
    st = prev;
    prev = null;
    undo.classList.add('hidden');
    sel = null;
    st.shots.forEach((s) => { probe(s); check(s); });
    status.textContent = '';
    save();
    drawSettings();
    drawInspector();
  });

  st.shots.forEach((s) => { probe(s); check(s); });
  drawSettings();
  drawInspector();
  drawStrip();
  return { settings, stage, toggle, add, marks, render, open };
}
