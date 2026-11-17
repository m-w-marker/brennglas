import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

export interface SavedImage {
  outputPath: string;
  previewPath: string;
  thumbPath: string;
  width: number;
  height: number;
}

export interface SavedInput {
  inputId: string;
  inputPath: string;
  inputPreviewPath: string;
  width: number;
  height: number;
}

const PREVIEW = { width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true } as const;
const MAX_INPUT_PIXELS = 100_000_000;
// Alte Uploads tragen eine UUID, neue den Inhalts-Hash
const INPUT_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64})$/;

/** Ausschnitt in voller Auflösung (Anteile 0–1), auf höchstens max px Kante – zum Prüfen von Händen, Gesichtern, Schrift. */
export async function cropRegion(file: string, x: number, y: number, w: number, h: number, max = 1024): Promise<Buffer> {
  const meta = await sharp(file).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const left = Math.min(W - 1, Math.max(0, Math.round(x * W)));
  const top = Math.min(H - 1, Math.max(0, Math.round(y * H)));
  const width = Math.max(1, Math.min(W - left, Math.round(w * W)));
  const height = Math.max(1, Math.min(H - top, Math.round(h * H)));
  return sharp(file).extract({ left, top, width, height })
    .resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true }).webp({ quality: 90 }).toBuffer();
}

/** Original-PNG nur zum Download; angezeigt wird die WebP-Preview (16-MP-PNGs haben 30–50 MB). */
export async function saveOutput(dataDir: string, id: string, png: Buffer): Promise<SavedImage> {
  const rel = { outputPath: `images/${id}.png`, previewPath: `previews/${id}.webp`, thumbPath: `thumbs/${id}.webp` };
  for (const p of Object.values(rel)) mkdirSync(join(dataDir, p, '..'), { recursive: true });

  writeFileSync(join(dataDir, rel.outputPath), png);
  const meta = await sharp(png).metadata();
  await sharp(png).resize(PREVIEW).webp({ quality: 90 }).toFile(join(dataDir, rel.previewPath));
  await sharp(png).resize({ width: 512, height: 512, fit: 'inside' }).webp({ quality: 80 }).toFile(join(dataDir, rel.thumbPath));

  return { ...rel, width: meta.width ?? 0, height: meta.height ?? 0 };
}

/** Upload prüfen und als PNG ablegen; EXIF-Drehung wird dabei angewandt, damit Handyfotos richtig stehen. */
export async function saveInput(dataDir: string, data: Buffer): Promise<SavedInput> {
  let meta;
  try {
    meta = await sharp(data, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    throw new Error('Keine lesbare Bilddatei');
  }
  if (!meta.width || !meta.height) throw new Error('Keine lesbare Bilddatei');

  // Gleicher Inhalt = gleiche ID: ein zweites Hochladen legt keine Kopie an
  const inputId = contentHash(data);
  const rel = { inputPath: `inputs/${inputId}.png`, inputPreviewPath: `inputs/${inputId}.webp` };
  // Die WebP entsteht zuletzt; liegt sie da, ist auch das PNG vollständig geschrieben
  if (existsSync(join(dataDir, rel.inputPreviewPath)) && existsSync(join(dataDir, rel.inputPath))) {
    const have = await sharp(join(dataDir, rel.inputPath)).metadata();
    return { inputId, ...rel, width: have.width ?? 0, height: have.height ?? 0 };
  }
  mkdirSync(join(dataDir, 'inputs'), { recursive: true });
  const png = await sharp(data, { limitInputPixels: MAX_INPUT_PIXELS }).rotate().png().toBuffer({ resolveWithObject: true });
  writeFileSync(join(dataDir, rel.inputPath), png.data);
  await sharp(png.data).resize(PREVIEW).webp({ quality: 90 }).toFile(join(dataDir, rel.inputPreviewPath));
  return { inputId, ...rel, width: png.info.width, height: png.info.height };
}

/** Zielgröße einer Referenz, nur verkleinern; null = unverändert. Ohne maxPixels: H3 sieht höchstens 2048 px kurze Kante. */
export function refSize(w: number, h: number, maxPixels?: number): [number, number] | null {
  const scale = maxPixels ? Math.sqrt(maxPixels / (w * h)) : REF_SHORT_EDGE / Math.min(w, h);
  return scale < 1 ? [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))] : null;
}
const REF_SHORT_EDGE = 2048;

export async function refForComfy(file: string, maxPixels?: number): Promise<Buffer> {
  const meta = await sharp(file).metadata();
  const size = refSize(meta.width ?? 0, meta.height ?? 0, maxPixels);
  return size ? sharp(file).resize(size[0], size[1]).png().toBuffer() : readFileSync(file);
}

/** SHA-256 als Hex; benennt Uploads und die Dateien in ComfyUIs input-Ordner nach Inhalt. */
export function contentHash(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function inputPaths(inputId: string): { inputPath: string; inputPreviewPath: string } | null {
  if (!INPUT_ID.test(inputId)) return null;
  return { inputPath: `inputs/${inputId}.png`, inputPreviewPath: `inputs/${inputId}.webp` };
}
