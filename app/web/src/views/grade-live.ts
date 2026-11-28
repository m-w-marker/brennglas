import { gradeActive, gradeNumbers, type Grade } from '@brennglas/shared';

const SVG = 'http://www.w3.org/2000/svg';
const FILTER_ID = 'cut-grade-live';
const C0 = 128 / 255;
const matrix = (rows: number[][]) => [...rows.map((r) => [...r.slice(0, 3), 0, r[3] ?? 0]), [0, 0, 0, 1, 0]].flat().map((x) => x.toFixed(6)).join(' ');
const TO_YUV = matrix([[65.481, 128.553, 24.966, 16], [-37.797, -74.203, 112, 128], [112, -93.786, -18.214, 128]].map((r) => r.map((x) => x / 255)));
const FROM_YUV = matrix([[1.164383, 0, 1.596027], [1.164383, -0.391762, -0.812968], [1.164383, 2.017232, 0]]
  .map(([y = 0, cb = 0, cr = 0]) => [y, cb, cr, -(y * 16 / 255 + (cb + cr) * C0)]));

/** Kanal-Faktoren wie ffmpegs colortemperature (kelvin2rgb), auf 0 … 1. */
function kelvinRgb(k: number): [number, number, number] {
  const t = k / 100;
  const r = t <= 66 ? 1 : 1.29293618606274509804 * Math.max(t - 60, 0) ** -0.1332047592;
  const g = t <= 66 ? 0.39008157876901960784 * Math.log(t) - 0.63184144378862745098 : 1.12989086089529411765 * Math.max(t - 60, 0) ** -0.0755148492;
  const b = t >= 66 ? 1 : t <= 19 ? 0 : 0.54320678911019607843 * Math.log(t - 10) - 1.19625408914;
  const c = (x: number) => Math.min(1, Math.max(0, x));
  return [c(r), c(g), c(b)];
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, ...kids: SVGElement[]): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  e.append(...kids);
  return e;
}

