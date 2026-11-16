// Reine Planung für Video-Jobs: Frames finden, Blöcke schneiden, Nummernmuster erkennen. Ohne I/O, darum im Harness.

const FRAME_EXT = /\.(png|jpe?g|tiff?|webp)$/i;

/** * und ? wie im Dateimanager, ohne Groß/klein; alles andere wörtlich. */
export function wildcard(pattern: string): RegExp {
  const body = pattern.trim() || '*';
  return new RegExp(`^${body.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
}

/** Bilddateien, die zum Filter passen, natürlich sortiert (frame_2 vor frame_10). */
export function listFrames(names: string[], pattern: string): string[] {
  const re = wildcard(pattern);
  return names.filter((n) => FRAME_EXT.test(n) && re.test(n))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }));
}

/** Frames je Block nach Zielgröße; gemessen: UHD 25 Frames ≈ 20,7 GB VRAM, darüber CPU-OOM (→ plan_video_upscale). */
export function blockSize(srcW: number, srcH: number, longEdge: number): number {
  const scale = longEdge / Math.max(srcW, srcH, 1);
  const mp = (srcW * scale * srcH * scale) / 1e6;
  return Math.max(4, Math.min(150, Math.floor(BUDGET_MP_FRAMES / Math.max(mp, 0.1))));
}
const BUDGET_MP_FRAMES = 210;

export interface Block {
  /** Vorlauf für den zeitlichen Zusammenhang; wird mitgerechnet, aber nicht gespeichert. */
  ctx: number[];
  frames: number[];
}

/** Nur fehlende Frames, in Läufen am Stück; jeder Block bekommt bis zu ctx Frames Vorlauf aus der Quelle. */
export function planBlocks(total: number, done: (i: number) => boolean, size: number, ctx: number): Block[] {
  const blocks: Block[] = [];
  let cur: number[] = [];
  const flush = () => {
    if (cur.length === 0) return;
    const first = cur[0] as number;
    const pre = Array.from({ length: Math.min(ctx, first) }, (_, k) => first - Math.min(ctx, first) + k);
    blocks.push({ ctx: pre, frames: cur });
    cur = [];
  };
  for (let i = 0; i < total; i++) {
    if (done(i)) { flush(); continue; }
    cur.push(i);
    if (cur.length >= size) flush();
  }
  flush();
  return blocks;
}

/** Muster für ffmpeg, wenn alle Namen gleich aufgebaut und lückenlos nummeriert sind: shot_%04d ab 1. */
export function sequencePattern(bases: string[]): { pattern: string; prefix: string; start: number } | null {
  const parts = bases.map((b) => /^(.*?)(\d+)$/.exec(b));
  const first = parts[0];
  if (!first?.[2]) return null;
  const prefix = first[1] ?? '';
  const width = first[2].length;
  const start = Number(first[2]);
  if (!parts.every((m, i) => m && m[1] === prefix && Number(m[2]) === start + i)) return null;
  const digits = parts.map((m) => m?.[2] ?? '');
  // Gleich breit → %04d; wächst die Breite (9 → 10), nur ohne führende Nullen → %d
  const fmt = digits.every((d) => d.length === width) ? `%0${width}d` : digits.every((d) => !d.startsWith('0')) ? '%d' : null;
  return fmt ? { pattern: `${prefix.replace(/%/g, '%%')}${fmt}`, prefix, start } : null;
}
