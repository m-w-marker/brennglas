import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FieldSpec, InputSpec, ParamValue, WorkflowMap } from '@brennglas/shared';

export interface ApiNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}
export type ApiGraph = Record<string, ApiNode>;

export interface Workflow {
  api: ApiGraph;
  map: WorkflowMap;
}

export function findNodeId(api: ApiGraph, title: string): string {
  const ids = Object.keys(api).filter((id) => api[id]?._meta?.title === title);
  if (ids.length !== 1) throw new Error(`Titel ${title}: ${ids.length} Nodes statt genau einem`);
  return ids[0] as string;
}

/** Eintrag in `models/loras.json`, Schlüssel = Dateiname in ComfyUIs `models/loras`. */
export interface LoraEntry {
  model: string;
  /** Nur in diesen Modi (z. B. edit für Hilfs-LoRAs); ohne Angabe überall. */
  modes?: string[];
  label?: string;
  trigger?: string;
  url?: string;
}

/** Eine wählbare LoRA: aus dem Katalog oder eine eigene Datei mit erkanntem Modell. */
export interface LoraChoice {
  file: string;
  label?: string;
  trigger?: string;
}

export function loadWorkflow(dir: string, name: string, loras: Record<string, LoraEntry> = {}): Workflow {
  const api = JSON.parse(readFileSync(join(dir, `${name}.api.json`), 'utf8')) as ApiGraph;
  const map = JSON.parse(readFileSync(join(dir, `${name}.map.json`), 'utf8')) as WorkflowMap;
  // Ein umbenannter Node soll beim Laden auffallen, nicht erst mitten im Job.
  for (const spec of [...Object.values(map.inputs), ...Object.values(map.outputs), ...(map.refs?.targets ?? [])]) findNodeId(api, spec.node);
  for (const spec of Object.values(map.inputs)) if (spec.loras) setLoraOptions(spec, api, catalogChoices(loras, spec.loras, modeOf(name, spec.loras)));
  return { api, map };
}

/** Modus aus dem Workflow-Namen (Konvention `<modell>-<modus>`, z. B. qwen21-edit → edit). */
export const modeOf = (workflow: string, model: string) => (workflow.startsWith(`${model}-`) ? workflow.slice(model.length + 1) : '');

/** Katalog-LoRAs eines Modells, Hilfs-LoRAs nur in ihren Modi. */
export function catalogChoices(loras: Record<string, LoraEntry>, model: string, mode: string): LoraChoice[] {
  return Object.entries(loras)
    .filter(([, e]) => e.model === model && (!e.modes || e.modes.includes(mode)))
    .map(([file, e]) => ({ file, label: e.label, trigger: e.trigger }));
}

/** Auswahl, Anzeige und Trigger eines LoRA-Felds; ohne Auswahl bleibt die Datei der Vorlage. */
export function setLoraOptions(spec: InputSpec, api: ApiGraph, choices: LoraChoice[]): void {
  const fallback = api[findNodeId(api, spec.node)]?.inputs[spec.field];
  // Keine Auswahl: leere Liste (das Formular blendet den Schalter aus), Default bleibt die Vorlage
  spec.options = choices.map((c) => c.file);
  spec.default = spec.options[0] ?? (typeof fallback === 'string' ? fallback : undefined);
  spec.optionLabels = {};
  spec.triggers = {};
  for (const c of choices) {
    if (c.label) spec.optionLabels[c.file] = c.label;
    if (c.trigger) spec.triggers[c.file] = c.trigger;
  }
}

