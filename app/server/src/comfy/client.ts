import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { MemoryStats } from '@brennglas/shared';

export interface ComfyMessage {
  type: string;
  data: Record<string, unknown>;
}

export interface ComfyImageRef {
  filename: string;
  subfolder: string;
  type: string;
}

export interface HistoryEntry {
  status?: { status_str?: string; messages?: [string, Record<string, unknown>][] };
  outputs: Record<string, { images?: ComfyImageRef[]; videos?: ComfyImageRef[]; text?: string[] }>;
}

/** REST + ein WebSocket mit festem clientId, verbindet sich selbst neu. Events: connected, disconnected, message. */
export class ComfyClient extends EventEmitter {
  readonly clientId = randomUUID();
  connected = false;
  private ws: WebSocket | null = null;
  private retryMs = 1000;
  private closing = false;
  private readonly base: string;

  constructor(base: string) {
    super();
    this.base = base;
  }

  connect(): void {
    const ws = new WebSocket(`${this.base.replace(/^http/, 'ws')}/ws?clientId=${this.clientId}`);
    this.ws = ws;
    ws.on('open', () => {
      this.connected = true;
      this.retryMs = 1000;
      this.emit('connected');
    });
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return this.onBinary(raw as Buffer);
      try {
        this.emit('message', JSON.parse(raw.toString()) as ComfyMessage);
      } catch {
        // kaputte Nachricht ignorieren, die Verbindung bleibt
      }
    });
    ws.on('error', () => {}); // close folgt und regelt den Neuaufbau
    ws.on('close', () => {
      const was = this.connected;
      this.connected = false;
      if (was) this.emit('disconnected');
      if (this.closing) return;
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 10_000);
    });
  }

  /** Altes Vorschauformat (ohne feature_flags): u32 Typ 1, u32 Bildformat 1=JPEG 2=PNG, dann das Bild. */
  private onBinary(buf: Buffer): void {
    if (buf.length < 9 || buf.readUInt32BE(0) !== 1) return;
    this.emit('preview', { mime: buf.readUInt32BE(4) === 2 ? 'image/png' : 'image/jpeg', data: buf.subarray(8) });
  }

  close(): void {
    this.closing = true;
    this.ws?.close();
  }

  private async req(path: string, init?: RequestInit): Promise<Response> {
    return fetch(this.base + path, { ...init, signal: AbortSignal.timeout(30_000) });
  }

  /** preview: Zwischenbilder je Sampler-Schritt anfordern (ComfyUI startet ohne). front: vor alle wartenden. */
  async queuePrompt(graph: unknown, preview = false, front = false): Promise<string> {
    return this.postPrompt({ prompt: graph, ...(front ? { front: true } : {}), ...(preview ? { extra_data: { preview_method: 'latent2rgb' } } : {}) });
  }

  private async postPrompt(payload: Record<string, unknown>): Promise<string> {
    const res = await this.req('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, client_id: this.clientId }),
    });
    const body = (await res.json()) as { prompt_id?: string; error?: { message?: string }; node_errors?: unknown };
    if (!res.ok || !body.prompt_id) {
      throw new Error(`ComfyUI lehnt ab: ${body.error?.message ?? res.status} ${JSON.stringify(body.node_errors ?? '')}`);
    }
    return body.prompt_id;
  }

  /** Legt das Bild in ComfyUIs input-Ordner; zurück kommt der Name für LoadImage. */
  async uploadImage(data: Buffer, filename: string): Promise<string> {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(data)]), filename);
    form.append('overwrite', 'true');
    const res = await this.req('/upload/image', { method: 'POST', body: form });
    if (!res.ok) throw new Error(`Upload zu ComfyUI fehlgeschlagen: ${res.status}`);
    const up = (await res.json()) as { name: string; subfolder: string };
    return up.subfolder ? `${up.subfolder}/${up.name}` : up.name;
  }

  /** Bricht nur diesen Job ab; ältere ComfyUI-Versionen ignorieren die prompt_id und stoppen den laufenden. */
  async interrupt(promptId: string): Promise<void> {
    await this.req('/interrupt', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt_id: promptId }),
    });
  }

  async deleteFromQueue(promptId: string): Promise<void> {
    await this.req('/queue', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delete: [promptId] }),
    });
  }

  /** Dateinamen in einem ComfyUI-Modellordner, z. B. diffusion_models. */
  async listModels(folder: string): Promise<string[]> {
    const res = await this.req(`/models/${encodeURIComponent(folder)}`);
    if (!res.ok) throw new Error(`/models/${folder}: HTTP ${res.status}`);
    const body: unknown = await res.json();
    return Array.isArray(body) ? body.filter((x): x is string => typeof x === 'string') : [];
  }

  /** Modelle aus dem VRAM werfen – für 3ds Max/Blender nebenher. */
  async free(): Promise<void> {
    const res = await this.req('/free', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }),
    });
    if (!res.ok) throw new Error(`ComfyUI /free: ${res.status}`);
  }

  async memory(): Promise<MemoryStats> {
    const res = await this.req('/system_stats');
    if (!res.ok) throw new Error(`/system_stats: HTTP ${res.status}`);
    const body = (await res.json()) as { system?: { ram_total?: unknown; ram_free?: unknown }; devices?: { vram_total?: unknown; vram_free?: unknown }[] };
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const gpu = body.devices?.[0];
    const ramTotal = num(body.system?.ram_total);
    return {
      vram: gpu && num(gpu.vram_total) > 0 ? { used: num(gpu.vram_total) - num(gpu.vram_free), total: num(gpu.vram_total) } : null,
      ram: { used: ramTotal - num(body.system?.ram_free), total: ramTotal },
    };
  }

  async history(promptId: string): Promise<HistoryEntry | undefined> {
    const res = await this.req(`/history/${promptId}`);
    const body = (await res.json()) as Record<string, HistoryEntry>;
    return body[promptId];
  }

  /** pending in Ausführungsreihenfolge – ComfyUI liefert die Heap-Reihenfolge, nicht sortiert. */
  async queue(): Promise<{ running: string[]; pending: string[] }> {
    const q = await this.rawQueue();
    const ids = (entries: unknown[][]) => entries.map((e) => String(e[1]));
    return { running: ids(q.running), pending: ids(q.pending) };
  }

  private async rawQueue(): Promise<{ running: unknown[][]; pending: unknown[][] }> {
    const res = await this.req('/queue');
    const body = (await res.json()) as { queue_running: unknown[][]; queue_pending: unknown[][] };
    return { running: body.queue_running, pending: [...body.queue_pending].sort((a, b) => Number(a[0]) - Number(b[0])) };
  }

  /**
   * Wartenden Prompt an die Spitze: löschen und mit derselben prompt_id und front neu einreihen.
   * false = lief schon an oder stand nicht mehr in der Queue; wirft, wenn das neue Einreihen scheitert.
   */
  async toFront(promptId: string): Promise<boolean> {
    const entry = (await this.rawQueue()).pending.find((e) => e[1] === promptId);
    if (!entry) return false;
    await this.deleteFromQueue(promptId);
    const after = await this.rawQueue();
    if ([...after.running, ...after.pending].some((e) => e[1] === promptId)) return false;
    const extra = typeof entry[3] === 'object' && entry[3] !== null ? entry[3] : {};
    await this.postPrompt({ prompt: entry[2], prompt_id: promptId, front: true, extra_data: extra });
    return true;
  }

  async view(img: ComfyImageRef): Promise<Buffer> {
    const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder, type: img.type });
    const res = await this.req(`/view?${q}`);
    if (!res.ok) throw new Error(`Bild nicht abrufbar: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
