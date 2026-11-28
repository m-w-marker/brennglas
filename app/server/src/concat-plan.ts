import { gradeNumbers, type Grade } from '@brennglas/shared';

/** Eckdaten eines Shots laut ffprobe. */
export interface ClipInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

export interface ConcatPlan {
  filter: string;
  /** Länge des fertigen Clips in Sekunden. */
  duration: number;
  width: number;
  height: number;
  fps: number;
}

/** Fehler im Schnitt selbst (Längen, Blenden) – der Aufrufer meldet sie als 400, nicht als ffmpeg-Absturz. */
export class PlanError extends Error {}

/** Übergangsarten: fade = Überblenden, die übrigen sind die gleichnamigen xfade-Übergänge. */
export const TRANSITIONS = ['fade', 'fadeblack', 'fadewhite', 'wipeleft', 'slideleft'] as const;
export type Transition = (typeof TRANSITIONS)[number];

/** Übergang zum nächsten Shot; duration 0 = harter Schnitt. */
export interface Join {
  duration: number;
  type?: Transition;
}

/** Kürzen, Tempo und Richtung eines Shots; start/end in Sekunden der Quelle, speed 0,5 – 2, reverse ohne Ton. */
export interface ShotEdit {
  start?: number;
  end?: number;
  speed?: number;
  reverse?: boolean;
}

/** Zusätze nach dem Schnitt; input = Index der ffmpeg-Eingabe (nach den Shots). */
export interface ConcatExtras {
  /** Durchgehender Track; die Geräusche der Shots werden auf shotVolume abgesenkt. */
  music?: { input: number; volume: number; shotVolume: number };
  /** Logo (PNG mit Alpha) in einer Ecke, scale = Anteil an der Bildbreite. */
  logo?: { input: number; scale: number; position: 'tl' | 'tr' | 'bl' | 'br' };
  /** Auf- und Abblende aus/nach Schwarz über den ganzen Schnitt, Bild und Ton, in Sekunden. */
  fadeIn?: number;
  fadeOut?: number;
  /** Höhe deckeln, für die schnelle Vorschau. */
  maxHeight?: number;
  grade?: Grade;
  /** Der letzte Clip ist die Endkarte: bleibt ohne Grading, wie das Logo. */
  endcard?: boolean;
}

/** Grading als Fortsetzung der Shot-Kette i nach Größe und fps, leer wenn neutral; Korn zuletzt, nur auf der Helligkeit, je Frame neu. */
export function gradeFilter(g: Grade, w: number, h: number, fps: number, i: number): string {
  const f: string[] = [];
  const n = gradeNumbers(g);
  const eq = [
    g.brightness && `gamma=${round(n.gamma)}`,
    g.contrast && `contrast=${round(n.contrast)}`,
    g.saturation && `saturation=${round(n.saturation)}`,
  ].filter(Boolean);
  if (eq.length) f.push(`eq=${eq.join(':')}`);
  // gemessen an Grau: 3500 K → 164/124/91
  if (g.warmth) f.push(`colortemperature=temperature=${n.kelvin}:pl=1`);
  if (g.vignette) {
    // ffmpegs vignette ändert per Winkel nur die Form (cos⁴ bis zur Bildmitte): eigene Maske, Mitte frei, weich zu den Ecken
    const r0 = round(n.vignetteFrom);
    const lum = `st(0,clip((hypot((X-W/2)/(W/2),(Y-H/2)/(H/2))/sqrt(2)-${r0})/${round(1 - r0)},0,1));255*(1-${round(n.vignetteDepth)}*ld(0)*ld(0)*(3-2*ld(0)))`;
    f.push(`format=gbrp[g${i}];color=c=white:s=${w}x${h}:r=${fps},trim=end_frame=1,format=gray,geq=lum='${lum}',loop=loop=-1:size=1,format=gbrp[m${i}];`
      + `[g${i}][m${i}]blend=all_mode=multiply:shortest=1`);
  }
  if (!f.length && !g.grain) return '';
  return `${f.length ? `,${f.join(',')}` : ''},format=yuv420p${g.grain ? `,noise=c0s=${n.grain}:c0f=t+u` : ''}`;
}

/** Bildrate aus ffprobe: avg_frame_rate stimmt auch bei variabler Rate (Handy, OBS), r_frame_rate meldet dort oft 90000. */
export function frameRate(avg: string | undefined, r: string | undefined): number {
  const rate = (x: string | undefined) => {
    const [n, d] = (x ?? '').split('/').map(Number);
    return n && d && n / d >= 1 && n / d <= 240 ? Math.round((n / d) * 1000) / 1000 : null;
  };
  return rate(avg) ?? rate(r) ?? 24;
}

