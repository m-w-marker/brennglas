import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, truncateSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebStream } from 'node:stream/web';
import type { ModelSpec } from '@brennglas/shared';
import { loadLoras } from '../comfy/workflow.ts';
import { loadDownloads, requiredFiles } from '../models.ts';

export interface CatalogFile {
  key: string; // ordner/datei, wie in downloads.json
  folder: string;
  name: string;
  url: string | null;
  gated: boolean;
}

export interface CatalogModel {
  spec: ModelSpec;
  files: CatalogFile[];
}

/** Modelle mit ihren Dateien, abgelesen aus den Loadern der Workflows (wie models.ts), dazu die Links und Grund-LoRAs. */
export function catalog(appDir: string): CatalogModel[] {
  const json = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));
  const links = loadDownloads(join(appDir, 'models'));
  const loras = loadLoras(join(appDir, 'models'));
  return readdirSync(join(appDir, 'models')).filter((f) => f.endsWith('.model.json'))
    .map((f) => json(join(appDir, 'models', f)) as ModelSpec)
    .sort((a, b) => a.order - b.order)
    .map((spec) => {
      const files = new Map<string, CatalogFile>();
      for (const wf of Object.values(spec.modes)) {
        if (!wf) continue;
        for (const d of requiredFiles(json(join(appDir, 'workflows', `${wf}.api.json`)) as Parameters<typeof requiredFiles>[0])) {
          const key = `${d.folder}/${d.name}`;
          files.set(key, { key, folder: d.folder, name: d.name, url: links[key]?.url ?? null, gated: links[key]?.gated === true });
        }
      }
      // Grund-LoRAs kommen ohne Abfrage mit (Entscheidung 18.11.2026, zusammen ~3 GB)
      for (const [name, e] of Object.entries(loras)) {
        const key = `loras/${name}`;
        if (e.model === spec.id && e.url) files.set(key, { key, folder: 'loras', name, url: e.url, gated: false });
      }
      return { spec, files: [...files.values()] };
    });
}

/** Liegt die Datei fertig im ComfyUI-Modellordner? Eine halbe .part zählt nicht. */
export function isPresent(modelsDir: string, f: CatalogFile): boolean {
  const p = join(modelsDir, f.folder, f.name);
  return existsSync(p) && statSync(p).size > 0;
}

/** Was für die Auswahl noch zu laden ist; eine Datei, die mehrere Modelle teilen, nur einmal. */
export function filesToLoad(modelsDir: string, chosen: CatalogModel[]): CatalogFile[] {
  const out = new Map<string, CatalogFile>();
  for (const m of chosen) for (const f of m.files) if (!isPresent(modelsDir, f)) out.set(f.key, f);
  return [...out.values()];
}

export class GatedError extends Error {}

const auth = (token?: string): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {});

function gated(res: Response): boolean {
  return res.status === 401 || res.status === 403 || res.headers.get('x-error-code') === 'GatedRepo';
}

/** Größe ohne Download; Hugging Face nennt sie vor der Weiterleitung als X-Linked-Size. null = unbekannt. */
export async function remoteSize(url: string, token?: string): Promise<number | null> {
  try {
    // Umbenannte Repos leiten erst per 307 weiter, die Größe steht erst an der Weiterleitung zur Datei.
    for (let hop = 0, next = url; hop < 5; hop++) {
      const res = await fetch(next, { method: 'HEAD', redirect: 'manual', headers: auth(token) });
      if (gated(res)) return null;
      const n = Number(res.headers.get('x-linked-size') ?? (res.status === 200 ? res.headers.get('content-length') : NaN));
      if (Number.isFinite(n) && n > 0) return n;
      const location = res.headers.get('location');
      if (res.status < 300 || res.status >= 400 || !location) return null;
      next = new URL(location, next).href;
    }
    return null;
  } catch {
    return null;
  }
}

/** Lädt nach dest; eine vorhandene dest.part wird fortgesetzt. Erst die vollständige Datei bekommt ihren Namen. */
export async function download(url: string, dest: string, token?: string, onBytes?: (done: number, total: number | null) => void): Promise<void> {
  const part = `${dest}.part`;
  mkdirSync(dirname(dest), { recursive: true });
  const have = existsSync(part) ? statSync(part).size : 0;
  const res = await fetch(url, { headers: { ...auth(token), ...(have ? { Range: `bytes=${have}-` } : {}) } });
  if (gated(res)) throw new GatedError(url);
  if (res.status === 416 && have) {
    // Range hinter dem Ende: die .part ist schon komplett, wenn sie so groß ist wie der Server sagt, sonst neu laden.
    const total = Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1]);
    if (total === have) return renameSync(part, dest);
    truncateSync(part, 0);
    return download(url, dest, token, onBytes);
  }
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  // Ignoriert der Server Range und schickt alles, beginnt die .part von vorn statt doppelt zu werden.
  const resumed = res.status === 206;
  if (have && !resumed) truncateSync(part, 0);
  const start = resumed ? have : 0;
  const length = Number(res.headers.get('content-length'));
  const total = Number.isFinite(length) && length > 0 ? start + length : null;
  let done = start;
  const body = Readable.fromWeb(res.body as WebStream<Uint8Array>);
  body.on('data', (c: Buffer) => { done += c.length; onBytes?.(done, total); });
  await pipeline(body, createWriteStream(part, { flags: 'a' }));
  const size = statSync(part).size;
  if (total !== null && size !== total) throw new Error(`incomplete: ${size} of ${total} bytes for ${url}`);
  renameSync(part, dest);
}
