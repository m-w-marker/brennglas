import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { SHEET_PANELS, SHEET_SIZE, type FigureKind, type SheetPanel } from '@brennglas/shared';

/** Leere Fläche ~1 MP im Raster 32; die Workflows skalieren selbst auf ihre MP, es zählt nur das Seitenverhältnis. */
export function blankSize(aspect: number): [number, number] {
  const side = (v: number) => Math.max(32, Math.round(v / 32) * 32);
  return [side(Math.sqrt(1_048_576 * aspect)), side(Math.sqrt(1_048_576 / aspect))];
}

export function blankPng(aspect: number): Promise<Buffer> {
  const [width, height] = blankSize(aspect);
  return sharp({ create: { width, height, channels: 3, background: '#d9d9d9' } }).png().toBuffer();
}

/** Bild n (ab 1) im Prompt, Schreibweise aus refs.token der Map: {n} zählt ab 1, {i} ab 0. */
export const imageToken = (token: string, n: number) => token.replace('{n}', String(n)).replace('{i}', String(n - 1));

// Kurz und positiv: lange Aufzählungen und Verbote machten FLUX unruhig, es erfand Riemen, Aufdrucke, Schrift (gemessen 23.11.2026)
const SHEET_LOOK = 'Natural studio lighting, detailed textures, sharp focus, clean seamless white background, no text or labels.';

/** Blatt per Edit: Bild 1 die Vorlage der Art, Bild 2 Porträt oder Packshot, danach `views` weitere Fotos derselben Figur;
 *  detail = Kleidung bzw. Details, die das Foto nicht zeigt. Stil kommt aus dem Porträt. → plan_figurenblatt */
export function sheetPrompt(kind: FigureKind, token: string, detail?: string, views = 0, template = true): string {
  const tpl = imageToken(token, 1);
  const ref = imageToken(token, 2);
  const noun = kind === 'person' ? 'character' : kind;
  const more = Array.from({ length: views }, (_, i) => imageToken(token, 3 + i));
  const further = more.length ? ` ${more.join(', ')} ${more.length > 1 ? 'show' : 'shows'} further views of the same ${noun}.` : '';
  if (!template) return freeSheetPrompt(kind, tpl, ref, further, detail);
  const place = `Use ${tpl} strictly for the placement of the four views on a clean white background`;
  const style = `in the same style as ${ref}`;
  if (kind === 'product') {
    // Kein „logo“, kein „characteristic detail“: beides ließ FLUX Schrift und Plaketten erfinden
    return `${place}, ignoring the shape of its grey patches, and generate a product reference sheet of the product from ${ref}, `
      + `${style}. Arrange the four views from left to right: 1) front view, 2) three-quarter (45-degree) view, 3) back view, `
      + `4) large close-up of a detail that is clearly visible in ${ref}, such as its material, a seam or a fitting. Keep the shape, `
      + `proportions, colours and materials exactly as in ${ref} and copy every surface as it appears there.${further}`
      + `${detail ? ` Details not visible in ${ref}: ${detail}.` : ''} ${SHEET_LOOK}`;
  }
  if (kind === 'creature') {
    return `${place} in a 2 × 2 grid, ignoring the shape of its grey patches, and generate a creature reference sheet of the `
      + `creature from ${ref}, ${style}. Arrange the four views: 1) top left, full body front view, 2) top right, full body side view `
      + `in exact profile facing right, 3) bottom left, full body back view, 4) bottom right, head close-up in three-quarter view. `
      + `Keep the anatomy, body shape, colours and markings from ${ref} consistent across all views.${further}`
      + `${detail ? ` Details not visible in ${ref}: ${detail}.` : ''} ${SHEET_LOOK}`;
  }
  return `${place}, ignoring its body shapes and proportions, and generate a character reference sheet of the character `
    + `from ${ref}, ${style}. Arrange the four views from left to right matching the layout of ${tpl}: 1) full body frontal view, `
    + `2) full body back view, 3) medium shot from the waist up in three-quarter (45-degree) view, cropped by the bottom edge, `
    + `4) close-up of the head and shoulders with the face turned slightly to the right, the shoulders `
    + `continuing out of the bottom edge. Keep the identity, facial features, hair and body build from ${ref} consistent across all views.`
    + `${further}${detail ? ` The character is wearing ${detail}.` : ''} ${SHEET_LOOK}`;
}

