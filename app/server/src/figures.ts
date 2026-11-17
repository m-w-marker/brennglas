import sharp from 'sharp';
import type { FigureKind } from '@brennglas/shared';

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

/** Blatt per Edit: Bild 1 ist die leere 16:9-Fläche, Bild 2 Porträt oder Packshot; extra = Kleidung bzw. unsichtbare Details. → plan_referenz */
export function sheetPrompt(kind: FigureKind, token: string, extra?: string): string {
  const canvas = imageToken(token, 1);
  const ref = imageToken(token, 2);
  const frame = `on a plain light grey studio background, even soft lighting, no text, no labels. Four views side by side, same scale:`;
  if (kind === 'product') {
    return `Turn ${canvas} into a clean product reference sheet of the product from ${ref}, ${frame} (1) front view, (2) side view, `
      + `(3) back view, (4) close-up of its most characteristic detail. Exactly the same product as in ${ref}: same shape, `
      + `proportions, colours, materials, logo and markings.${extra ? ` Details not visible in ${ref}: ${extra}.` : ''}`;
  }
  return `Turn ${canvas} into a clean character reference sheet of the person from ${ref}, ${frame} (1) front close-up portrait `
    + `of the face, (2) three-quarter view head and shoulders, (3) side profile head and shoulders, (4) full body standing front `
    + `view. Exactly the same person as in ${ref}: same face, hair, eye colour, skin details such as freckles, accessories and `
    + `clothing.${extra ? ` In the full body view the person wears ${extra}.` : ''}`;
}

export interface SceneFigure {
  name: string;
  kind: FigureKind;
}

/** Szene aus Figuren: Bild 1 leere Fläche, je Figur Porträt + Blatt (Bild 2/3, 4/5 …), danach weitere Bilder. */
export function scenePrompt(figures: SceneFigure[], token: string, extra: number, scene: string): string {
  const roles = figures.map((f, i) => {
    const [a, b] = [imageToken(token, 2 + 2 * i), imageToken(token, 3 + 2 * i)];
    return f.kind === 'person'
      ? `${a} and ${b} show ${f.name} (portrait and character sheet of the same person).`
      : `${a} and ${b} show the product ${f.name} (packshot and product sheet of the same product).`;
  });
  const first = 2 + 2 * figures.length;
  const more = Array.from({ length: extra }, (_, i) => imageToken(token, first + i));
  return [
    `Create a new photo on the empty grey canvas ${imageToken(token, 1)}; no grey canvas remains.`,
    ...roles,
    'Keep every identity exactly: people keep the same face, hair, eye colour, skin details, accessories and clothing; '
      + 'products keep the same shape, proportions, colours, materials and logo.',
    ...(more.length ? [`Further references: ${more.join(', ')}.`] : []),
    `Scene: ${scene}`,
  ].join(' ');
}