export const SPEED_MIN = 0.5;
export const SPEED_MAX = 2;

/** Länge eines Shots im Schnitt: gekürzt und durch das Tempo geteilt. */
export function shotLength(c: ClipInfo, e: ShotEdit = {}): number {
  return ((e.end ?? c.duration) - (e.start ?? 0)) / (e.speed ?? 1);
}

/** filter_complex für n Shots auf Größe/fps des ersten; ohne Ton → Stille, sonst scheitern concat/acrossfade.
 *  joins: eine Blende für alle Übergänge oder eine je Übergang (Zahl = Überblenden), 0 = harter Schnitt. */
export function planConcat(clips: ClipInfo[], joins: number | (number | Join)[], extras: ConcatExtras = {}, edits: ShotEdit[] = []): ConcatPlan {
  const first = clips[0];
  if (!first || clips.length < 2) throw new PlanError('Mindestens zwei Shots');
  const steps: Join[] = (typeof joins === 'number' ? clips.slice(1).map(() => joins) : joins)
    .map((j) => (typeof j === 'number' ? { duration: j } : j));
  if (steps.length !== clips.length - 1) throw new PlanError(`${clips.length - 1} Überblendungen für ${clips.length} Shots nötig`);
  // Ende auf die Länge der Videospur deckeln: der Browser meldet die Container-Dauer, die kann ein paar ms länger sein
  const cuts = clips.map((c, i) => {
    const e = edits[i] ?? {};
    const cut: ShotEdit = { ...e, ...(e.end !== undefined ? { end: Math.min(e.end, c.duration) } : {}) };
    const start = cut.start ?? 0;
    const end = cut.end ?? c.duration;
    const speed = cut.speed ?? 1;
    if (!(start >= 0 && end - start >= 0.1)) throw new PlanError(`Shot ${i + 1}: Anfang/Ende außerhalb von 0 – ${c.duration.toFixed(2)} s`);
    if (!(speed >= SPEED_MIN && speed <= SPEED_MAX)) throw new PlanError(`Shot ${i + 1}: Tempo ${SPEED_MIN}× – ${SPEED_MAX}×`);
    return cut;
  });
  const lengths = clips.map((c, i) => shotLength(c, cuts[i]));
  steps.forEach((s, k) => {
    const short = Math.min(lengths[k] as number, lengths[k + 1] as number);
    if (!(s.duration >= 0) || (s.duration > 0 && s.duration >= short)) throw new PlanError(`Überblendung ${k + 1} muss kürzer sein als ihre beiden Shots (${short.toFixed(2)} s)`);
    if (s.type && !TRANSITIONS.includes(s.type)) throw new PlanError(`Unbekannter Übergang: ${String(s.type)}`);
  });
  // yuv420p braucht gerade Kanten; die Vorschau rechnet kleiner
  const shrink = extras.maxHeight && first.height > extras.maxHeight ? extras.maxHeight / first.height : 1;
  const w = Math.round((first.width * shrink) / 2) * 2;
  const h = Math.round((first.height * shrink) / 2) * 2;
  const fps = first.fps;
  const parts: string[] = [];
  const graded = clips.length - (extras.endcard ? 1 : 0);
  clips.forEach((c, i) => {
    const e = cuts[i] ?? {};
    const len = round(lengths[i] as number);
    const speed = e.speed ?? 1;
    const cut = e.start !== undefined || e.end !== undefined;
    // grenze: reverse puffert den ganzen Shot im RAM (~1–2 GB bei 10 s 1080p), ab Shots über ~30 s in Stücken umdrehen
    const vPre = cut || speed !== 1 || e.reverse
      ? `${cut ? `trim=start=${e.start ?? 0}:end=${e.end ?? c.duration},` : ''}${e.reverse ? 'setpts=PTS-STARTPTS,reverse,' : ''}setpts=${speed === 1 ? 'PTS-STARTPTS' : `(PTS-STARTPTS)/${speed}`},` : '';
    const aPre = `${cut ? `atrim=start=${e.start ?? 0}:end=${e.end ?? c.duration},asetpts=PTS-STARTPTS,` : ''}${speed !== 1 ? `atempo=${speed},` : ''}`;
    parts.push(`[${i}:v]${vPre}scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p${extras.grade && i < graded ? gradeFilter(extras.grade, w, h, fps, i) : ''},settb=AVTB[v${i}]`);
    parts.push(c.hasAudio && !e.reverse
      // apad: LTX-Ton ist ~30 ms kürzer als das Bild; ohne Auffüllen läuft der Ton bei jeder Blende weiter vor
      ? `[${i}:a]${aPre}aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${len},apad=whole_dur=${len}[a${i}]`
      : `anullsrc=r=48000:cl=stereo,atrim=duration=${len},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
  });
  const total = round(lengths.reduce((s, l) => s + l, 0) - steps.reduce((s, j) => s + j.duration, 0));
  const fadeIn = extras.fadeIn ?? 0;
  const fadeOut = extras.fadeOut ?? 0;
  if (fadeIn < 0 || fadeOut < 0 || fadeIn + fadeOut > total) throw new PlanError(`Auf- und Abblende zusammen länger als der Schnitt (${total} s)`);

  // Nach dem Schnitt: je Spur eine Kette von Schritten, der letzte schreibt [v] bzw. [a]
  type Step = (src: string, dst: string) => string;
  const vSteps: Step[] = [];
  const aSteps: Step[] = [];
  if (extras.logo) {
    const { input, scale, position } = extras.logo;
    const m = Math.round(w * 0.03);
    const x = position.endsWith('l') ? `${m}` : `main_w-overlay_w-${m}`;
    const y = position.startsWith('t') ? `${m}` : `main_h-overlay_h-${m}`;
    vSteps.push((src, dst) => `[${input}:v]scale=${Math.round(w * scale / 2) * 2}:-1[logo];[${src}][logo]overlay=${x}:${y}:format=auto,format=yuv420p[${dst}]`);
  }
  if (extras.music) {
    const { input, volume, shotVolume } = extras.music;
    aSteps.push((src, dst) => `[${src}]volume=${shotVolume}[as];`
      + `[${input}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${total},`
      + `afade=t=in:d=0.3,afade=t=out:st=${round(Math.max(0, total - 1.5))}:d=1.5,volume=${volume}[am];`
      + `[as][am]amix=inputs=2:duration=first:normalize=0[${dst}]`);
  }
  if (fadeIn || fadeOut) {
    const fx = (f: string) => [fadeIn && `${f}=t=in:st=0:d=${fadeIn}`, fadeOut && `${f}=t=out:st=${round(total - fadeOut)}:d=${fadeOut}`].filter(Boolean).join(',');
    vSteps.push((src, dst) => `[${src}]${fx('fade')}[${dst}]`);
    aSteps.push((src, dst) => `[${src}]${fx('afade')}[${dst}]`);
  }
  const vEnd = vSteps.length ? 'vc' : 'v';
  const aEnd = aSteps.length ? 'ac' : 'a';
  const finish = (): ConcatPlan => {
    const chain = (list: Step[], start: string, final: string, tag: string) =>
      list.forEach((s, i) => parts.push(s(i ? `${tag}${i}` : start, i === list.length - 1 ? final : `${tag}${i + 1}`)));
    chain(vSteps, 'vc', 'v', 'vp');
    chain(aSteps, 'ac', 'a', 'ap');
    return { filter: parts.join(';'), duration: total, width: w, height: h, fps };
  };
  if (steps.every((s) => s.duration === 0)) {
    parts.push(`${clips.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${clips.length}:v=1:a=1[${vEnd}][${aEnd}]`);
    return finish();
  }
  // Kette: Übergang k beginnt am Ende des bisher Zusammengesetzten minus seiner Blende; 0 hängt hart an
  let vPrev = 'v0';
  let aPrev = 'a0';
  let length = lengths[0] as number;
  for (let k = 1; k < clips.length; k++) {
    const last = k === clips.length - 1;
    const vOut = last ? vEnd : `vx${k}`;
    const aOut = last ? aEnd : `ax${k}`;
    const s = steps[k - 1] as Join;
    const f = s.duration;
    parts.push(f > 0
      ? `[${vPrev}][v${k}]xfade=transition=${s.type ?? 'fade'}:duration=${f}:offset=${round(length - f)}[${vOut}]`
      : `[${vPrev}][v${k}]concat=n=2:v=1:a=0[${vOut}]`);
    parts.push(f > 0 ? `[${aPrev}][a${k}]acrossfade=d=${f}[${aOut}]` : `[${aPrev}][a${k}]concat=n=2:v=0:a=1[${aOut}]`);
    length += (lengths[k] as number) - f;
    vPrev = vOut;
    aPrev = aOut;
  }
  return finish();
}

export type CutFormat = 'mp4' | 'webm';

/** Encoder je Ausgabe; die Vorschau ist immer ein schnelles MP4, WebM braucht Opus statt AAC. */
export function encodeArgs(format: CutFormat, preview = false): string[] {
  if (preview) return ['-c:v', 'libx264', '-crf', '28', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'];
  if (format === 'webm') {
    return ['-c:v', 'libvpx-vp9', '-crf', '31', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-pix_fmt', 'yuv420p',
      '-c:a', 'libopus', '-b:a', '160k'];
  }
  return ['-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'];
}

const round = (x: number) => Math.round(x * 1000) / 1000;
