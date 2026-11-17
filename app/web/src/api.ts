import type { Figure, FigureRequest, GenerateRequest, Generation, GenerationFilter, Health, MemoryStats, ModelInfo, Page, QueueItem, SseEvent, UploadResult, WorkflowInfo } from '@brennglas/shared';

/** Der Typ kommt aus der Windows-Registry und ist uneinheitlich (.aac = audio/vnd.dlna.adts); die Endung entscheidet. */
function audioType(file: File): string {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return ({ mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg' } as Record<string, string>)[ext] ?? file.type;
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export const api = {
  workflows: () => fetch('/api/workflows').then((r) => json<WorkflowInfo[]>(r)),
  models: () => fetch('/api/models').then((r) => json<ModelInfo[]>(r)),
  health: () => fetch('/api/health').then((r) => json<Health>(r)),
  generation: (id: string) => fetch(`/api/generations/${id}`).then((r) => json<Generation>(r)),
  chain: (id: string) => fetch(`/api/generations/${id}/chain`).then((r) => json<Generation[]>(r)),
  upload: (file: Blob) =>
    fetch('/api/upload', { method: 'POST', headers: { 'content-type': file.type }, body: file }).then((r) => json<UploadResult>(r)),
  generations: (cursor: number | null, filter: GenerationFilter = {}, limit = 40) => {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set('cursor', String(cursor));
    if (filter.q) q.set('q', filter.q);
    if (filter.favorite) q.set('fav', '1');
    return fetch(`/api/generations?${q}`).then((r) => json<Page<Generation>>(r));
  },
  favorite: (id: string, favorite: boolean) =>
    fetch(`/api/generations/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ favorite }),
    }).then((r) => json<{ favorite: boolean }>(r)),
  remove: (id: string) => fetch(`/api/generations/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: true }>(r)),
  cancel: (id: string) => fetch(`/api/generations/${id}/cancel`, { method: 'POST' }).then((r) => json<{ ok: true }>(r)),
  openFolder: (id?: string) =>
    fetch('/api/open-folder', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }).then((r) => json<{ ok: true }>(r)),
  queue: () => fetch('/api/queue').then((r) => json<QueueItem[]>(r)),
  toFront: (id: string) => fetch(`/api/generations/${id}/front`, { method: 'POST' }).then((r) => json<{ ok: true }>(r)),
  memory: () => fetch('/api/comfy/memory').then((r) => json<MemoryStats>(r)),
  freeVram: () => fetch('/api/comfy/free', { method: 'POST' }).then((r) => json<{ ok: true }>(r)),
  enhance: (req: GenerateRequest) =>
    fetch('/api/enhance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) })
      .then((r) => json<{ text: string }>(r)),
  figures: () => fetch('/api/figures').then((r) => json<Figure[]>(r)),
  createFigure: (req: FigureRequest) =>
    fetch('/api/figures', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) }).then((r) => json<Figure>(r)),
  deleteFigure: (id: string) => fetch(`/api/figures/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: true }>(r)),
  /** Musik für den Schnitt; die Antwort ist der Pfad, den concat als music nimmt. */
  uploadAudio: (file: File) =>
    fetch('/api/audio', { method: 'POST', headers: { 'content-type': audioType(file) }, body: file }).then((r) => json<{ path: string }>(r)),
  concat: (body: Record<string, unknown>) =>
    fetch('/api/concat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => json<Generation>(r)),
  concatPreview: (body: Record<string, unknown>) =>
    fetch('/api/concat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => json<{ url: string; duration: number }>(r)),
  generate: (req: GenerateRequest) =>
    fetch('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    }).then((r) => json<{ id: string }>(r)),
};

export const imageUrl = (id: string, kind: 'full' | 'preview' | 'thumb' | 'input') => `/api/images/${id}/${kind}`;
export const videoUrl = (id: string) => `/api/images/${id}/video`;
export const refUrl = (id: string, n: number) => `/api/images/${id}/ref/${n}`;
/** Drag-Typ für Galerie-Bilder, Inhalt ist die Generation-ID. */
export const GEN_DRAG = 'application/x-brennglas-generation';

/** EventSource verbindet sich bei Abbruch selbst neu; was in der Lücke gesendet wurde, holt onReconnect nach. */
export function subscribe(onEvent: (ev: SseEvent) => void, onReconnect: () => void = () => {}): void {
  let opened = false;
  const open = (): void => {
    const es = new EventSource('/api/events');
    es.onopen = () => { if (opened) onReconnect(); opened = true; };
    es.onmessage = (m) => onEvent(JSON.parse(m.data as string) as SseEvent);
    // Antwortet der Vite-Proxy beim Backend-Neustart mit 500, gibt EventSource endgültig auf – dann selbst neu.
    es.onerror = () => { if (es.readyState === EventSource.CLOSED) setTimeout(open, 2000); };
  };
  open();
}
