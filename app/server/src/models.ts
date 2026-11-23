import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Mode, ModelSpec } from '@brennglas/shared';
import type { ApiGraph, Workflow } from './comfy/workflow.ts';

const MODES: readonly Mode[] = ['t2i', 'edit', 'upscale', 'video', 't2v', 'i2v', 'flf2v', 'l2v', 'prompt'];

/** Loader-Node → ComfyUI-Modellordner und das Feld mit dem Dateinamen. */
const LOADERS: Record<string, { folder: string; field: string }> = {
  UNETLoader: { folder: 'diffusion_models', field: 'unet_name' },
  CLIPLoader: { folder: 'text_encoders', field: 'clip_name' },
  VAELoader: { folder: 'vae', field: 'vae_name' },
  CheckpointLoaderSimple: { folder: 'checkpoints', field: 'ckpt_name' },
  LoraLoaderModelOnly: { folder: 'loras', field: 'lora_name' },
  LoraLoader: { folder: 'loras', field: 'lora_name' },
  LTXAVTextEncoderLoader: { folder: 'text_encoders', field: 'text_encoder' },
  LatentUpscaleModelLoader: { folder: 'latent_upscale_models', field: 'model_name' },
};

export interface ModelFile {
  folder: string;
  name: string;
}

/** Welche Modelldateien ein Workflow lädt – abgelesen statt in der Modell-Datei doppelt gepflegt. */
export function requiredFiles(api: ApiGraph): ModelFile[] {
  const files = new Map<string, ModelFile>();
  for (const node of Object.values(api)) {
    // Die wählbare LoRA ist Zubehör: ohne sie läuft das Modell, applyLora nimmt den Loader dann heraus
    const loader = node._meta?.title === 'IN_LORA' ? undefined : LOADERS[node.class_type];
    const name = loader ? node.inputs[loader.field] : undefined;
    if (loader && typeof name === 'string') files.set(`${loader.folder}/${name}`, { folder: loader.folder, name });
  }
  return [...files.values()];
}

export interface Model {
  spec: ModelSpec;
  files: ModelFile[];
  downloads: Record<string, string>;
}

/** Download-Links je ordner/datei; fehlt oder bricht die Liste, startet die App trotzdem, nur ohne Links. */
export function loadDownloads(dir: string): Record<string, { url: string; gated?: boolean }> {
  try {
    const v: unknown = JSON.parse(readFileSync(join(dir, 'downloads.json'), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, { url: string; gated?: boolean }>) : {};
  } catch {
    return {};
  }
}

export function loadModels(dir: string, workflows: Map<string, Workflow>): Model[] {
  const links = loadDownloads(dir);
  const models: Model[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.model.json'))) {
    const spec = JSON.parse(readFileSync(join(dir, f), 'utf8')) as ModelSpec;
    const files = new Map<string, ModelFile>();
    for (const [mode, wfName] of Object.entries(spec.modes)) {
      if (!MODES.includes(mode as Mode)) throw new Error(`${f}: unbekannter Modus ${mode}`);
      const wf = wfName ? workflows.get(wfName) : undefined;
      if (!wf) throw new Error(`${f}: Workflow ${String(wfName)} fehlt`);
      for (const file of requiredFiles(wf.api)) files.set(`${file.folder}/${file.name}`, file);
    }
    const downloads: Record<string, string> = {};
    for (const key of files.keys()) {
      const url = links[key]?.url;
      if (typeof url === 'string') downloads[key] = url;
    }
    models.push({ spec, files: [...files.values()], downloads });
  }
  return models.sort((a, b) => a.spec.order - b.spec.order);
}

/** Fehlende Dateien je Modell; `listFolder` fragt ComfyUI, einmal je Ordner. */
export async function missingFiles(models: Model[], listFolder: (folder: string) => Promise<string[]>): Promise<Map<string, string[]>> {
  const folders = [...new Set(models.flatMap((m) => m.files.map((f) => f.folder)))];
  const present = new Map(await Promise.all(folders.map(async (d) => [d, new Set(await listFolder(d))] as const)));
  return new Map(models.map((m) => [m.spec.id, m.files.filter((f) => !present.get(f.folder)?.has(f.name)).map((f) => `${f.folder}/${f.name}`)]));
}
