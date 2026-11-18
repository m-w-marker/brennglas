import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelSpec } from '@brennglas/shared';
import { catalogChoices, modeOf, setLoraOptions, type LoraEntry, type Workflow } from './comfy/workflow.ts';

export interface LoraInfo {
  /** Erkanntes Modell (id), null = passt zu keinem. */
  model: string | null;
  trigger?: string;
}

/** Kopf einer safetensors-Datei (Tensor-Formen, Metadaten), ohne die Gewichte zu lesen. */
export function readHeader(file: string): Record<string, unknown> {
  const fd = openSync(file, 'r');
  try {
    const len = Buffer.alloc(8);
    readSync(fd, len, 0, 8, 0);
    const n = Number(len.readBigUInt64LE());
    if (!(n > 0 && n < 100 * 1024 * 1024)) throw new Error('kein safetensors-Kopf');
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, 8);
    const v: unknown = JSON.parse(buf.toString('utf8'));
    if (!v || typeof v !== 'object') throw new Error('kein safetensors-Kopf');
    return v as Record<string, unknown>;
  } finally {
    closeSync(fd);
  }
}

/** Modell über die Form der Gewichte (Metadaten sind oft falsch oder fehlen), Trigger aus den Metadaten. */
export function inspectLora(header: Record<string, unknown>, models: ModelSpec[]): LoraInfo {
  const keys = Object.keys(header).filter((k) => k !== '__metadata__' && /(lora_A|lora_down)\.weight$/.test(k));
  const model = models.find((m) => {
    if (!m.lora) return false;
    const re = new RegExp(m.lora.key);
    const key = keys.find((k) => re.test(k));
    const shape = key ? (header[key] as { shape?: unknown }).shape : undefined;
    return Array.isArray(shape) && shape[1] === m.lora.width;
  });
  return { model: model?.id ?? null, trigger: triggerOf(header.__metadata__) };
}

function triggerOf(meta: unknown): string | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const m = meta as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const phrase = text(m['modelspec.trigger_phrase']);
  if (phrase) return phrase;
  // Edit-LoRAs (ausboss) tragen ihre Anweisung; „none (…)“ heißt: keine
  const instruction = text(m.instruction);
  if (instruction && !/^none\b/i.test(instruction)) return instruction;
  try {
    const freq = JSON.parse(text(m.ss_tag_frequency) ?? '{}') as Record<string, Record<string, number>>;
    const count = new Map<string, number>();
    for (const tags of Object.values(freq)) for (const [tag, n] of Object.entries(tags)) count.set(tag.trim(), (count.get(tag.trim()) ?? 0) + n);
    const top = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
    return top && top.length <= 80 ? top : undefined;
  } catch {
    return undefined;
  }
}

/** Auswahl der LoRA-Felder aus Katalog und ComfyUIs `models/loras`; Erkennung je Datei gemerkt (Größe + Änderungszeit). */
export class Loras {
  private readonly seen = new Map<string, { stamp: string; info: LoraInfo }>();
  private readonly catalog: Record<string, LoraEntry>;
  private readonly models: ModelSpec[];
  private readonly dir: string | null;
  private readonly list: () => Promise<string[]>;

  /** dir = ComfyUIs LoRA-Ordner auf der Platte; ohne ihn gibt es nur den Katalog. */
  constructor(catalog: Record<string, LoraEntry>, models: ModelSpec[], dir: string | null, list: () => Promise<string[]>) {
    this.catalog = catalog;
    this.models = models;
    this.dir = dir;
    this.list = list;
  }

  info(file: string): LoraInfo | null {
    if (!this.dir) return null;
    try {
      const path = join(this.dir, file);
      const st = statSync(path);
      const stamp = `${st.size}:${st.mtimeMs}`;
      const hit = this.seen.get(file);
      if (hit?.stamp === stamp) return hit.info;
      const info = inspectLora(readHeader(path), this.models);
      this.seen.set(file, { stamp, info });
      return info;
    } catch {
      return { model: null };
    }
  }

  /** Katalog-LoRAs, die da sind (sonst alle, damit „Datei fehlt“ erklärt), dazu eigene mit passendem Modell. */
  async refresh(workflows: Iterable<Workflow>): Promise<void> {
    let present: string[];
    try {
      present = await this.list();
    } catch {
      return; // ComfyUI weg: Auswahl bleibt wie sie war
    }
    const own = present.filter((f) => !(f in this.catalog)).map((file) => ({ file, info: this.info(file) }));
    for (const wf of workflows) {
      for (const spec of Object.values(wf.map.inputs)) {
        if (!spec.loras) continue;
        const cat = catalogChoices(this.catalog, spec.loras, modeOf(wf.map.name, spec.loras));
        const have = cat.filter((c) => present.includes(c.file));
        const mine = own.filter((o) => o.info?.model === spec.loras)
          .map((o) => ({ file: o.file, label: o.file.replace(/\.safetensors$/i, ''), trigger: o.info?.trigger }));
        setLoraOptions(spec, wf.api, [...(have.length ? have : cat), ...mine]);
      }
    }
  }
}
