import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { GenerateRequest, Health, ImageSource, MemoryStats, ParamValue, QueueItem } from '@brennglas/shared';
import type { ComfyClient, ComfyMessage } from './comfy/client.ts';
import { addRefs, applyLora, applyParams, defaultTrigger, dropInput, findNodeId, isSampler, samplerCount, type Workflow } from './comfy/workflow.ts';
import { gpuLoad } from './gpu.ts';
import {
  finishDone, finishError, getFigure, getRow, insertGeneration, listUnfinished, refsOf, setComfyId, setStatus, toApi, type DB,
} from './db.ts';
import { broadcast } from './events.ts';
import { blankPng, scenePrompt } from './figures.ts';
import { contentHash, inputPaths, refForComfy, saveInput, saveOutput } from './images.ts';
import { videoInputPath } from './video-input.ts';

export class BadRequest extends Error {}

/** Name nach Inhalt: dasselbe Bild in zehn Jobs liegt in ComfyUIs input-Ordner nur einmal. */
const comfyName = (data: Buffer) => `brennglas_${contentHash(data).slice(0, 20)}.png`;

interface Active {
  id: string;
  workflow: string;
  startedAt: number;
  running: boolean;
  stage: string | null;
  /** Laufender Sampler-Durchgang, 0 = noch keiner. */
  pass: number;
}

/** Job-Lebenszyklus. Nur eigene prompt_ids zählen, Events anderer ComfyUI-Clients fallen durch. */
export class Jobs {
  private readonly active = new Map<string, Active>();
  private readonly finishing = new Set<string>();
  private readonly refinish = new Set<string>();
  /** prompt_id des zuletzt gemeldeten Schritts – Vorschaubilder tragen keine eigene. */
  private livePid: string | null = null;
  private readonly submitting = new Set<string>();
  private readonly db: DB;
  private readonly comfy: ComfyClient;
  private readonly workflows: Map<string, Workflow>;
  private readonly dataDir: string;

  /** Holt eigene LoRAs neu in die Auswahl, bevor ein Auftrag geprüft wird. */
  private readonly refreshLoras: () => Promise<void>;

  constructor(db: DB, comfy: ComfyClient, workflows: Map<string, Workflow>, dataDir: string, refreshLoras: () => Promise<void> = async () => {}) {
    this.refreshLoras = refreshLoras;
    this.db = db;
    this.comfy = comfy;
    this.workflows = workflows;
    this.dataDir = dataDir;
    comfy.on('message', (m: ComfyMessage) => {
      this.onMessage(m).catch((e: unknown) => console.error('Comfy-Event:', e));
    });
    comfy.on('connected', () => {
      broadcast({ type: 'comfy', connected: true });
      this.recover().catch((e: unknown) => console.error('Wiederaufnahme:', e));
    });
    comfy.on('preview', (p: { mime: string; data: Buffer }) => {
      const job = this.livePid ? this.active.get(this.livePid) : undefined;
      if (job) broadcast({ type: 'preview', id: job.id, url: `data:${p.mime};base64,${p.data.toString('base64')}` });
    });
    comfy.on('disconnected', () => broadcast({ type: 'comfy', connected: false }));
  }

