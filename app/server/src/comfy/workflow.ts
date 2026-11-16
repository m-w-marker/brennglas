import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FieldSpec, ParamValue, WorkflowMap } from '@brennglas/shared';

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

export function loadWorkflow(dir: string, name: string): Workflow {
  const api = JSON.parse(readFileSync(join(dir, `${name}.api.json`), 'utf8')) as ApiGraph;
  const map = JSON.parse(readFileSync(join(dir, `${name}.map.json`), 'utf8')) as WorkflowMap;
  // Ein umbenannter Node soll beim Laden auffallen, nicht erst mitten im Job.
  for (const spec of [...Object.values(map.inputs), ...Object.values(map.outputs), ...(map.refs?.targets ?? [])]) findNodeId(api, spec.node);
  return { api, map };
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
      if (typeof raw !== 'string' || raw === '') throw new Error(`${key}: Text erwartet`);
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