/** Ohne Vorlage: Bild 1 ist eine weiße Fläche, Lage und Größe der Felder stehen nur im Text (Person: Variante A des Benchmarks). */
function freeSheetPrompt(kind: FigureKind, canvas: string, ref: string, further: string, detail?: string): string {
  const fill = `Use ${canvas} as an empty white canvas and fill it with`;
  if (kind === 'product') {
    return `${fill} a product reference sheet of the product from ${ref}, in the same style as ${ref}. Four views side by side from `
      + `left to right, each filling one quarter of the width: 1) front view, 2) three-quarter (45-degree) view, 3) back view, `
      + `4) large close-up of a detail that is clearly visible in ${ref}, such as its material, a seam or a fitting. Keep the shape, `
      + `proportions, colours and materials exactly as in ${ref}.${further}${detail ? ` Details not visible in ${ref}: ${detail}.` : ''} ${SHEET_LOOK}`;
  }
  if (kind === 'creature') {
    return `${fill} a creature reference sheet of the creature from ${ref}, in the same style as ${ref}, as a 2 × 2 grid of equal `
      + `cells: 1) top left, full body front view, 2) top right, full body side view in exact profile facing right, 3) bottom left, `
      + `full body back view, 4) bottom right, head close-up in three-quarter view. Keep the anatomy, body shape, colours and markings `
      + `from ${ref} consistent across all views.${further}${detail ? ` Details not visible in ${ref}: ${detail}.` : ''} ${SHEET_LOOK}`;
  }
  return `${fill} a character reference sheet of the character from ${ref}, in the same style as ${ref}. `
    + `Four views side by side from left to right, each filling one quarter of the width and the full height of the canvas: `
    + `1) full body frontal view from head to feet, 2) full body back view from head to feet, `
    + `3) medium shot from the waist up in three-quarter (45-degree) view, larger, cropped by the bottom edge, `
    + `4) close-up of the head and shoulders with the face turned slightly to the right, largest, the shoulders continuing out of the bottom edge. `
    + `Keep the identity, facial features, hair, body build and clothing from ${ref} consistent across all views.`
    + `${further}${detail ? ` The character is wearing ${detail}.` : ''} ${SHEET_LOOK}`;
}

/** Warum ein vorhandenes Bild nicht als Blatt einer neuen Figur taugt, sonst null; refs = Zahl der Referenzen, owner = Figur, die es schon nutzt. */
export function sheetProblem(status: string | undefined, refs: number, owner: string | null): string | null {
  if (status === undefined) return 'Blatt nicht gefunden';
  if (status !== 'done') return 'Das Blatt ist noch nicht fertig oder gescheitert';
  if (owner) return `Das Blatt gehört schon zur Figur „${owner}“`;
  // Szenen holen das Porträt als Referenz 1 des Blatts
  if (refs < 1) return 'Das Bild ist kein Figurenblatt (Porträt fehlt)';
  return null;
}

/** Vorlage der Art, liegt neben den Beispielbildern; `sheet-<art>.<workflow>.png` geht vor (FLUX braucht scharfe Formen). */
export function templateFile(samplesDir: string, kind: FigureKind, workflow?: string): string {
  const own = workflow ? join(samplesDir, `sheet-${kind}.${workflow}.png`) : '';
  return own && existsSync(own) ? own : join(samplesDir, `sheet-${kind}.png`);
}

/** Bild ins Feld einpassen: ganz sichtbar, unverzerrt, mittig; abgerundet nach innen, damit es nie ins Nachbarfeld ragt. */
export function fitInto(w: number, h: number, p: SheetPanel): { left: number; top: number; width: number; height: number } {
  const s = Math.min(p.w / w, p.h / h);
  const width = Math.max(1, Math.floor(w * s));
  const height = Math.max(1, Math.floor(h * s));
  return { left: p.x + Math.floor((p.w - width) / 2), top: p.y + Math.floor((p.h - height) / 2), width, height };
}

/** Ein Foto je Feld zu einem Blatt auf Weiß. */
export async function composeSheet(kind: FigureKind, images: Buffer[]): Promise<Buffer> {
  const panels = SHEET_PANELS[kind];
  if (images.length !== panels.length) throw new Error(`Je Feld ein Foto, ${panels.length} erwartet`);
  const layers = await Promise.all(images.map(async (img, i) => {
    const meta = await sharp(img).metadata();
    const at = fitInto(meta.width ?? 1, meta.height ?? 1, panels[i] as SheetPanel);
    return { input: await sharp(img).resize(at.width, at.height, { fit: 'fill' }).png().toBuffer(), left: at.left, top: at.top };
  }));
  return sharp({ create: { ...SHEET_SIZE, channels: 3, background: '#ffffff' } }).composite(layers).png().toBuffer();
}

export interface SceneFigure {
  name: string;
  kind: FigureKind;
}

/** Szene aus Figuren: Bild 1 leere Fläche, je Figur Porträt + Blatt (Bild 2/3, 4/5 …), danach weitere Bilder. */
export function scenePrompt(figures: SceneFigure[], token: string, extra: number, scene: string): string {
  const roles = figures.map((f, i) => {
    const [a, b] = [imageToken(token, 2 + 2 * i), imageToken(token, 3 + 2 * i)];
    return f.kind === 'person' ? `${a} and ${b} show ${f.name} (portrait and character sheet of the same person).`
      : f.kind === 'creature' ? `${a} and ${b} show the creature ${f.name} (portrait and reference sheet of the same creature).`
      : `${a} and ${b} show the product ${f.name} (packshot and product sheet of the same product).`;
  });
  const first = 2 + 2 * figures.length;
  const more = Array.from({ length: extra }, (_, i) => imageToken(token, first + i));
  return [
    `Create a new photo on the empty grey canvas ${imageToken(token, 1)}; no grey canvas remains.`,
    ...roles,
    'Keep every identity exactly: people keep the same face, hair, eye colour, skin details, accessories and clothing; '
      + (figures.some((f) => f.kind === 'creature') ? 'creatures keep the same anatomy, colours and markings; ' : '')
      + 'products keep the same shape, proportions, colours, materials and logo.',
    ...(more.length ? [`Further references: ${more.join(', ')}.`] : []),
    `Scene: ${scene}`,
  ].join(' ');
}
