import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import { config } from './config.ts';
import { ComfyClient } from './comfy/client.ts';
import { loadWorkflow, type Workflow } from './comfy/workflow.ts';
import { adoptLegacyDb, openDb } from './db.ts';
import { Jobs } from './jobs.ts';
import { loadModels } from './models.ts';
import { registerApi } from './routes/api.ts';
import { seedSamples } from './samples.ts';
import { VideoJobs } from './video.ts';

const workflows = new Map<string, Workflow>();
for (const f of readdirSync(config.workflowsDir).filter((n) => n.endsWith('.map.json'))) {
  const name = f.slice(0, -'.map.json'.length);
  workflows.set(name, loadWorkflow(config.workflowsDir, name));
}

const models = loadModels(config.modelsDir, workflows);

const dbFile = join(config.dataDir, 'brennglas.db');
if (adoptLegacyDb(dbFile, join(config.dataDir, 'h3studio.db'))) console.log('Galerie aus h3studio.db übernommen');
// Beispiele nur beim allerersten Start: wer seine Galerie später leert, bekommt sie nicht zurück.
const firstStart = !existsSync(dbFile);
const db = openDb(dbFile);
if (firstStart) {
  try {
    console.log(`${await seedSamples(db, config.dataDir, config.samplesDir)} Beispielbilder in die Galerie gelegt`);
  } catch (e) {
    console.warn(`Beispielbilder übersprungen: ${(e as Error).message}`);
  }
}
const comfy = new ComfyClient(config.comfyUrl);
const jobs = new Jobs(db, comfy, workflows, config.dataDir);
const videoWf = [...workflows.values()].find((w) => w.map.kind === 'video');
const video = videoWf ? new VideoJobs(db, comfy, videoWf, config.dataDir) : null;

const app = Fastify({ logger: { level: 'warn' } });
registerApi(app, { db, jobs, video, workflows, models, listFolder: (f) => comfy.listModels(f), dataDir: config.dataDir });

comfy.connect();
await app.listen({ host: config.host, port: config.port });
console.log(`Brennglas-Backend auf http://${config.host}:${config.port} · ComfyUI ${config.comfyUrl} · Workflows: ${[...workflows.keys()].join(', ')}`);

const stop = async () => {
  comfy.close();
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
