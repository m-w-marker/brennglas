import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import sharp from 'sharp';
import { MAX_EXTRA_VIEWS, parseEditProject, SHEET_PANELS, SHEET_SIZE, sheetTemplateDefault } from '@brennglas/shared';
import type { ClaudeConfig, FigureKind, FigureSheetRequest, GenerateRequest, ImageSource, ModelInfo, UploadResult, WorkflowInfo } from '@brennglas/shared';
import type { Workflow } from '../comfy/workflow.ts';
import { concatClips, frameAt, probe, type ConcatOptions } from '../clips.ts';
import { saveVideoInput } from '../video-input.ts';
import { PlanError, TRANSITIONS, type CutFormat, type Join, type ShotEdit, type Transition } from '../concat-plan.ts';
import {
  deleteFigure, deleteGeneration, figureUsing, finishDone, getChain, getRow, insertFigure, insertGeneration, listFigures, listGenerations,
  refsOf, setFavorite, toApi, durationStats, usedWorkflows, type DB,
} from '../db.ts';
import { composeSheet, sheetProblem, sheetPrompt, templateFile } from '../figures.ts';
import { addClient, broadcast } from '../events.ts';
import { cropRegion, inputPaths, saveInput, saveOutput } from '../images.ts';
import { BadRequest, type Jobs } from '../jobs.ts';
import { missingFiles, type Model } from '../models.ts';
import type { Loras } from '../loras.ts';
import type { VideoJobs } from '../video.ts';
import { allowedHost, allowedWrite } from '../origin.ts';
import { APP_DIR, config } from '../config.ts';

interface Deps {
  db: DB;
  jobs: Jobs;
  video: VideoJobs | null;
  workflows: Map<string, Workflow>;
  models: Model[];
  loras: Loras;
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
const AUDIO_EXT: Record<string, string> = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/vnd.wave': 'wav',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/x-aac': 'aac', 'audio/vnd.dlna.adts': 'aac',
  'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/ogg': 'ogg',
};

/** Video mit Range-Anfragen, sonst kann der Player nicht springen. */
function sendVideo(range: string | undefined, reply: FastifyReply, file: string) {
  const size = statSync(file).size;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range ?? '');
  reply.type(file.endsWith('.webm') ? 'video/webm' : 'video/mp4').header('accept-ranges', 'bytes');
  if (!m || (m[1] === '' && m[2] === '')) return reply.header('content-length', size).send(createReadStream(file));
  const start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
  const end = m[1] !== '' && m[2] !== '' ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start > end || start >= size) return reply.code(416).header('content-range', `bytes */${size}`).send();
  return reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', end - start + 1)
    .send(createReadStream(file, { start, end }));
}

/** Fremde Daten: nur wohlgeformte Quellen durchlassen. */
function parseImages(raw: unknown): ImageSource[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new BadRequest('images muss eine Liste sein');
  return raw.map((x: unknown) => {
    const s = x as { kind?: unknown; id?: unknown; index?: unknown; aspect?: unknown } | null;
    if (s?.kind === 'blank' && typeof s.aspect === 'number') return { kind: 'blank', aspect: s.aspect };
    if (typeof s?.id !== 'string') throw new BadRequest('Bildquelle ohne id');
    if (s.kind === 'upload' || s.kind === 'output') return { kind: s.kind, id: s.id };
    if (s.kind === 'input' && typeof s.index === 'number' && Number.isInteger(s.index) && s.index >= 0) return { kind: 'input', id: s.id, index: s.index };
    throw new BadRequest(`Unbekannte Bildquelle ${String(s.kind)}`);
  });
}

