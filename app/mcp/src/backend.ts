import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join } from 'node:path';
import type { FieldSpec, Figure, FigureRequest, GenerateRequest, Generation, ImageSource, ModelInfo, Page, Text, UploadResult, WorkflowInfo } from '@brennglas/shared';

/** Spricht nur mit dem eigenen Backend, nie direkt mit ComfyUI. */
export const BASE = (process.env.BRENNGLAS_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, init);
  } catch (e) {
    // fetch gibt nach 5 min ohne Antwort auf (z. B. langer Schnitt) – das Backend läuft dann noch
    if ((e as { cause?: { code?: string } }).cause?.code === 'UND_ERR_HEADERS_TIMEOUT') {
      throw new Error(`No answer from the Brennglas backend on ${path} within 5 minutes; it may still finish, check gallery.`);
    }
    throw new Error(`Brennglas backend not reachable at ${BASE} – start it with start.bat (or "pnpm dev" in app/).`);
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status} on ${path}`);
  return body;
}

const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const backend = {
  models: () => call<ModelInfo[]>('/api/models'),
  workflows: () => call<WorkflowInfo[]>('/api/workflows'),
  generate: (req: GenerateRequest) => call<{ id: string }>('/api/generate', json(req)),
  lastFrame: (id: string) => call<UploadResult>(`/api/generations/${encodeURIComponent(id)}/last-frame`, { method: 'POST' }),
  concat: (body: { ids: string[]; fade: number } & Record<string, unknown>) => call<Generation>('/api/concat', json(body)),
  enhance: (req: GenerateRequest) => call<{ text: string }>('/api/enhance', json(req)),
  figures: () => call<Figure[]>('/api/figures'),
  createFigure: (req: FigureRequest) => call<Figure>('/api/figures', json(req)),
  deleteFigure: (id: string) => call<{ ok: true }>(`/api/figures/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  generation: (id: string) => call<Generation>(`/api/generations/${encodeURIComponent(id)}`),
  cancel: (id: string) => call<{ ok: true }>(`/api/generations/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  remove: (id: string) => call<{ ok: true }>(`/api/generations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  gallery: (limit: number, q?: string) => call<Page<Generation>>(`/api/generations?${new URLSearchParams({ limit: String(limit), ...(q ? { q } : {}) })}`),
  async crop(id: string, r: { x: number; y: number; w: number; h: number }): Promise<string> {
    const q = new URLSearchParams({ x: String(r.x), y: String(r.y), w: String(r.w), h: String(r.h) });
    const res = await fetch(`${BASE}/api/images/${encodeURIComponent(id)}/crop?${q}`).catch(() => null);
    if (!res) throw new Error(`Brennglas backend not reachable at ${BASE}`);
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer()).toString('base64');
  },
  async thumb(id: string): Promise<string | null> {
    const res = await fetch(`${BASE}/api/images/${encodeURIComponent(id)}/thumb`).catch(() => null);
    return res?.ok ? Buffer.from(await res.arrayBuffer()).toString('base64') : null;
  },
};

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff' };

/** Galerie-ID bleibt Galerie-ID, „upload:<id>“ (z. B. aus last_frame) ein Upload; ein lokaler Pfad wird hochgeladen. */
export async function toSource(ref: string): Promise<ImageSource> {
  if (ref.startsWith('upload:')) return { kind: 'upload', id: ref.slice(7) };
  if (existsSync(ref)) {
    const type = MIME[extname(ref).toLowerCase()];
    if (!type) throw new Error(`${ref}: unsupported image type (png, jpg, webp, bmp, tif)`);
    const up = await call<UploadResult>('/api/upload', { method: 'POST', headers: { 'content-type': type }, body: readFileSync(ref) });
    return { kind: 'upload', id: up.inputId };
  }
  if (/^[0-9a-f-]{36}$/i.test(ref)) return { kind: 'output', id: ref };
  throw new Error(`${ref}: neither an existing file nor a gallery id`);
}

const VIDEO_MIME: Record<string, string> = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };

/** Wert eines Video-Felds: Galerie-ID oder Upload-ID bleibt, ein lokaler Pfad wird hochgeladen. */
export async function toVideo(ref: string): Promise<string> {
  if (/^[0-9a-f-]{36}$/i.test(ref) || /^[0-9a-f]{64}$/.test(ref)) return ref;
  if (!existsSync(ref)) throw new Error(`${ref}: neither an existing video file nor a gallery id`);
  const type = VIDEO_MIME[extname(ref).toLowerCase()];
  if (!type) throw new Error(`${ref}: unsupported video type (mp4, webm, mov)`);
  const up = await call<UploadResult>('/api/upload', { method: 'POST', headers: { 'content-type': type }, body: readFileSync(ref) });
  return up.inputId;
}

// gleiche Endungen wie isVideoFile im Server (video-plan.ts)
const VIDEO_SOURCE = /\.(mp4|mov|mkv|webm|avi|m4v)$/i;

/** Hochskalieren: Frame-Ordner oder Videodatei → Video-Job, alles andere (Galerie-ID, Upload, Bilddatei) → Bild. */
export function upscaleKind(ref: string): 'video' | 'image' {
  if (!isAbsolute(ref) || !existsSync(ref)) return 'image';
  const s = statSync(ref);
  return s.isDirectory() || (s.isFile() && VIDEO_SOURCE.test(ref)) ? 'video' : 'image';
}

/** Galerie-Video als Datei für den Video-Job; fester Name, damit ein zweiter Lauf im selben Ziel fortsetzt statt abzulehnen. */
export async function galleryVideoFile(id: string): Promise<string> {
  const res = await fetch(`${BASE}/api/images/${encodeURIComponent(id)}/video`).catch(() => null);
  if (!res?.ok) throw new Error(`${id}: no video file in the gallery`);
  const file = join(tmpdir(), `brennglas-${id}${res.headers.get('content-type')?.includes('webm') ? '.webm' : '.mp4'}`);
  if (!existsSync(file)) writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

export const en = (t: Text | undefined): string | undefined => (t === undefined ? undefined : typeof t === 'string' ? t : t.en);

/** Enum-Werte dürfen auch als Anzeigename kommen („Arc left“ statt des ganzen Satzes). */
export function resolveEnum(spec: FieldSpec, raw: string): string {
  if (spec.options?.includes(raw)) return raw;
  const want = raw.trim().toLowerCase();
  const hit = spec.options?.find((o) => {
    const l = spec.optionLabels?.[o];
    return [typeof l === 'string' ? l : l?.en, typeof l === 'string' ? undefined : l?.de].some((x) => x?.toLowerCase() === want);
  });
  if (hit === undefined) throw new Error(`"${raw}" is not an option; use list_models to see the options`);
  return hit;
}