  async create(req: GenerateRequest): Promise<string> {
    const wf = this.workflows.get(req.workflow);
    if (!wf) throw new BadRequest(`Unbekannter Workflow ${req.workflow}`);
    if (wf.map.kind === 'video') throw new BadRequest(`${req.workflow} läuft über den Video-Job`);
    if (wf.map.kind === 'text') throw new BadRequest(`${req.workflow} liefert Text, Aufruf über /api/enhance`);
    const imageKey = Object.entries(wf.map.inputs).find(([, s]) => s.type === 'image')?.[0];
    const prompt = req.prompt?.trim() ?? '';
    const params: Record<string, ParamValue> = { ...req.params };
    if ('prompt' in wf.map.inputs) {
      if (!prompt) throw new BadRequest('Prompt fehlt');
      params.prompt = prompt;
    }
    const scene = req.figures?.length ? this.scene(wf, req, prompt) : null;
    if (scene) params.prompt = scene.prompt;
    // Bild 1 ist bei Szenen die leere Fläche, als Startbild gäbe sie Grau
    if (scene) delete params.denoise;
    const sources = await this.materialize(scene?.images ?? req.images ?? []);
    if (imageKey && sources.length === 0) throw new BadRequest('Eingabebild fehlt – erst hochladen');
    const series = req.series;
    if (series && !(typeof series.id === 'string' && series.id.length <= 64 && Number.isInteger(series.index) && Number.isInteger(series.size)
      && series.index >= 1 && series.index <= series.size && series.size <= 64)) throw new BadRequest('Serie ungültig');
    if (!imageKey && sources.length > 0) throw new BadRequest(`${req.workflow} nimmt keine Bilder`);
    const [input, ...refs] = sources.map((s, i) => this.resolveSource(s, i === 0));
    // Video-Felder (Layout zu Video): Wert bleibt die ID, ComfyUI bekommt die Datei
    const videos = Object.entries(wf.map.inputs).filter(([, s]) => s.type === 'video').map(([key]) => {
      try {
        const rel = videoInputPath(params[key], (vid) => getRow(this.db, vid)?.video_path ?? null, (r) => existsSync(join(this.dataDir, r)));
        return { key, value: String(params[key]), rel };
      } catch (e) {
        throw new BadRequest(`${key}: ${(e as Error).message}`);
      }
    });
    const min = wf.map.refs?.min ?? 0;
    if (refs.length < min) throw new BadRequest(min === 1 ? 'Zweites Bild fehlt' : `Mindestens ${min + 1} Bilder nötig`);
    if (imageKey) params[imageKey] = 'pruefung.png';
    if (Object.values(wf.map.inputs).some((s) => s.loras)) {
      await this.refreshLoras();
      defaultTrigger(wf.map, params);
    }
    let lora: string | null;
    try {
      // erst prüfen, dann hochladen – sonst landet Müll in ComfyUIs input-Ordner
      const check = applyParams(wf, params).graph;
      addRefs(check, wf.map, refs.map(() => 'pruefung.png'));
      lora = applyLora(check);
    } catch (e) {
      throw new BadRequest((e as Error).message);
    }
    if (lora && !(await this.comfy.listModels('loras')).includes(lora)) throw new BadRequest(`LoRA-Datei fehlt: ${lora} (gehört in ComfyUIs models/loras)`);

    const id = randomUUID();
    if (imageKey && input) {
      const main = readFileSync(join(this.dataDir, input.path));
      params[imageKey] = await this.comfy.uploadImage(main, comfyName(main));
    }
    for (const v of videos) {
      const data = readFileSync(join(this.dataDir, v.rel));
      params[v.key] = await this.comfy.uploadImage(data, `brennglas_${contentHash(data).slice(0, 20)}${extname(v.rel)}`);
    }
    const refNames: string[] = [];
    for (const r of refs) {
      const ref = await refForComfy(join(this.dataDir, r.path), wf.map.refs?.maxPixels);
      refNames.push(await this.comfy.uploadImage(ref, comfyName(ref)));
    }
    const applied = applyParams(wf, params);
    addRefs(applied.graph, wf.map, refNames);
    applyLora(applied.graph);
    insertGeneration(this.db, {
      id, workflow: req.workflow, prompt,
      params: { ...(scene ? { ...applied.values, ...scene.params } : applied.values), ...Object.fromEntries(videos.map((v) => [v.key, v.value])) },
      // Szene: Bild 1 ist nur die leere Fläche – kein Vorher-Bild, keine Kette
      parentId: scene ? null : input?.parentId ?? null,
      inputPath: scene ? null : input?.path ?? null, inputPreviewPath: scene ? null : input?.preview ?? null,
      refs: refs.map(({ path, preview }) => ({ path, preview })),
      series: series ? { id: series.id, index: series.index, size: series.size } : null,
    });
    this.submitting.add(id);
    try {
      const pid = await this.comfy.queuePrompt(applied.graph, true);
      setComfyId(this.db, id, pid);
      this.active.set(pid, { id, workflow: req.workflow, startedAt: Date.now(), running: false, stage: null, pass: 0 });
      // Ein komplett gecachter Graph ist fertig, bevor wir die prompt_id kennen – einmal nachsehen.
      setTimeout(() => void this.checkHistory(pid), 1500);
    } catch (e) {
      const msg = (e as Error).message;
      finishError(this.db, id, msg);
      broadcast({ type: 'error', id, error: msg });
      throw e;
    } finally {
      this.submitting.delete(id);
    }
    broadcast({ type: 'status', id, status: 'queued' });
    return id;
  }

