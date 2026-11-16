// Workflow-Test ohne UI: pnpm comfy:test <workflow> "<prompt>" [feld=wert …] [ref=bild.png …]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ParamValue } from '@brennglas/shared';
import { config } from '../config.ts';
import { addRefs, applyParams, findNodeId, loadWorkflow } from './workflow.ts';

const [name, prompt, ...rest] = process.argv.slice(2).filter((a) => a !== '--');
if (!name || !prompt) {
  console.error('Aufruf: pnpm comfy:test <workflow> "<prompt>" [feld=wert …]   z. B. h3-edit "mach die Wand blau" image=C:/bild.png');
  process.exit(2);
}

const comfy = (path: string, init?: RequestInit) => fetch(config.comfyUrl + path, init);

async function uploadImage(file: string): Promise<string> {
  const form = new FormData();
  form.append('image', new Blob([readFileSync(file)]), basename(file));
  const res = await comfy('/upload/image', { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Upload fehlgeschlagen: ${res.status} ${await res.text()}`);
  const up = (await res.json()) as { name: string; subfolder: string };
  return up.subfolder ? `${up.subfolder}/${up.name}` : up.name;
}

interface HistoryEntry {
  status?: { status_str?: string; messages?: unknown[] };
  outputs: Record<string, { images?: { filename: string; subfolder: string; type: string }[]; text?: string[] }>;
}

try {
  await comfy('/system_stats');
} catch {
  console.error(`ComfyUI unter ${config.comfyUrl} nicht erreichbar – läuft es?`);
  process.exit(1);
}

const wf = loadWorkflow(config.workflowsDir, name);
const params: Record<string, ParamValue> = { prompt };
const refs: string[] = [];
for (const kv of rest) {
  const i = kv.indexOf('=');
  if (i < 1) throw new Error(`Erwartet feld=wert, bekommen: ${kv}`);
  if (kv.slice(0, i) === 'ref') refs.push(kv.slice(i + 1));
  else params[kv.slice(0, i)] = kv.slice(i + 1);
}
for (const [key, spec] of Object.entries(wf.map.inputs)) {
  const v = params[key];
  if (spec.type === 'image' && typeof v === 'string') params[key] = await uploadImage(v);
}

const { graph, values } = applyParams(wf, params);
addRefs(graph, wf.map, await Promise.all(refs.map(uploadImage)));
console.log('Parameter:', values);

const res = await comfy('/prompt', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: graph, client_id: randomUUID() }),
});
const queued = (await res.json()) as { prompt_id?: string; error?: unknown; node_errors?: unknown };
if (!res.ok || !queued.prompt_id) {
  console.error('ComfyUI hat den Job abgelehnt:', JSON.stringify(queued, null, 2));
  process.exit(1);
}
const id = queued.prompt_id;
console.log(`In der Queue: ${id}`);

// grenze: Polling statt WebSocket, reicht für den Test; Phase 1 bringt den WS-Client.
const start = Date.now();
let entry: HistoryEntry | undefined;
while (!entry) {
  if (Date.now() - start > 20 * 60_000) throw new Error('Nach 20 Minuten nicht fertig');
  await new Promise((r) => setTimeout(r, 1000));
  const h = (await (await comfy(`/history/${id}`)).json()) as Record<string, HistoryEntry>;
  entry = h[id];
  if (!entry) process.stdout.write(`\r  läuft … ${Math.round((Date.now() - start) / 1000)} s`);
}
process.stdout.write('\n');

if (entry.status?.status_str === 'error') {
  console.error('Fehler in ComfyUI:', JSON.stringify(entry.status.messages, null, 2));
  process.exit(1);
}

const imgDir = join(config.dataDir, 'images');
mkdirSync(imgDir, { recursive: true });
const images = entry.outputs[findNodeId(graph, wf.map.outputs.image!.node)]?.images ?? [];
if (images.length === 0) throw new Error('Kein Bild in der Ausgabe von OUT_IMAGE');
for (const img of images) {
  const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder, type: img.type });
  const view = await comfy(`/view?${q}`);
  if (!view.ok) throw new Error(`Bild nicht abrufbar: ${view.status}`);
  const out = join(imgDir, `${name}-${id}-${img.filename}`);
  writeFileSync(out, Buffer.from(await view.arrayBuffer()));
  console.log(`Bild gespeichert: ${out}`);
}

const cap = wf.map.outputs.expandedPrompt;
const text = cap ? entry.outputs[findNodeId(graph, cap.node)]?.text?.[0] : undefined;
if (text) console.log(`Erweiterter Prompt: ${text}`);
console.log(`Fertig nach ${Math.round((Date.now() - start) / 1000)} s`);
