import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { GenerateRequest, ImageSource, ModelInfo, UploadResult, WorkflowInfo } from '@brennglas/shared';
import type { Workflow } from '../comfy/workflow.ts';
import { concatClips, frameAt } from '../clips.ts';
import { deleteGeneration, finishDone, getChain, getRow, insertGeneration, listGenerations, refsOf, setFavorite, toApi, type DB } from '../db.ts';
import { addClient, broadcast } from '../events.ts';
import { cropRegion, saveInput, saveOutput } from '../images.ts';
import { BadRequest, type Jobs } from '../jobs.ts';
import { missingFiles, type Model } from '../models.ts';
import type { VideoJobs } from '../video.ts';
import { allowedHost, allowedWrite } from '../origin.ts';
import { config } from '../config.ts';

interface Deps {
  db: DB;
  jobs: Jobs;
  video: VideoJobs | null;
  workflows: Map<string, Workflow>;
  models: Model[];
  listFolder: (folder: string) => Promise<string[]>;
  dataDir: string;
}

const KINDS = {
  full: { col: 'output_path', mime: 'image/png' },
  preview: { col: 'preview_path', mime: 'image/webp' },
  thumb: { col: 'thumb_path', mime: 'image/webp' },
  input: { col: 'input_preview_path', mime: 'image/webp' },
} as const;

const MAX_UPLOAD = 100 * 1024 * 1024;

/** Fremde Daten: nur wohlgeformte Quellen durchlassen. */
function parseImages(raw: unknown): ImageSource[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new BadRequest('images muss eine Liste sein');
  return raw.map((x: unknown) => {
    const s = x as { kind?: unknown; id?: unknown; index?: unknown } | null;
    if (typeof s?.id !== 'string') throw new BadRequest('Bildquelle ohne id');
    if (s.kind === 'upload' || s.kind === 'output') return { kind: s.kind, id: s.id };
    if (s.kind === 'input' && typeof s.index === 'number' && Number.isInteger(s.index) && s.index >= 0) return { kind: 'input', id: s.id, index: s.index };
    throw new BadRequest(`Unbekannte Bildquelle ${String(s.kind)}`);
  });
}