  /** Datei zu einer Bildquelle. Die Kette (parentId) zählt nur für das Hauptbild, nicht für Referenzen. */
  /** Text-Workflow (Prompt-Assistent): läuft vor allen wartenden Jobs, kein Galerie-Eintrag, wartet aufs Ergebnis. */
  async enhance(req: GenerateRequest): Promise<string> {
    const wf = this.workflows.get(req.workflow);
    if (wf?.map.kind !== 'text' || !wf.map.outputs.text) throw new BadRequest(`${req.workflow} ist kein Text-Workflow`);
    const prompt = req.prompt?.trim() ?? '';
    if (!prompt) throw new BadRequest('Prompt fehlt');
    const params: Record<string, ParamValue> = { ...req.params, prompt };
    const image = Object.entries(wf.map.inputs).find(([, s]) => s.type === 'image');
    const sources = await this.materialize(req.images ?? []);
    if (sources.length > (image ? 1 : 0)) throw new BadRequest(`${req.workflow} nimmt höchstens ${image ? 1 : 0} Bild`);
    if (image && sources.length === 0 && !image[1].optional) throw new BadRequest('Eingabebild fehlt – erst hochladen');
    const src = sources[0] ? this.resolveSource(sources[0], true) : undefined;
    if (image) params[image[0]] = 'pruefung.png';
    let graph;
    try {
      graph = applyParams(wf, params).graph;
    } catch (e) {
      throw new BadRequest((e as Error).message);
    }
    if (image && src) {
      const data = readFileSync(join(this.dataDir, src.path));
      (graph[findNodeId(graph, image[1].node)] as { inputs: Record<string, unknown> }).inputs[image[1].field] = await this.comfy.uploadImage(data, comfyName(data));
    } else if (image) {
      dropInput(graph, image[1].node);
    }
    const pid = await this.comfy.queuePrompt(graph, false, true);
    const outId = findNodeId(wf.api, wf.map.outputs.text.node);
    const until = Date.now() + 10 * 60_000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 500));
      const entry = await this.comfy.history(pid);
      if (!entry) continue;
      if (entry.status?.status_str === 'error') {
        const err = entry.status.messages?.find(([t]) => t === 'execution_error')?.[1];
        throw new Error(String(err?.exception_message ?? 'Abgebrochen oder Fehler in ComfyUI'));
      }
      const text = entry.outputs[outId]?.text?.[0];
      if (typeof text === 'string') return text.trim();
      throw new Error('ComfyUI hat keinen Text geliefert');
    }
    throw new Error('Keine Antwort von ComfyUI nach 10 Minuten');
  }

  /** Figur in Szene: leere Fläche, je Figur Porträt (Referenz 1 des Blatt-Jobs) und Blatt, dann die Bilder der Leiste. */
  private scene(wf: Workflow, req: GenerateRequest, text: string): { images: ImageSource[]; prompt: string; params: Record<string, ParamValue> } {
    const token = wf.map.refs?.token;
    const ids = req.figures ?? [];
    if (!token || !('prompt' in wf.map.inputs)) throw new BadRequest(`${req.workflow} kann keine Figuren in Szenen setzen`);
    if (ids.length > 3) throw new BadRequest('Höchstens 3 Figuren je Szene');
    const aspect = req.aspect ?? 16 / 9;
    const figs = ids.map((fid) => {
      const f = getFigure(this.db, fid);
      if (!f) throw new BadRequest('Figur nicht gefunden');
      const st = getRow(this.db, f.sheetId)?.status;
      if (st === 'error' || st === 'cancelled') throw new BadRequest(`Das Blatt von „${f.name}“ ist gescheitert – Figur löschen und neu anlegen`);
      if (st !== 'done') throw new BadRequest(`Das Blatt von „${f.name}“ ist noch nicht fertig`);
      return f;
    });
    const extra = req.images ?? [];
    return {
      images: [{ kind: 'blank', aspect }, ...figs.flatMap((f): ImageSource[] => [{ kind: 'input', id: f.sheetId, index: 1 }, { kind: 'output', id: f.sheetId }]), ...extra],
      prompt: scenePrompt(figs, token, extra.length, text),
      params: { figures: ids.join(','), aspect },
    };
  }

  /** Leere Flächen werden zu Uploads; gleiche Fläche = gleicher Inhalt = eine Datei. */
  private async materialize(sources: ImageSource[]): Promise<ImageSource[]> {
    // grenze: Fläche wird vor den übrigen Prüfungen geschrieben, bei Ablehnung bleibt sie liegen (wenige KB, Dedup); aufräumen, falls inputs/ wächst
    return Promise.all(sources.map(async (s): Promise<ImageSource> => {
      if (s.kind !== 'blank') return s;
      if (!Number.isFinite(s.aspect) || s.aspect < 0.25 || s.aspect > 4) throw new BadRequest('Seitenverhältnis der leeren Fläche muss zwischen 0,25 und 4 liegen');
      return { kind: 'upload', id: (await saveInput(this.dataDir, await blankPng(s.aspect))).inputId };
    }));
  }

  private resolveSource(s: ImageSource, main: boolean): { path: string; preview: string; parentId: string | null } {
    if (s.kind === 'blank') throw new BadRequest('Leere Fläche nicht aufbereitet');
    if (s.kind === 'output') {
      const parent = getRow(this.db, s.id);
      if (!parent || parent.status !== 'done' || !parent.output_path || !parent.preview_path) {
        throw new BadRequest('Ausgangsbild nicht gefunden oder noch nicht fertig');
      }
      return { path: parent.output_path, preview: parent.preview_path, parentId: main ? parent.id : null };
    }
    if (s.kind === 'input') {
      const src = getRow(this.db, s.id);
      if (!src) throw new BadRequest('Job zum Eingabebild nicht gefunden');
      const hit = s.index === 0
        ? (src.input_path && src.input_preview_path ? { path: src.input_path, preview: src.input_preview_path } : undefined)
        : refsOf(src)[s.index - 1];
      if (!hit) throw new BadRequest(`Dieser Job hat kein Eingabebild ${s.index + 1}`);
      return { ...hit, parentId: main && s.index === 0 ? src.parent_id : null };
    }
    const paths = inputPaths(s.id);
    if (!paths || !existsSync(join(this.dataDir, paths.inputPath))) throw new BadRequest('Eingabebild fehlt – erst hochladen');
    return { path: paths.inputPath, preview: paths.inputPreviewPath, parentId: null };
  }

  /** Bilddaten einer Quelle (Upload, Ergebnis, Eingabebild eines Jobs). */
  readSource(s: ImageSource): Buffer {
    return readFileSync(join(this.dataDir, this.resolveSource(s, false).path));
  }

  /** Fertiges Bild ohne ComfyUI als Galerie-Eintrag, z. B. ein Figurenblatt aus Fotos; refs wie bei einem Blatt-Job. */
  async importImage(png: Buffer, d: { workflow: string; prompt: string; refs: ImageSource[] }): Promise<string> {
    const refs = d.refs.map((s) => {
      const { path, preview } = this.resolveSource(s, false);
      return { path, preview };
    });
    const id = randomUUID();
    const saved = await saveOutput(this.dataDir, id, png);
    insertGeneration(this.db, { id, workflow: d.workflow, prompt: d.prompt, params: { prompt: d.prompt }, refs });
    finishDone(this.db, id, { ...saved, expandedPrompt: null, durationMs: 0 });
    const row = getRow(this.db, id);
    if (row) broadcast({ type: 'done', generation: toApi(row) });
    return id;
  }

  /** Wartend: aus der ComfyUI-Queue nehmen. Laufend: unterbrechen, execution_interrupted schließt ab. */
  async cancel(id: string): Promise<void> {
    const row = getRow(this.db, id);
    if (!row) throw new BadRequest('Nicht gefunden');
    if (row.status !== 'queued' && row.status !== 'running') throw new BadRequest('Job läuft nicht mehr');
    const pid = row.comfy_prompt_id;
    if (!pid || !this.active.has(pid)) {
      finishError(this.db, id, 'Abgebrochen', 'cancelled');
      broadcast({ type: 'status', id, status: 'cancelled' });
      return;
    }
    const q = await this.comfy.queue();
    if (q.running.includes(pid)) {
      await this.comfy.interrupt(pid);
    } else {
      await this.comfy.deleteFromQueue(pid);
      this.fail(pid, 'Abgebrochen', 'cancelled');
    }
  }

  /** Alle offenen Jobs; Video-Upscales stehen nicht in der ComfyUI-Queue und landen nach den wartenden. */
  async queueList(): Promise<QueueItem[]> {
    const q = await this.comfy.queue();
    const rows = listUnfinished(this.db);
    const rank = (pid: string | null) => {
      if (!pid) return Number.MAX_SAFE_INTEGER;
      if (q.running.includes(pid)) return -1;
      const i = q.pending.indexOf(pid);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    return rows
      .map((r) => ({ r, k: rank(r.comfy_prompt_id) }))
      .sort((a, b) => a.k - b.k)
      .map(({ r, k }) => ({
        generation: toApi(r),
        state: r.status === 'running' || k === -1 ? 'running' : 'waiting',
        canFront: k > 0 && k !== Number.MAX_SAFE_INTEGER && this.active.has(r.comfy_prompt_id ?? ''),
      }));
  }

  async toFront(id: string): Promise<void> {
    const pid = getRow(this.db, id)?.comfy_prompt_id;
    if (!pid || !this.active.has(pid)) throw new BadRequest('Wartet nicht in ComfyUI');
    try {
      if (!(await this.comfy.toFront(pid))) throw new BadRequest('Läuft schon oder steht nicht mehr in der Queue');
    } catch (e) {
      // Gelöscht, aber nicht neu eingereiht: sonst wartete der Job für immer
      if (!(e instanceof BadRequest)) this.fail(pid, `Nach vorne holen fehlgeschlagen: ${(e as Error).message}`);
      throw e;
    }
    const q = await this.comfy.queue();
    broadcast({ type: 'queue', remaining: q.running.length + q.pending.length });
  }

  async freeVram(): Promise<void> {
    await this.comfy.free();
  }

  async memory(): Promise<MemoryStats> {
    const [m, gpu] = await Promise.all([this.comfy.memory(), gpuLoad()]);
    return { ...m, gpu };
  }

  async health(): Promise<Health> {
    if (!this.comfy.connected) return { comfy: false, queueRunning: 0, queuePending: 0 };
    try {
      const q = await this.comfy.queue();
      return { comfy: true, queueRunning: q.running.length, queuePending: q.pending.length };
    } catch {
      return { comfy: false, queueRunning: 0, queuePending: 0 };
    }
  }

  private async onMessage(m: ComfyMessage): Promise<void> {
    if (m.type === 'status') {
      const remaining = (m.data.status as { exec_info?: { queue_remaining?: number } } | undefined)?.exec_info?.queue_remaining;
      if (typeof remaining === 'number') broadcast({ type: 'queue', remaining });
      // Fertig-Meldungen gehen nur an den Absender; nach einem Backend-Neustart bleibt nur dieser Rundruf
      for (const pid of this.active.keys()) void this.checkHistory(pid);
      return;
    }
    const pid = m.data?.prompt_id;
    if (typeof pid !== 'string') return;
    const job = this.active.get(pid);
    if (!job) return;
    this.livePid = pid;

    switch (m.type) {
      case 'execution_start':
        this.markRunning(job);
        break;
      case 'execution_cached': {
        // Ein Sampler aus dem Cache meldet kein executing, zählt aber als erledigter Durchgang
        const api = this.workflows.get(job.workflow)?.api ?? {};
        const nodes = Array.isArray(m.data.nodes) ? m.data.nodes : [];
        job.pass += nodes.filter((n) => typeof n === 'string' && isSampler(api[n]?.class_type)).length;
        break;
      }
      case 'executing': {
        const node = m.data.node;
        if (node === null) return this.finish(pid);
        if (typeof node !== 'string') return;
        this.markRunning(job);
        job.stage = this.workflows.get(job.workflow)?.api[node]?.class_type ?? null;
        if (isSampler(job.stage ?? undefined)) job.pass++;
        broadcast({ type: 'progress', id: job.id, value: 0, max: 0, stage: job.stage, ...this.passes(job) });
        break;
      }
      case 'progress': {
        const value = Number(m.data.value);
        const max = Number(m.data.max);
        broadcast({ type: 'progress', id: job.id, value, max, stage: job.stage, ...this.passes(job) });
        break;
      }
      case 'execution_success':
        return this.finish(pid);
      case 'execution_error':
        this.fail(pid, `${String(m.data.node_type ?? 'Node')}: ${String(m.data.exception_message ?? 'Fehler')}`);
        break;
      case 'execution_interrupted':
        this.fail(pid, 'Abgebrochen', 'cancelled');
        break;
    }
  }

  private markRunning(job: Active): void {
    if (job.running) return;
    job.running = true;
    job.startedAt = Date.now(); // Laufzeit ohne Wartezeit in der Queue (Anzeige „hier ~X“)
    setStatus(this.db, job.id, 'running');
    broadcast({ type: 'status', id: job.id, status: 'running' });
  }

  /** Durchgang x von y, nur bei mehr als einem Sampler im Graphen. */
  private passes(job: Active): { pass?: number; passes?: number } {
    const passes = samplerCount(this.workflows.get(job.workflow)?.api ?? {});
    return passes > 1 && job.pass > 0 ? { pass: Math.min(job.pass, passes), passes } : {};
  }

  private async checkHistory(pid: string): Promise<void> {
    if (!this.active.has(pid)) return;
    try {
      if (await this.comfy.history(pid)) await this.finish(pid);
    } catch {
      // ComfyUI gerade weg: die Wiederaufnahme beim Reconnect holt das nach
    }
  }

  private async finish(pid: string): Promise<void> {
    const job = this.active.get(pid);
    if (!job) return;
    // execution_success kommt vor dem History-Eintrag, executing:null danach – das zweite Signal darf nicht verfallen.
    if (this.finishing.has(pid)) { this.refinish.add(pid); return; }
    this.finishing.add(pid);
    try {
      const entry = await this.comfy.history(pid);
      if (!entry) return; // noch nicht in der History; execution_success oder der Reconnect kommt wieder
      if (entry.status?.status_str === 'error') {
        // Ein Abbruch landet in der History ebenfalls als error – beim Reconnect nicht als Fehler zählen.
        if (entry.status.messages?.some(([t]) => t === 'execution_interrupted')) return this.fail(pid, 'Abgebrochen', 'cancelled');
        const err = entry.status.messages?.find(([t]) => t === 'execution_error')?.[1];
        return this.fail(pid, String(err?.exception_message ?? 'Fehler in ComfyUI'));
      }
      const wf = this.workflows.get(job.workflow);
      if (!wf) return this.fail(pid, `Workflow ${job.workflow} nicht mehr geladen`);
      const imgOut = wf.map.outputs.image;
      const img = imgOut ? entry.outputs[findNodeId(wf.api, imgOut.node)]?.images?.[0] : undefined;
      if (!img) return this.fail(pid, 'ComfyUI hat kein Bild geliefert');

      const vidOut = wf.map.outputs.video;
      const vids = vidOut ? entry.outputs[findNodeId(wf.api, vidOut.node)] : undefined;
      // SaveVideo meldet die Datei je nach Version unter images oder videos
      const vid = vids?.videos?.[0] ?? vids?.images?.[0];
      if (vidOut && !vid) return this.fail(pid, 'ComfyUI hat kein Video geliefert');
      let videoPath: string | null = null;
      if (vid) {
        videoPath = `videos/${job.id}${extname(vid.filename) || '.mp4'}`;
        mkdirSync(join(this.dataDir, 'videos'), { recursive: true });
        writeFileSync(join(this.dataDir, videoPath), await this.comfy.view(vid));
      }
      const saved = await saveOutput(this.dataDir, job.id, await this.comfy.view(img));
      const cap = wf.map.outputs.expandedPrompt;
      const text = cap ? entry.outputs[findNodeId(wf.api, cap.node)]?.text?.[0] : undefined;
      finishDone(this.db, job.id, { ...saved, videoPath, expandedPrompt: text ?? null, durationMs: Date.now() - job.startedAt });
      this.active.delete(pid);
      const row = getRow(this.db, job.id);
      if (row) broadcast({ type: 'done', generation: toApi(row) });
    } catch (e) {
      this.fail(pid, `Ergebnis nicht übernommen: ${(e as Error).message}`);
    } finally {
      this.finishing.delete(pid);
      if (this.refinish.delete(pid)) await this.finish(pid);
    }
  }

  private fail(pid: string, error: string, status: 'error' | 'cancelled' = 'error'): void {
    const job = this.active.get(pid);
    if (!job) return;
    this.active.delete(pid);
    finishError(this.db, job.id, error, status);
    broadcast({ type: 'error', id: job.id, error });
    broadcast({ type: 'status', id: job.id, status });
  }

  /** Nach Start und jedem Reconnect: offene Jobs gegen ComfyUI abgleichen, damit kein fertiges Bild verloren geht. */
  private async recover(): Promise<void> {
    const q = await this.comfy.queue();
    const queued = new Set([...q.running, ...q.pending]);
    for (const r of listUnfinished(this.db)) {
      if (this.submitting.has(r.id) || this.workflows.get(r.workflow)?.map.kind === 'video') continue;
      if (!r.comfy_prompt_id) {
        finishError(this.db, r.id, 'Nie an ComfyUI übergeben');
        broadcast({ type: 'error', id: r.id, error: 'Nie an ComfyUI übergeben' });
        continue;
      }
      const pid = r.comfy_prompt_id;
      if (!this.active.has(pid)) {
        this.active.set(pid, {
          id: r.id, workflow: r.workflow, startedAt: Date.parse(r.created_at), running: r.status === 'running', stage: null, pass: 0,
        });
      }
      try {
        if (await this.comfy.history(pid)) await this.finish(pid);
        else if (!queued.has(pid)) this.fail(pid, 'In ComfyUI nicht mehr auffindbar (ComfyUI neu gestartet?)');
      } catch (e) {
        console.error(`Wiederaufnahme ${r.id}:`, e); // ein Job darf die übrigen nicht blockieren
      }
    }
  }
}