/** Farbgebung live über dem Player: SVG-Filter für die Farben, Ebenen für Vignette und Korn; eine Annäherung, genau ist erst die Vorschau. */
export function gradeLive(player: HTMLVideoElement, screen: HTMLElement): { set(g: Grade, on: boolean): void } {
  // eq rechnet auf Y/U/V (BT.601, begrenzter Bereich): dorthin, Kanal R = Y, G = Cb, B = Cr, und zurück; gegen ffmpeg ≤ 8/255 bei üblichen Werten
  const contrast = el('feFuncR', { type: 'linear' });
  const gamma = el('feFuncR', { type: 'gamma', amplitude: 1, offset: 0 });
  const chroma = [el('feFuncG', { type: 'linear' }), el('feFuncB', { type: 'linear' })];
  const temp = el('feColorMatrix', { type: 'matrix', values: '' });
  // sRGB wie ffmpeg; der SVG-Standard rechnete in linearem RGB
  screen.append(el('svg', { width: 0, height: 0, style: 'position:absolute', 'aria-hidden': 'true' },
    el('filter', { id: FILTER_ID, 'color-interpolation-filters': 'sRGB' },
      el('feColorMatrix', { type: 'matrix', values: TO_YUV }), el('feComponentTransfer', {}, contrast),
      el('feComponentTransfer', {}, gamma, ...chroma), el('feColorMatrix', { type: 'matrix', values: FROM_YUV }), temp)));

  const vignette = document.createElement('div');
  const grain = document.createElement('canvas');
  for (const o of [vignette, grain]) o.className = 'cut-live hidden';
  // direkt über das Video, unter das Rückwärts-Schild; Korn über der Vignette wie in ffmpeg
  player.after(vignette, grain);
  grain.style.mixBlendMode = 'overlay';

  let cur: Grade | null = null;
  let frames: HTMLCanvasElement[] = [];
  let frame = 0;
  let timer: number | undefined;

  /** Ebenen auf das sichtbare Bild legen, der Player selbst hat schwarze Ränder (contain). */
  function place() {
    const vw = player.videoWidth;
    const vh = player.videoHeight;
    // ausgeblendete Ansicht (display:none) meldet 0 × 0: nichts zu legen, sonst scheitert createImageData
    if (!vw || !vh || !player.clientWidth || !player.clientHeight) return;
    const s = Math.min(player.clientWidth / vw, player.clientHeight / vh);
    const w = Math.round(vw * s);
    const h = Math.round(vh * s);
    const box = { left: `${player.offsetLeft + (player.clientWidth - w) / 2}px`, top: `${player.offsetTop + (player.clientHeight - h) / 2}px`, width: `${w}px`, height: `${h}px` };
    Object.assign(vignette.style, box);
    Object.assign(grain.style, box);
    if (cur?.grain) makeGrain(w, h, gradeNumbers(cur).grain);
  }

  let grainKey = '';
  function makeGrain(w: number, h: number, amp: number) {
    // grenze: Korn in Bildschirm- statt Videopixeln, bei stark verkleinertem Player wirkt es gröber als im Ergebnis
    const cw = Math.min(w, 1280);
    const ch = Math.round((h * cw) / w);
    const key = `${cw}x${ch}:${amp}`;
    if (key === grainKey) return;
    grainKey = key;
    grain.width = cw;
    grain.height = ch;
    frames = [0, 1, 2, 3].map(() => {
      const c = document.createElement('canvas');
      c.width = cw;
      c.height = ch;
      const ctx = c.getContext('2d');
      if (!ctx) return c;
      const img = ctx.createImageData(cw, ch);
      // overlay: Grau 128 ist neutral, im Mittelton wirkt die Abweichung wie ffmpegs ± amp
      for (let p = 0; p < img.data.length; p += 4) {
        const v = 128 + Math.round((Math.random() * 2 - 1) * amp);
        img.data[p] = v;
        img.data[p + 1] = v;
        img.data[p + 2] = v;
        img.data[p + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      return c;
    });
    draw();
  }

  function draw() {
    const f = frames[frame++ % frames.length];
    if (f) grain.getContext('2d')?.drawImage(f, 0, 0);
  }

  function tick() {
    clearInterval(timer);
    timer = undefined;
    // Korn läuft nur mit, solange das Video läuft; angehalten bleibt es stehen wie im Standbild
    if (cur?.grain && !player.paused) timer = window.setInterval(draw, 1000 / 24);
  }

  function set(g: Grade, on: boolean) {
    cur = on && gradeActive(g) ? { ...g } : null;
    player.style.filter = cur ? `url(#${FILTER_ID})` : '';
    vignette.classList.toggle('hidden', !cur?.vignette);
    grain.classList.toggle('hidden', !cur?.grain);
    if (!cur) return void tick();
    const n = gradeNumbers(cur);
    contrast.setAttribute('slope', String(n.contrast));
    contrast.setAttribute('intercept', String(0.5 - 0.5 * n.contrast));
    gamma.setAttribute('exponent', String(1 / n.gamma));
    for (const f of chroma) {
      f.setAttribute('slope', String(n.saturation));
      f.setAttribute('intercept', String(C0 * (1 - n.saturation)));
    }
    const [r, gg, b] = kelvinRgb(n.kelvin);
    // ffmpegs pl=1 hält die Helligkeit je Pixel; für Grau genau dieser Faktor
    const k = 2 / (Math.max(r, gg, b) + Math.min(r, gg, b));
    temp.setAttribute('values', `${r * k} 0 0 0 0 0 ${gg * k} 0 0 0 0 0 ${b * k} 0 0 0 0 0 1 0`);
    if (cur.vignette) {
      const from = n.vignetteFrom;
      const stops = [`transparent ${from * 100}%`];
      for (let i = 1; i <= 8; i++) {
        const t = i / 8;
        stops.push(`rgba(0,0,0,${(n.vignetteDepth * t * t * (3 - 2 * t)).toFixed(3)}) ${((from + (1 - from) * t) * 100).toFixed(1)}%`);
      }
      // farthest-corner: 100 % liegt in den Ecken, die Ellipse folgt dem Bildformat wie die ffmpeg-Maske
      vignette.style.background = `radial-gradient(ellipse farthest-corner at 50% 50%, ${stops.join(', ')})`;
    }
    place();
    tick();
  }

  player.addEventListener('loadedmetadata', place);
  player.addEventListener('play', tick);
  player.addEventListener('pause', tick);
  // neue Quelle hält an, ohne pause zu melden
  player.addEventListener('emptied', tick);
  new ResizeObserver(place).observe(player);
  return { set };
}
