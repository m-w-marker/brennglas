import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { contentHash } from './images.ts';

/** Content-Type eines hochgeladenen Videos → Endung der Ablage in data/inputs/. */
export const VIDEO_TYPES: Readonly<Record<string, string>> = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov' };
const EXTS = [...new Set(Object.values(VIDEO_TYPES))];
const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Datei (relativ zu data/) zu einem Video-Feld: Hash = hochgeladenes Video, UUID = Video eines Galerie-Eintrags. */
export function videoInputPath(value: unknown, galleryVideo: (id: string) => string | null, exists: (rel: string) => boolean): string {
  if (typeof value !== 'string') throw new Error('Video erwartet');
  if (HASH.test(value)) {
    const rel = EXTS.map((e) => `inputs/${value}${e}`).find(exists);
    if (!rel) throw new Error('Hochgeladenes Video nicht gefunden – bitte neu hochladen');
    return rel;
  }
  if (UUID.test(value)) {
    const rel = galleryVideo(value);
    if (!rel || !exists(rel)) throw new Error('Dieser Galerie-Eintrag hat kein fertiges Video');
    return rel;
  }
  throw new Error('Video: Galerie-ID oder hochgeladenes Video erwartet');
}

/** Upload ablegen, gleicher Inhalt = gleiche ID; created sagt, ob die Datei erst jetzt entstand (nur dann darf der Aufrufer sie wieder löschen). */
// grenze: Videos bleiben beim Löschen von Einträgen liegen (Parameter werden nicht abgeglichen), aufräumen wenn inputs/ wächst
export function saveVideoInput(dataDir: string, data: Buffer, contentType: string): { inputId: string; rel: string; created: boolean } {
  const ext = VIDEO_TYPES[contentType.split(';')[0]?.trim().toLowerCase() ?? ''];
  if (!ext) throw new Error('Video als MP4, WebM oder MOV erwartet');
  const inputId = contentHash(data);
  const rel = `inputs/${inputId}${ext}`;
  if (existsSync(join(dataDir, rel))) return { inputId, rel, created: false };
  mkdirSync(join(dataDir, 'inputs'), { recursive: true });
  // erst unter Zwischennamen: ein abgebrochenes Schreiben hinterließe sonst eine halbe Datei, die jeder neue Upload als vorhanden nähme
  writeFileSync(join(dataDir, `${rel}.part`), data);
  renameSync(join(dataDir, `${rel}.part`), join(dataDir, rel));
  return { inputId, rel, created: true };
}