export function registerApi(app: FastifyInstance, { db, jobs, video, workflows, models, listFolder, dataDir }: Deps): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!allowedHost(req.headers.host, config.host)) return reply.code(403).send({ error: 'Unbekannter Host abgelehnt' });
    if (!allowedWrite(req.method, req.headers.origin, req.headers.host)) {
      return reply.code(403).send({ error: 'Anfrage von fremder Seite abgelehnt' });
    }
  });

  app.get('/api/models', async (): Promise<ModelInfo[]> => {
    const missing = await missingFiles(models, listFolder).catch(() => null);
    return models.map(({ spec, downloads }) => ({ ...spec, missing: missing?.get(spec.id) ?? null, downloads }));
  });

  app.get('/api/workflows', async (): Promise<WorkflowInfo[]> =>
    [...workflows.values()].map(({ map }) => ({
      name: map.name, label: map.label, submit: map.submit, kind: map.kind, refs: map.refs?.max ?? 0, refToken: map.refs?.token,
      inputs: { ...map.job, ...Object.fromEntries(Object.entries(map.inputs).filter(([, s]) => !s.hidden)) },
    })));

  // Rohdaten statt multipart: der Browser schickt die Datei direkt als Body, ohne Zusatzpaket.
  app.addContentTypeParser(/^image\//, { parseAs: 'buffer', bodyLimit: MAX_UPLOAD }, (_req, body, done) => done(null, body));

  app.post('/api/upload', { bodyLimit: MAX_UPLOAD }, async (req, reply) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return reply.code(415).send({ error: 'Erwartet ein Bild als Body (Content-Type image/…)' });
    }
    try {
      const saved = await saveInput(dataDir, req.body);
      const res: UploadResult = { inputId: saved.inputId, width: saved.width, height: saved.height };
      return res;
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/api/generate', async (req, reply) => {
    const body = req.body as Partial<GenerateRequest> | undefined;
    if (typeof body?.workflow !== 'string' || (body.prompt !== undefined && typeof body.prompt !== 'string')) {
      return reply.code(400).send({ error: 'workflow ist Pflicht, prompt muss Text sein' });
    }
    const params = body.params && typeof body.params === 'object' ? body.params : {};
    try {
      if (video && body.workflow === video.name) return { id: video.create(params) };
      const id = await jobs.create({ workflow: body.workflow, prompt: body.prompt, params, images: parseImages(body.images), series: body.series });
      return { id };
    } catch (e) {
      return reply.code(e instanceof BadRequest ? 400 : 502).send({ error: (e as Error).message });
    }
  });

  app.get('/api/generations', async (req) => {
    const q = req.query as { cursor?: string; limit?: string; q?: string; fav?: string };
    const cursor = q.cursor ? Number(q.cursor) : null;
    const limit = Math.min(Math.max(Number(q.limit) || 40, 1), 200);
    return listGenerations(db, Number.isFinite(cursor) ? cursor : null, limit, { q: q.q, favorite: q.fav === '1' });
  });

  app.get('/api/generations/:id', async (req, reply) => {
    const row = getRow(db, (req.params as { id: string }).id);
    return row ? toApi(row) : reply.code(404).send({ error: 'Nicht gefunden' });
  });

  app.delete('/api/generations/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = getRow(db, id);
    if (!row) return reply.code(404).send({ error: 'Nicht gefunden' });
    if (row.status === 'queued' || row.status === 'running') return reply.code(400).send({ error: 'Läuft noch – erst abbrechen' });
    // Erst die DB, dann die Dateien: bricht das Löschen ab, bleibt höchstens eine verwaiste Datei, nie ein Eintrag ohne Bild
    for (const rel of deleteGeneration(db, id) ?? []) {
      try {
        rmSync(join(dataDir, rel), { force: true });
      } catch (e) {
        console.error('Datei nicht gelöscht:', rel, (e as Error).message);
      }
    }
    broadcast({ type: 'deleted', id });
    return { ok: true };
  });

  app.patch('/api/generations/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const fav = (req.body as { favorite?: unknown } | undefined)?.favorite;
    if (typeof fav !== 'boolean') return reply.code(400).send({ error: 'favorite (true/false) erwartet' });
    if (!setFavorite(db, id, fav)) return reply.code(404).send({ error: 'Nicht gefunden' });
    broadcast({ type: 'favorite', id, favorite: fav });
    return { id, favorite: fav };
  });

  app.post('/api/generations/:id/cancel', async (req, reply) => {
    try {
      const id = (req.params as { id: string }).id;
      if (!(await video?.cancel(id))) await jobs.cancel(id);
      return { ok: true };
    } catch (e) {
      return reply.code(e instanceof BadRequest ? 400 : 502).send({ error: (e as Error).message });
    }
  });

  app.post('/api/enhance', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as GenerateRequest;
      return { text: await jobs.enhance({ ...body, images: parseImages(body.images) }) };
    } catch (e) {
      return reply.code(e instanceof BadRequest ? 400 : 502).send({ error: (e as Error).message });
    }
  });

  /** Video eines fertigen Jobs als Pfad, sonst null. */
  const videoOf = (id: string) => {
    const row = getRow(db, id);
    return row?.status === 'done' && row.video_path && existsSync(join(dataDir, row.video_path)) ? join(dataDir, row.video_path) : null;
  };

  // Anschluss-Shot: der letzte Frame wird ein Eingabebild wie ein Upload
  app.post('/api/generations/:id/last-frame', async (req, reply) => {
    const file = videoOf((req.params as { id: string }).id);
    if (!file) return reply.code(404).send({ error: 'Kein fertiges Video unter dieser ID' });
    try {
      const saved = await saveInput(dataDir, await frameAt(file, null));
      const res: UploadResult = { inputId: saved.inputId, width: saved.width, height: saved.height };
      return res;
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  // Mehrere Shots zu einem Clip; landet als eigener Eintrag in der Galerie
  app.post('/api/concat', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : [];
    const num = (k: string, d: number, min: number, max: number) => {
      const v = body[k];
      return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
    };
    const fade = num('fade', 0, 0, 3);
    if (ids.length < 2 || ids.length > 30) return reply.code(400).send({ error: '2 bis 30 Video-IDs nötig' });
    const files = ids.map(videoOf);
    const fehlt = ids.filter((_, i) => !files[i]);
    if (fehlt.length) return reply.code(400).send({ error: `Kein fertiges Video: ${fehlt.join(', ')}` });
    // Logo und Endkarte: Galerie-ID oder lokaler Pfad; Musik: lokaler Pfad (Backend und Aufrufer sind derselbe Rechner)
    const fileOf = (ref: unknown, image: boolean): string | null | undefined => {
      if (typeof ref !== 'string' || !ref) return undefined;
      const row = image ? getRow(db, ref) : undefined;
      if (row?.status === 'done' && row.output_path) return join(dataDir, row.output_path);
      const ok = image ? /\.(png|jpe?g|webp)$/i.test(ref) : /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(ref);
      return ok && existsSync(ref) && statSync(ref).isFile() ? ref : null;
    };
    const logo = fileOf(body.logo, true);
    const endcard = fileOf(body.endcard, true);
    const music = fileOf(body.music, false);
    const kaputt = [logo === null && 'logo', endcard === null && 'endcard', music === null && 'music'].filter(Boolean);
    if (kaputt.length) return reply.code(400).send({ error: `Nicht gefunden oder falsches Format: ${kaputt.join(', ')}` });
    const position = ['tl', 'tr', 'bl', 'br'].includes(String(body.logoPosition)) ? (body.logoPosition as 'tl' | 'tr' | 'bl' | 'br') : 'br';
    const id = randomUUID();
    const videoPath = `videos/${id}.mp4`;
    const started = Date.now();
    try {
      mkdirSync(join(dataDir, 'videos'), { recursive: true });
      const plan = await concatClips(files as string[], {
        fade,
        ...(endcard ? { endcard: { file: endcard, seconds: num('endcardSeconds', 2, 0.5, 10) } } : {}),
        ...(music ? { music: { file: music, volume: num('musicVolume', 0.8, 0, 2), shotVolume: num('shotVolume', 0.35, 0, 1) } } : {}),
        ...(logo ? { logo: { file: logo, scale: num('logoScale', 0.12, 0.03, 0.5), position } } : {}),
      }, join(dataDir, videoPath));
      const saved = await saveOutput(dataDir, id, await frameAt(join(dataDir, videoPath), plan.duration / 2));
      const extra = [music && 'Musik', logo && 'Logo', endcard && 'Endkarte'].filter(Boolean).join(', ');
      insertGeneration(db, {
        id, workflow: 'concat', prompt: `Schnitt aus ${ids.length} Shots${extra ? ` mit ${extra}` : ''}`,
        params: { shots: ids.join(','), fade, ...(music ? { music } : {}), ...(logo ? { logo } : {}), ...(endcard ? { endcard } : {}) },
        parentId: ids[0] ?? null,
      });
      finishDone(db, id, { ...saved, videoPath, expandedPrompt: null, durationMs: Date.now() - started });
      const row = getRow(db, id);
      if (row) broadcast({ type: 'done', generation: toApi(row) });
      return row ? toApi(row) : { id };
    } catch (e) {
      rmSync(join(dataDir, videoPath), { force: true });
      return reply.code(/Überblendung|Mindestens/.test((e as Error).message) ? 400 : 502).send({ error: (e as Error).message });
    }
  });

  app.get('/api/queue', async (_req, reply) => {
    try {
      return await jobs.queueList();
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  app.post('/api/generations/:id/front', async (req, reply) => {
    try {
      await jobs.toFront((req.params as { id: string }).id);
      return { ok: true };
    } catch (e) {
      return reply.code(e instanceof BadRequest ? 400 : 502).send({ error: (e as Error).message });
    }
  });

  app.get('/api/comfy/memory', async (_req, reply) => {
    try {
      return await jobs.memory();
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  app.post('/api/comfy/free', async (_req, reply) => {
    try {
      await jobs.freeVram();
      return { ok: true };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  app.get('/api/generations/:id/chain', async (req) => getChain(db, (req.params as { id: string }).id));

  app.get('/api/images/:id/ref/:n', async (req, reply) => {
    const { id, n } = req.params as { id: string; n: string };
    const row = getRow(db, id);
    const ref = row ? refsOf(row)[Number(n) - 1] : undefined;
    const file = ref ? join(dataDir, ref.preview) : undefined;
    if (!file || !existsSync(file)) return reply.code(404).send({ error: 'Bild nicht gefunden' });
    return reply.type('image/webp').header('cache-control', 'public, max-age=31536000, immutable').send(createReadStream(file));
  });

  // Mit Range-Anfragen, sonst kann der Browser im Video nicht springen
  app.get('/api/images/:id/video', async (req, reply) => {
    const rel = getRow(db, (req.params as { id: string }).id)?.video_path;
    const file = rel ? join(dataDir, rel) : undefined;
    if (!file || !existsSync(file)) return reply.code(404).send({ error: 'Video nicht gefunden' });
    const size = statSync(file).size;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    reply.type(file.endsWith('.webm') ? 'video/webm' : 'video/mp4').header('accept-ranges', 'bytes');
    if (!m || (m[1] === '' && m[2] === '')) return reply.header('content-length', size).send(createReadStream(file));
    const start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
    const end = m[1] !== '' && m[2] !== '' ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) return reply.code(416).header('content-range', `bytes */${size}`).send();
    return reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', end - start + 1)
      .send(createReadStream(file, { start, end }));
  });

  // Ausschnitt in voller Auflösung, z. B. damit Claude per MCP Hände und Gesichter prüfen kann
  app.get('/api/images/:id/crop', async (req, reply) => {
    const rel = getRow(db, (req.params as { id: string }).id)?.output_path;
    const file = rel ? join(dataDir, rel) : undefined;
    if (!file || !existsSync(file)) return reply.code(404).send({ error: 'Bild nicht gefunden' });
    const q = req.query as Record<string, string | undefined>;
    const f = (k: string, d: number) => { const v = Number(q[k]); return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d; };
    try {
      return reply.type('image/webp').send(await cropRegion(file, f('x', 0), f('y', 0), f('w', 1) || 1, f('h', 1) || 1));
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.get('/api/images/:id/:kind', async (req, reply) => {
    const { id, kind } = req.params as { id: string; kind: string };
    const k = KINDS[kind as keyof typeof KINDS];
    const rel = k ? getRow(db, id)?.[k.col] : undefined;
    const file = rel ? join(dataDir, rel) : undefined;
    if (!k || !file || !existsSync(file)) return reply.code(404).send({ error: 'Bild nicht gefunden' });
    return reply
      .type(k.mime)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(createReadStream(file));
  });

  app.get('/api/events', (req, reply) => {
    reply.hijack();
    addClient(reply.raw);
  });

  // Öffnet den Bilderordner im Dateimanager des Rechners, auf dem das Backend läuft; mit id ist die Datei markiert.
  app.post('/api/open-folder', async (req, reply) => {
    const id = (req.body as { id?: unknown } | undefined)?.id;
    const row = typeof id === 'string' ? getRow(db, id) : undefined;
    // Video: der Zielordner des Shots, nicht die Vorschau in data/
    const shot = row && row.workflow === video?.name ? toApi(row).params.dst : undefined;
    const dir = typeof shot === 'string' && existsSync(shot) ? shot : join(dataDir, 'images');
    mkdirSync(dir, { recursive: true });
    const rel = shot === undefined ? row?.output_path : undefined;
    const file = rel && existsSync(join(dataDir, rel)) ? join(dataDir, rel) : null;
    // explorer braucht /select,"pfad" als ein Argument, darum wörtlich übergeben und selbst quoten
    const [cmd, args]: [string, string[]] = process.platform === 'win32'
      ? ['explorer.exe', [file ? `/select,"${file}"` : `"${dir}"`]]
      : process.platform === 'darwin' ? ['open', file ? ['-R', file] : [dir]] : ['xdg-open', [dir]];
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
      child.on('error', (e) => console.error('Ordner öffnen:', e.message)); // ohne Listener reißt ENOENT den Server mit
      child.unref();
      return { ok: true };
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  app.get('/api/health', async () => jobs.health());
}