export function registerApi(app: FastifyInstance, { db, jobs, video, workflows, models, loras, listFolder, dataDir }: Deps): void {
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

  app.get('/api/workflows', async (): Promise<WorkflowInfo[]> => {
    // Hängt ComfyUI, lädt die Seite nach 2 s trotzdem – mit der LoRA-Auswahl vom letzten Mal
    await Promise.race([loras.refresh(workflows.values()), new Promise((r) => setTimeout(r, 2000))]);
    return [...workflows.values()].map(({ map }) => ({
      name: map.name, label: map.label, submit: map.submit, kind: map.kind, refs: map.refs?.max ?? 0, refToken: map.refs?.token,
      inputs: { ...map.job, ...Object.fromEntries(Object.entries(map.inputs).filter(([, s]) => !s.hidden)) },
    }));
  });

  // Hilfe „Mit Claude verbinden“: process.execPath ist das Node, das gerade läuft (auch das portable des Installers)
  app.get('/api/claude-config', async (): Promise<ClaudeConfig> => ({ node: process.execPath, script: join(APP_DIR, 'mcp', 'src', 'index.ts') }));

  // Beim Öffnen der Auswahl: eigene LoRAs, die seit dem Laden der Seite dazugekommen sind
  app.get<{ Params: { workflow: string } }>('/api/loras/:workflow', async (req, reply) => {
    const wf = workflows.get(req.params.workflow);
    const spec = wf && Object.values(wf.map.inputs).find((x) => x.loras);
    if (!wf || !spec) return reply.code(404).send({ error: 'Workflow ohne LoRA-Auswahl' });
    await loras.refresh([wf]);
    return { options: spec.options ?? [], optionLabels: spec.optionLabels ?? {}, triggers: spec.triggers ?? {} };
  });

  // Rohdaten statt multipart: der Browser schickt die Datei direkt als Body, ohne Zusatzpaket.
  app.addContentTypeParser(/^(image|video)\//, { parseAs: 'buffer', bodyLimit: MAX_UPLOAD }, (_req, body, done) => done(null, body));

  app.post('/api/upload', { bodyLimit: MAX_UPLOAD }, async (req, reply) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return reply.code(415).send({ error: 'Erwartet ein Bild oder Video als Body (Content-Type image/… oder video/…)' });
    }
    // Layout-Videos: Ablage nach Inhalt, ffprobe prüft, dass es wirklich ein Video ist
    const type = String(req.headers['content-type'] ?? '');
    if (type.startsWith('video/')) {
      try {
        const saved = saveVideoInput(dataDir, req.body, type);
        const info = await probe(join(dataDir, saved.rel)).catch((e: unknown) => {
          // nur Neues wegräumen: ein schon vorhandenes Video kann an Galerie-Einträgen hängen
          if (saved.created) rmSync(join(dataDir, saved.rel), { force: true });
          throw e;
        });
        const res: UploadResult = { inputId: saved.inputId, width: info.width, height: info.height };
        return res;
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    }
    try {
      const saved = await saveInput(dataDir, req.body);
      const res: UploadResult = { inputId: saved.inputId, width: saved.width, height: saved.height };
      return res;
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // Musik für den Schnitt, ebenfalls als Rohdaten; die Antwort ist der Pfad, den /api/concat als music nimmt
  app.addContentTypeParser(/^audio\//, { parseAs: 'buffer', bodyLimit: MAX_UPLOAD }, (_req, body, done) => done(null, body));
  app.post('/api/audio', { bodyLimit: MAX_UPLOAD }, async (req, reply) => {
    const ext = AUDIO_EXT[String(req.headers['content-type']).split(';')[0]?.trim() ?? ''];
    if (!ext || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      return reply.code(415).send({ error: 'Erwartet eine Tondatei (mp3, wav, m4a, aac, flac, ogg)' });
    }
    mkdirSync(join(dataDir, 'audio'), { recursive: true });
    const file = join(dataDir, 'audio', `${createHash('sha256').update(req.body).digest('hex').slice(0, 32)}.${ext}`);
    if (!existsSync(file)) writeFileSync(file, req.body);
    return { path: file };
  });

  app.post('/api/generate', async (req, reply) => {
    const body = req.body as Partial<GenerateRequest> | undefined;
    if (typeof body?.workflow !== 'string' || (body.prompt !== undefined && typeof body.prompt !== 'string')) {
      return reply.code(400).send({ error: 'workflow ist Pflicht, prompt muss Text sein' });
    }
    const params = body.params && typeof body.params === 'object' ? body.params : {};
    try {
      if (video && body.workflow === video.name) {
        if (body.figures?.length) return reply.code(400).send({ error: 'Video-Upscale kann keine Figuren in Szenen setzen' });
        return { id: video.create(params) };
      }
      const figures = Array.isArray(body.figures) ? body.figures.filter((x): x is string => typeof x === 'string') : undefined;
      const aspect = typeof body.aspect === 'number' ? body.aspect : undefined;
      const id = await jobs.create({
        workflow: body.workflow, prompt: body.prompt, params, images: parseImages(body.images), series: body.series, figures, aspect,
      });
      return { id };
    } catch (e) {
      return reply.code(e instanceof BadRequest ? 400 : 502).send({ error: (e as Error).message });
    }
  });

  app.get('/api/figures', async () => listFigures(db));

  // FLUX zeichnet Blätter erst in 4 MP sauber (Büste statt Schultern, grobe kleine Gesichter in 2 MP, gemessen 23.11.2026)
  const SHEET_MEGAPIXELS: Record<string, number> = { 'flux3-edit': 4 };

  const parseKind = (k: unknown): FigureKind => {
    if (k === 'person' || k === 'creature' || k === 'product') return k;
    throw new BadRequest('kind: person, creature oder product');
  };

  /** Blatt als Galerie-Eintrag, Porträt als Referenz 1: fertiges Blatt, Fotos je Feld oder per Modell auf der Vorlage. → plan_figurenblatt */
  async function makeSheet(body: Partial<FigureSheetRequest>): Promise<string> {
    const kind = parseKind(body.kind);
    const map = typeof body.workflow === 'string' ? workflows.get(body.workflow)?.map : undefined;
    if (!map || !('prompt' in map.inputs) || !map.refs?.token || map.refs.max < 1) {
      throw new BadRequest('workflow muss ein Bearbeiten-Workflow mit Referenzbildern sein');
    }
    const [portrait] = parseImages([body.portrait]) ?? [];
    if (!portrait || portrait.kind === 'blank') throw new BadRequest('Porträt fehlt');
    const photos = (raw: unknown) => (parseImages(raw) ?? []).map((s) => {
      if (s.kind === 'blank') throw new BadRequest('Leere Fläche ist kein Foto');
      return s;
    });
    const extra = photos(body.extra);
    const views = photos(body.views);
    const [sheet] = photos(body.sheet === undefined ? undefined : [body.sheet]);
    if (extra.length > MAX_EXTRA_VIEWS) throw new BadRequest(`Höchstens ${MAX_EXTRA_VIEWS} weitere Ansichten`);
    if (1 + extra.length > map.refs.max) throw new BadRequest(`${map.name} nimmt höchstens ${map.refs.max} Referenzbilder`);
    const refs = [portrait, ...extra];
    if (sheet) {
      const png = await sharp(jobs.readSource(sheet)).png().toBuffer();
      return jobs.importImage(png, { workflow: map.name, prompt: 'Eigenes Blatt', refs });
    }
    if (views.length) {
      // grenze: nur volle Felder, Lücken füllt erst Phase 3 von plan_figurenblatt
      if (views.length !== SHEET_PANELS[kind].length) throw new BadRequest(`Je Feld ein Foto, ${SHEET_PANELS[kind].length} nötig`);
      const png = await composeSheet(kind, views.map((s) => jobs.readSource(s)));
      return jobs.importImage(png, { workflow: map.name, prompt: 'Blatt aus Fotos', refs });
    }
    const outfit = typeof body.outfit === 'string' ? body.outfit.trim().slice(0, 200) : '';
    const template = typeof body.template === 'boolean' ? body.template : sheetTemplateDefault(map.name);
    const canvas = template ? readFileSync(templateFile(config.samplesDir, kind, map.name))
      : await sharp({ create: { ...SHEET_SIZE, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const tpl = await saveInput(dataDir, canvas);
    return jobs.create({
      workflow: map.name, prompt: sheetPrompt(kind, map.refs.token, outfit, extra.length, template),
      params: SHEET_MEGAPIXELS[map.name] ? { megapixels: SHEET_MEGAPIXELS[map.name] as number } : {},
      images: [{ kind: 'upload', id: tpl.inputId }, ...refs],
    });
  }

  // Vorschau: Blatt rechnen, ohne schon eine Figur anzulegen; neu würfeln = noch einmal aufrufen
  app.post('/api/figures/sheet', async (req, reply) => {
    try {
      return { sheetId: await makeSheet((req.body ?? {}) as Partial<FigureSheetRequest>) };
    } catch (e) {
      return reply.code(e instanceof BadRequest ? 400 : 502).send({ error: (e as Error).message });
    }
  });

  // Figur speichern: aus einer Vorschau (sheetId) oder in einem Zug (MCP), dann wird das Blatt erst gerechnet
  app.post('/api/figures', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<FigureSheetRequest> & { name?: unknown; sheetId?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 60) return reply.code(400).send({ error: 'Name fehlt oder ist länger als 60 Zeichen' });
    // Claude wählt Figuren per Name, darum eindeutig
    if (listFigures(db).some((f) => f.name.toLowerCase() === name.toLowerCase())) return reply.code(400).send({ error: `Eine Figur „${name}“ gibt es schon` });
    try {
      const kind = parseKind(body.kind);
      let sheetId: string;
      if (typeof body.sheetId === 'string') {
        const row = getRow(db, body.sheetId);
        const problem = sheetProblem(row?.status, row ? refsOf(row).length : 0, row ? figureUsing(db, row.id) : null);
        if (problem || !row) throw new BadRequest(problem ?? 'Blatt nicht gefunden');
        sheetId = row.id;
      } else {
        sheetId = await makeSheet(body);
      }
      const id = randomUUID();
      insertFigure(db, { id, name, kind, sheetId });
      return listFigures(db).find((f) => f.id === id);
    } catch (e) {
      return reply.code(e instanceof BadRequest ? 400 : 502).send({ error: (e as Error).message });
    }
  });

  app.delete('/api/figures/:id', async (req, reply) => {
    if (!deleteFigure(db, (req.params as { id: string }).id)) return reply.code(404).send({ error: 'Nicht gefunden' });
    return { ok: true };
  });

  app.get('/api/generations', async (req) => {
    const q = req.query as { cursor?: string; limit?: string; q?: string; fav?: string; wf?: string; nowf?: string };
    const cursor = q.cursor ? Number(q.cursor) : null;
    const limit = Math.min(Math.max(Number(q.limit) || 40, 1), 200);
    const list = (s: string | undefined) => (typeof s === 'string' ? s.split(',').filter(Boolean) : undefined);
    return listGenerations(db, Number.isFinite(cursor) ? cursor : null, limit,
      { q: q.q, favorite: q.fav === '1', workflows: list(q.wf), notWorkflows: list(q.nowf) });
  });

  app.get('/api/generations/workflows', async () => usedWorkflows(db));
  app.get('/api/generations/durations', async () => durationStats(db));

  app.get('/api/generations/:id', async (req, reply) => {
    const row = getRow(db, (req.params as { id: string }).id);
    return row ? toApi(row) : reply.code(404).send({ error: 'Nicht gefunden' });
  });

  app.delete('/api/generations/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = getRow(db, id);
    if (!row) return reply.code(404).send({ error: 'Nicht gefunden' });
    if (row.status === 'queued' || row.status === 'running') return reply.code(400).send({ error: 'Läuft noch – erst abbrechen' });
    const figure = figureUsing(db, id);
    if (figure) return reply.code(400).send({ error: `Referenzblatt der Figur „${figure}“ – erst die Figur löschen` });
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
    // Schnittplatz: Übergang je Shot-Paar (Zahl = Überblenden), Kürzen/Tempo je Shot
    const joinOf = (x: unknown): Join | null => {
      const j = typeof x === 'number' ? { duration: x } : (x as { duration?: unknown; type?: unknown } | null);
      if (typeof j?.duration !== 'number' || !Number.isFinite(j.duration)) return null;
      if (j.type !== undefined && !TRANSITIONS.includes(j.type as Transition)) return null;
      return { duration: Math.min(3, Math.max(0, j.duration)), ...(j.type ? { type: j.type as Transition } : {}) };
    };
    const joins = Array.isArray(body.joins) ? body.joins.map(joinOf) : undefined;
    if (joins && (joins.length !== ids.length - 1 || joins.includes(null))) {
      return reply.code(400).send({ error: `joins braucht ${ids.length - 1} Übergänge ({ duration, type: ${TRANSITIONS.join(' | ')} })` });
    }
    const endJoin = body.endJoin === undefined ? undefined : joinOf(body.endJoin);
    if (endJoin === null) return reply.code(400).send({ error: 'endJoin: { duration, type } erwartet' });
    const edits = Array.isArray(body.edits) ? body.edits.map((x): ShotEdit => {
      const e = (x ?? {}) as Record<string, unknown>;
      const n = (k: string) => (typeof e[k] === 'number' && Number.isFinite(e[k]) ? { [k]: e[k] as number } : {});
      return { ...n('start'), ...n('end'), ...n('speed'), ...(e.reverse === true ? { reverse: true } : {}) };
    }) : undefined;
    if (edits && edits.length !== ids.length) return reply.code(400).send({ error: `edits braucht ${ids.length} Einträge, einen je Shot` });
    const format: CutFormat = body.format === 'webm' ? 'webm' : 'mp4';
    const preview = body.preview === true;
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
    const fadeIn = num('fadeIn', 0, 0, 5);
    const fadeOut = num('fadeOut', 0, 0, 5);
    const options: ConcatOptions = {
      fade, format, preview,
      ...(joins ? { joins: joins as Join[] } : {}),
      ...(endJoin ? { endJoin } : {}),
      ...(edits ? { edits } : {}),
      ...(fadeIn ? { fadeIn } : {}),
      ...(fadeOut ? { fadeOut } : {}),
      ...(endcard ? { endcard: { file: endcard, seconds: num('endcardSeconds', 2, 0.5, 10) } } : {}),
      ...(music ? { music: { file: music, volume: num('musicVolume', 0.8, 0, 2), shotVolume: num('shotVolume', 0.35, 0, 1) } } : {}),
      ...(logo ? { logo: { file: logo, scale: num('logoScale', 0.12, 0.03, 0.5), position } } : {}),
    };
    // Vorschau: nicht in die Galerie, immer nur die letzte bleibt liegen
    if (preview) {
      const dir = join(dataDir, 'cut-preview');
      try {
        mkdirSync(dir, { recursive: true });
        // Ältere Vorschauen weg; eine, die ein zweiter Tab gerade schreibt, ist gesperrt (EBUSY) und bleibt
        for (const f of readdirSync(dir)) {
          try {
            rmSync(join(dir, f), { force: true });
          } catch {
            // nächste Vorschau räumt sie weg
          }
        }
        const plan = await concatClips(files as string[], options, join(dir, `${id}.mp4`));
        return { url: `/api/concat/preview/${id}`, duration: plan.duration };
      } catch (e) {
        return reply.code(e instanceof PlanError ? 400 : 502).send({ error: (e as Error).message });
      }
    }
    const videoPath = `videos/${id}.${format}`;
    const started = Date.now();
    try {
      mkdirSync(join(dataDir, 'videos'), { recursive: true });
      const plan = await concatClips(files as string[], options, join(dataDir, videoPath));
      const saved = await saveOutput(dataDir, id, await frameAt(join(dataDir, videoPath), plan.duration / 2));
      const extra = [music && 'Musik', logo && 'Logo', endcard && 'Endkarte'].filter(Boolean).join(', ');
      insertGeneration(db, {
        id, workflow: 'concat', prompt: `Schnitt aus ${ids.length} Shots${extra ? ` mit ${extra}` : ''}`,
        params: {
          shots: ids.join(','), fade, format, ...(joins ? { joins: JSON.stringify(joins) } : {}), ...(edits ? { edits: JSON.stringify(edits) } : {}),
          ...(endJoin ? { endJoin: JSON.stringify(endJoin) } : {}),
          ...(fadeIn ? { fadeIn } : {}), ...(fadeOut ? { fadeOut } : {}),
          // Angaben wie gesendet (Galerie-ID statt Pfad), damit der Schnittplatz den Schnitt wieder öffnen kann
          ...(options.music ? { music: options.music.file, musicVolume: options.music.volume, shotVolume: options.music.shotVolume } : {}),
          ...(options.logo ? { logo: String(body.logo), logoPosition: position, logoScale: options.logo.scale } : {}),
          ...(options.endcard ? { endcard: String(body.endcard), endcardSeconds: options.endcard.seconds } : {}),
        },
        parentId: ids[0] ?? null,
      });
      finishDone(db, id, { ...saved, videoPath, expandedPrompt: null, durationMs: Date.now() - started });
      const row = getRow(db, id);
      if (row) broadcast({ type: 'done', generation: toApi(row) });
      return row ? toApi(row) : { id };
    } catch (e) {
      // Ohne Galerie-Eintrag fände niemand die Dateien wieder
      if (!getRow(db, id)) {
        for (const p of [videoPath, `images/${id}.png`, `previews/${id}.webp`, `thumbs/${id}.webp`]) rmSync(join(dataDir, p), { force: true });
      }
      return reply.code(e instanceof PlanError ? 400 : 502).send({ error: (e as Error).message });
    }
  });

  // Bildbearbeitung: fertiges Bild kam schon per /api/upload, hier wird es zum Galerie-Eintrag mit dem Projekt zum Wiederöffnen
  app.post('/api/image-edit', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const paths = typeof body.image === 'string' ? inputPaths(body.image) : null;
    if (!paths || !existsSync(join(dataDir, paths.inputPath))) return reply.code(400).send({ error: 'image: hochgeladenes Bild (inputId) fehlt' });
    const project = parseEditProject(body.project);
    if (!project?.layers.length) return reply.code(400).send({ error: 'project: Arbeitsfläche mit mindestens einer Ebene erwartet' });
    // Was der Parser verwirft, stünde im Bild, aber nicht im Projekt: lieber ablehnen als still verlieren
    const sent = (body.project as { layers?: unknown } | null)?.layers;
    if (Array.isArray(sent) && sent.length !== project.layers.length) {
      return reply.code(400).send({ error: `project: ${sent.length - project.layers.length} Ebene(n) ungültig (Bildebene ohne Quelle?)` });
    }
    const gone = project.layers.flatMap((l) => {
      if (!l.src) return [];
      const rel = l.src.kind === 'input' ? inputPaths(l.src.id)?.inputPath : undefined;
      const ok = l.src.kind === 'output' ? getRow(db, l.src.id)?.status === 'done' : !!rel && existsSync(join(dataDir, rel));
      return ok ? [] : [l.src.id];
    });
    if (gone.length) return reply.code(400).send({ error: `Ebenen-Quelle nicht gefunden: ${gone.join(', ')}` });
    const id = randomUUID();
    try {
      const saved = await saveOutput(dataDir, id, readFileSync(join(dataDir, paths.inputPath)));
      insertGeneration(db, {
        id, workflow: 'imageedit', prompt: `Bildbearbeitung aus ${project.layers.length} Ebenen`,
        params: { project: JSON.stringify(project) },
        parentId: project.layers.find((l) => l.src?.kind === 'output')?.src?.id ?? null,
      });
      finishDone(db, id, { ...saved, expandedPrompt: null, durationMs: 0 });
      const row = getRow(db, id);
      if (row) broadcast({ type: 'done', generation: toApi(row) });
      return row ? toApi(row) : { id };
    } catch (e) {
      if (!getRow(db, id)) for (const p of [`images/${id}.png`, `previews/${id}.webp`, `thumbs/${id}.webp`]) rmSync(join(dataDir, p), { force: true });
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  // Ebenen eines Projekts, die nicht aus der Galerie stammen (Malebenen, Fotos von der Platte)
  app.get('/api/inputs/:id', async (req, reply) => {
    const paths = inputPaths((req.params as { id: string }).id);
    const file = paths ? join(dataDir, paths.inputPath) : '';
    if (!file || !existsSync(file)) return reply.code(404).send({ error: 'Bild nicht gefunden' });
    return reply.type('image/png').header('cache-control', 'public, max-age=31536000, immutable').send(createReadStream(file));
  });

  app.get('/api/concat/preview/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const file = /^[0-9a-f-]{36}$/.test(id) ? join(dataDir, 'cut-preview', `${id}.mp4`) : '';
    if (!file || !existsSync(file)) return reply.code(404).send({ error: 'Vorschau nicht mehr da – neu erstellen' });
    return sendVideo(req.headers.range, reply, file);
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
    return sendVideo(req.headers.range, reply, file);
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
