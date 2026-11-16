import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, join, parse, resolve } from 'node:path';
import sharp from 'sharp';
import type { ParamValue } from '@brennglas/shared';
import type { ComfyClient } from './comfy/client.ts';
import { applyParams, coerce, type Workflow } from './comfy/workflow.ts';
import { finishDone, finishError, getRow, insertGeneration, listUnfinished, setStatus, toApi, type DB } from './db.ts';
import { broadcast } from './events.ts';
import { saveOutput } from './images.ts';
import { BadRequest } from './jobs.ts';
import { blockSize, listFrames, planBlocks, sequencePattern } from './video-plan.ts';

/** Vorlauf je Block aus der Quelle, damit SeedVR2 an der Blockgrenze nicht kalt startet. */
const CONTEXT = 2;
const POLL_MS = 2000;
const TEMP_SUB = 'brennglas_video';
/** Format der Einzelbilder; Jobs von vor der Auswahl hatten immer 16-bit-PNG. */
const STILL: Record<string, { ext: string; depth: string }> = {
  png16: { ext: 'png', depth: '16-bit' },
  png8: { ext: 'png', depth: '8-bit' },
  jpg: { ext: 'jpg', depth: '8-bit' },
};

interface Running {
  id: string;
  pid: string | null;
  cancel: boolean;
}

class Cancelled extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);

/** Ein Shot als Folge von ComfyUI-Prompts; fertige Frames im Ziel werden übersprungen, so setzt ein Neustart fort. */
export class VideoJobs {
  private readonly waiting: string[] = [];
  private running: Running | null = null;
  private readonly db: DB;
  private readonly comfy: ComfyClient;
  private readonly wf: Workflow;
  private readonly dataDir: string;

  constructor(db: DB, comfy: ComfyClient, wf: Workflow, dataDir: string) {
    this.db = db;
    this.comfy = comfy;
    this.wf = wf;
    this.dataDir = dataDir;
    // Nach einem Backend-Neustart läuft nichts mehr; die fertigen Frames liegen aber im Ziel
    for (const r of listUnfinished(db)) {
      if (r.workflow === wf.map.name) finishError(db, r.id, 'Unterbrochen – erneut starten setzt beim letzten fertigen Frame fort');
    }
    rmSync(join(dataDir, 'video-tmp'), { recursive: true, force: true });
  }

  get name(): string {
    return this.wf.map.name;
  }

  create(params: Record<string, ParamValue>): string {
    const job = this.wf.map.job ?? {};
    const values: Record<string, ParamValue> = {};
    const graphParams: Record<string, ParamValue> = { frames: 'pruefung', names: 'pruefung' };
    try {
      for (const [key, spec] of Object.entries(job)) values[key] = coerce(key, spec, params[key], Math.random);
      for (const key of Object.keys(params)) {
        if (key in job) continue;
        if (this.wf.map.inputs[key]?.hidden || !(key in this.wf.map.inputs)) throw new Error(`Unbekannter Parameter ${key}`);
        graphParams[key] = params[key] as ParamValue;
      }
      Object.assign(values, Object.fromEntries(Object.entries(applyParams(this.wf, graphParams).values).filter(([k]) => !this.wf.map.inputs[k]?.hidden)));
    } catch (e) {
      throw new BadRequest((e as Error).message);
    }
    const src = String(values.src).trim();
    const dst = String(values.dst).trim();
    if (!isAbsolute(src) || !existsSync(src) || !statSync(src).isDirectory()) throw new BadRequest(`Quellordner nicht gefunden: ${src}`);
    if (!isAbsolute(dst)) throw new BadRequest('Zielordner als vollständigen Pfad angeben');
    // Gleicher Ordner: die Ergebnisse trügen die Namen der Quelle und überschrieben PNG-Originale
    if (samePath(src, dst)) throw new BadRequest('Zielordner muss ein anderer sein als der Quellordner');
    const frames = listFrames(readdirSync(src), String(values.pattern));
    if (frames.length === 0) throw new BadRequest(`Keine Bilder in ${src} passen zu „${String(values.pattern)}“`);
    if (values.format !== 'png') {
      if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) throw new BadRequest('Für ein Video muss ffmpeg installiert sein (im PATH)');
      if (!sequencePattern(frames.map((f) => parse(f).name))) throw new BadRequest('Video nur bei lückenlos durchnummerierten Frames – sonst Ausgabe PNG wählen');
    }
    values.src = src;
    values.dst = dst;