/** Katalog der LoRAs; fehlt oder bricht die Datei, gibt es nur keine Auswahl. */
export function loadLoras(dir: string): Record<string, LoraEntry> {
  try {
    const v: unknown = JSON.parse(readFileSync(join(dir, 'loras.json'), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, LoraEntry>) : {};
  } catch {
    return {};
  }
}

/** Ohne Trigger im Auftrag (Claude, comfy:test) gilt das bekannte Wort der gewählten LoRA; ändert params. */
export function defaultTrigger(map: WorkflowMap, params: Record<string, ParamValue>): void {
  const entries = Object.entries(map.inputs);
  const lora = entries.find(([, s]) => s.loras);
  const trigger = entries.find(([, s]) => s.fillFrom && s.fillFrom === lora?.[0]);
  if (!lora || !trigger || params[trigger[0]] !== undefined) return;
  const file = String(params[lora[0]] ?? lora[1].default);
  params[trigger[0]] = lora[1].triggers?.[file] ?? '';
}

const hasTitle = (graph: ApiGraph, title: string) => Object.values(graph).some((n) => n._meta?.title === title);

/** Aus: Loader raus (ComfyUI prüft ihn sonst auch im toten Zweig). An: die gebrauchte Datei. */
export function applyLora(graph: ApiGraph): string | null {
  if (!hasTitle(graph, 'IN_LORA')) return null;
  if ((graph[findNodeId(graph, 'IN_LORA_ON')] as ApiNode).inputs.value !== true) {
    dropInput(graph, 'IN_LORA');
    return null;
  }
  // Trennzeichen nur mit Trigger, sonst endete der Prompt auf „, “
  const trigger = (graph[findNodeId(graph, 'IN_LORA_TRIGGER')] as ApiNode).inputs;
  if (typeof trigger.value === 'string' && trigger.value.trim()) trigger.value = `, ${trigger.value.trim()}`;
  return String((graph[findNodeId(graph, 'IN_LORA')] as ApiNode).inputs.lora_name);
}

/** Hängt je Referenzbild einen LoadImage-Node an und verdrahtet ihn mit allen Zielen; ändert graph. */
export function addRefs(graph: ApiGraph, map: WorkflowMap, names: string[]): void {
  if (names.length === 0) return;
  const spec = map.refs;
  if (!spec) throw new Error(`${map.name} nimmt keine Referenzbilder`);
  if (names.length > spec.max) throw new Error(`Höchstens ${spec.max} Referenzbilder, nicht ${names.length}`);
  if ('field' in (spec.targets[0] ?? {}) && spec.max > 1) throw new Error(`${map.name}: festes Zielfeld nur bei max 1`);
  let next = Math.max(0, ...Object.keys(graph).map(Number).filter(Number.isInteger)) + 1;
  names.forEach((image, i) => {
    const id = String(next++);
    graph[id] = { class_type: 'LoadImage', inputs: { image }, _meta: { title: `REF_${i + 2}` } };
    for (const t of spec.targets) {
      const node = graph[findNodeId(graph, t.node)] as ApiNode;
      const field = 'field' in t ? t.field : `${t.prefix}${t.start + i}`;
      if (field in node.inputs) throw new Error(`${t.node}.${field} ist schon belegt`);
      node.inputs[field] = [id, 0];
    }
  });
}

/** Nimmt einen Eingabe-Node samt aller Kanten auf ihn aus dem Graphen (optionales Bild ohne Datei); ändert graph. */
export function dropInput(graph: ApiGraph, title: string): void {
  const id = findNodeId(graph, title);
  delete graph[id];
  for (const node of Object.values(graph)) {
    for (const [field, v] of Object.entries(node.inputs)) if (Array.isArray(v) && v[0] === id) delete node.inputs[field];
  }
}

export function coerce(key: string, spec: FieldSpec, raw: ParamValue | undefined, rand: () => number): ParamValue {
  if (raw === undefined) {
    if (spec.random) {
      const min = spec.min ?? 0;
      const max = spec.max ?? Number.MAX_SAFE_INTEGER;
      return min + Math.floor(rand() * (max - min + 1));
    }
    if (spec.default !== undefined) return spec.default;
    throw new Error(`Parameter ${key} fehlt`);
  }
  // JSON kennt null, ParamValue nicht – Number(null) wäre still 0
  if ((raw as unknown) === null) throw new Error(`${key}: Wert fehlt`);
  switch (spec.type) {
    case 'string':
    case 'image':
    case 'video':
      if (typeof raw !== 'string' || (raw === '' && !(spec.type === 'string' && spec.optional))) throw new Error(`${key}: Text erwartet`);
      return raw;
    case 'bool':
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true' || raw === 'false') return raw === 'true';
      throw new Error(`${key}: true oder false erwartet`);
    case 'enum':
      if (typeof raw === 'string' && spec.options?.includes(raw)) return raw;
      throw new Error(`${key}: ${String(raw)} ist keine erlaubte Option`);
    case 'int':
    case 'float': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n) || (spec.type === 'int' && !Number.isInteger(n))) {
        throw new Error(`${key}: ${String(raw)} ist keine gültige Zahl`);
      }
      if ((spec.min !== undefined && n < spec.min) || (spec.max !== undefined && n > spec.max)) {
        throw new Error(`${key}: ${n} liegt außerhalb ${spec.min ?? '-∞'}…${spec.max ?? '∞'}`);
      }
      return n;
    }
  }
}

/** Setzt die Parameter in eine Kopie der Vorlage; die Vorlage selbst bleibt unverändert. */
export function applyParams(
  wf: Workflow,
  params: Record<string, ParamValue>,
  rand: () => number = Math.random,
): { graph: ApiGraph; values: Record<string, ParamValue> } {
  for (const key of Object.keys(params)) {
    if (!(key in wf.map.inputs)) throw new Error(`Unbekannter Parameter ${key} für ${wf.map.name}`);
  }
  const graph = structuredClone(wf.api);
  const values: Record<string, ParamValue> = {};
  for (const [key, spec] of Object.entries(wf.map.inputs)) {
    const node = graph[findNodeId(graph, spec.node)] as ApiNode;
    if (!(spec.field in node.inputs)) throw new Error(`${spec.node} hat kein Feld ${spec.field}`);
    // Ein verknüpftes Feld zu überschreiben würde die Kante im Graphen kappen.
    if (Array.isArray(node.inputs[spec.field])) throw new Error(`${spec.node}.${spec.field} ist verknüpft, nicht setzbar`);
    const value = coerce(key, spec, params[key], rand);
    node.inputs[spec.field] = value;
    values[key] = value;
  }
  return { graph, values };
}

const SAMPLERS = new Set(['KSampler', 'KSamplerAdvanced', 'SamplerCustomAdvanced']);
export const isSampler = (classType: string | undefined) => SAMPLERS.has(classType ?? '');

/** Sampler im Graphen: je einer ist ein Durchgang mit eigenen Schritten (LTX und Wan haben zwei). */
export function samplerCount(api: ApiGraph): number {
  return Object.values(api).filter((n) => isSampler(n.class_type)).length;
}