    const id = randomUUID();
    insertGeneration(this.db, { id, workflow: this.wf.map.name, prompt: `${src} → ${dst}`, params: values });
    this.waiting.push(id);
    broadcast({ type: 'status', id, status: 'queued' });
    void this.next();
    return id;
  }

  /** true, wenn der Job zu diesem Modul gehört. */
  async cancel(id: string): Promise<boolean> {
    const i = this.waiting.indexOf(id);
    if (i >= 0) {
      this.waiting.splice(i, 1);
      finishError(this.db, id, 'Abgebrochen', 'cancelled');
      broadcast({ type: 'status', id, status: 'cancelled' });
      return true;
    }
    if (this.running?.id !== id) return false;
    this.running.cancel = true;
    const pid = this.running.pid;
    if (pid) {
      const q = await this.comfy.queue();
      if (q.running.includes(pid)) await this.comfy.interrupt(pid);
      else await this.comfy.deleteFromQueue(pid);
    }
    return true;
  }

  private async next(): Promise<void> {
    if (this.running) return;
    const id = this.waiting.shift();
    if (!id) return;
    this.running = { id, pid: null, cancel: false };
    const tmp = join(this.dataDir, 'video-tmp', id);
    try {
      await this.run(this.running, tmp);
    } catch (e) {
      const cancelled = e instanceof Cancelled;
      const msg = cancelled ? 'Abgebrochen' : (e as Error).message;
      finishError(this.db, id, msg, cancelled ? 'cancelled' : 'error');
      if (!cancelled) broadcast({ type: 'error', id, error: msg });
      broadcast({ type: 'status', id, status: cancelled ? 'cancelled' : 'error' });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      this.running = null;
      void this.next();
    }
  }

  private async run(job: Running, tmp: string): Promise<void> {
    const row = getRow(this.db, job.id);
    if (!row) throw new Error('Job verschwunden');
    const p = JSON.parse(row.params_json) as Record<string, ParamValue>;
    const src = String(p.src);
    const dst = String(p.dst);
    const size = Number(p.size);
    const frames = listFrames(readdirSync(src), String(p.pattern));
    if (frames.length === 0) throw new Error('Keine passenden Frames mehr im Quellordner');
    const bases = frames.map((f) => parse(f).name);
    const still = STILL[String(p.still)] ?? STILL.png16 as { ext: string; depth: string };
    const out = (i: number) => join(dst, `${bases[i]}.${still.ext}`);
    const first = await sharp(join(src, frames[0] as string)).metadata();
    const per = blockSize(first.width ?? 1920, first.height ?? 1080, size);
    mkdirSync(dst, { recursive: true });

    const started = Date.now();
    const blocks = planBlocks(frames.length, (i) => existsSync(out(i)), per, CONTEXT);
    let done = frames.length - blocks.reduce((n, b) => n + b.frames.length, 0);
    setStatus(this.db, job.id, 'running');
    broadcast({ type: 'status', id: job.id, status: 'running' });
    broadcast({ type: 'progress', id: job.id, value: done, max: frames.length, stage: 'video' });

    for (const b of blocks) {
      if (job.cancel) throw new Cancelled();
      const all = [...b.ctx, ...b.frames];
      // Eigener Ordner je Block und Lauf: gleiche Eingaben beantwortete ComfyUI aus dem Cache, ohne zu speichern
      const stage = join(tmp, `b${String(b.frames[0])}-${randomUUID().slice(0, 8)}`);
      mkdirSync(stage, { recursive: true });
      all.forEach((fi, k) => copyFileSync(join(src, frames[fi] as string), join(stage, `${String(k).padStart(6, '0')}${extname(frames[fi] as string)}`)));
      const names = all.map((_, k) => `f${String(k).padStart(4, '0')}`);
      const { graph } = applyParams(this.wf, {
        frames: stage, names: names.join('\n'), size, color: String(p.color), ext: still.ext, bitdepth: still.depth,
      });
      job.pid = await this.comfy.queuePrompt(graph);
      await this.waitFor(job);
      job.pid = null;
      for (let k = b.ctx.length; k < all.length; k++) {
        const png = await this.comfy.view({ filename: `${names[k] as string}.${still.ext}`, subfolder: TEMP_SUB, type: 'temp' });
        const target = out(all[k] as number);
        // Erst vollständig schreiben, dann umbenennen: ein halber Frame zählte sonst beim Fortsetzen als fertig
        writeFileSync(`${target}.part`, png);
        renameSync(`${target}.part`, target);
      }
      rmSync(stage, { recursive: true, force: true });
      done += b.frames.length;
      broadcast({ type: 'progress', id: job.id, value: done, max: frames.length, stage: 'video' });
    }

    if (p.format !== 'png') {
      if (job.cancel) throw new Cancelled();
      broadcast({ type: 'progress', id: job.id, value: 0, max: 0, stage: 'encode' });
      await encode(dst, bases, still.ext, String(p.format), Number(p.fps));
    }
    const saved = await saveOutput(this.dataDir, job.id, readFileSync(out(frames.length - 1)));
    finishDone(this.db, job.id, { ...saved, expandedPrompt: null, durationMs: Date.now() - started });
    const fin = getRow(this.db, job.id);
    if (fin) broadcast({ type: 'done', generation: toApi(fin) });
  }

  /** Wartet auf den Block in der History; Aussetzer von ComfyUI überbrückt, ein verlorener Prompt ist ein Fehler. */
  private async waitFor(job: Running): Promise<void> {
    const pid = job.pid as string;
    let lost = 0;
    for (;;) {
      await sleep(POLL_MS);
      let entry: Awaited<ReturnType<ComfyClient['history']>>;
      let queued = false;
      try {
        entry = await this.comfy.history(pid);
        if (!entry) {
          const q = await this.comfy.queue();
          queued = q.running.includes(pid) || q.pending.includes(pid);
        }
      } catch {
        continue; // ComfyUI kurz weg, weiter warten
      }
      if (entry) {
        if (entry.status?.status_str !== 'error') return;
        if (job.cancel || entry.status.messages?.some(([t]) => t === 'execution_interrupted')) throw new Cancelled();
        const err = entry.status.messages?.find(([t]) => t === 'execution_error')?.[1];
        throw new Error(`${String(err?.node_type ?? 'ComfyUI')}: ${String(err?.exception_message ?? 'Fehler')}`);
      }
      if (queued) { lost = 0; continue; }
      if (job.cancel) throw new Cancelled();
      if (++lost >= 3) throw new Error('ComfyUI hat den Block verloren (neu gestartet?) – erneut starten setzt fort');
    }
  }
}

/** Bildfolge → Video neben den Frames; Name aus dem Präfix der Frames. */
async function encode(dst: string, bases: string[], ext: string, format: string, fps: number): Promise<void> {
  const seq = sequencePattern(bases);
  if (!seq) throw new Error('Frames nicht lückenlos nummeriert – Video übersprungen');
  const name = seq.prefix.replace(/[_\-. ]+$/, '') || 'video';
  const codec = format === 'prores'
    ? ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le']
    : ['-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
  const file = join(dst, `${name}.${format === 'prores' ? 'mov' : 'mp4'}`);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(fps), '-start_number', String(seq.start),
    '-i', join(dst, `${seq.pattern}.${ext}`), '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', ...codec, file];
  await new Promise<void>((ok, fail) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-2000); });
    child.on('error', (e) => fail(new Error(`ffmpeg: ${e.message}`)));
    child.on('close', (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg Code ${String(code)}: ${err.trim()}`))));
  });
}
