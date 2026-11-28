export type InputType = 'string' | 'int' | 'float' | 'bool' | 'enum' | 'image' | 'video';
export type ParamValue = string | number | boolean;
/** Anzeigetext: einfach oder je Sprache. */
export type Text = string | { de: string; en: string };

/** Ein Formularfeld; InputSpec setzt es zusätzlich in einen Node des Graphen. */
export interface FieldSpec {
  type: InputType;
  default?: ParamValue;
  random?: boolean;
  min?: number;
  max?: number;
  options?: string[];
  /** Anzeige je Option; ohne Eintrag steht der Wert selbst da. */
  optionLabels?: Record<string, Text>;
  /** Hinweis unter der Auswahl, solange diese Option gewählt ist. */
  optionHints?: Record<string, Text>;
  /** Anzeige im Formular; ohne Angabe der Schlüssel. */
  label?: Text;
  placeholder?: Text;
  /** Erklärung, die immer unter dem Feld steht (der Platzhalter verschwindet, sobald etwas drinsteht). */
  hint?: Text;
  /** Feste Stufen statt freier Zahl, z. B. Fast Draft / Balanced / High Quality. */
  presets?: { label: Text; value: number }[];
  /** Einheit hinter Zahlen und Stufen, z. B. MP. */
  unit?: string;
  step?: number;
  /** Landet im einklappbaren Bereich „Erweitert“. */
  advanced?: boolean;
  /** Setzt nur das Backend, nicht im Formular. */
  hidden?: boolean;
  /** Bild darf fehlen (das Backend nimmt den Node samt Kanten heraus), Text darf leer sein. */
  optional?: boolean;
  /** Auswahl = LoRAs dieses Modells aus `models/loras.json`, füllt das Backend beim Laden (→ plan_loras). */
  loras?: string;
  /** Trigger-Wort je Option; das Backend hängt es an den Prompt, solange die LoRA an ist. */
  triggers?: Record<string, string>;
  /** Nur sichtbar, solange dieses Bool-Feld an ist. */
  showIf?: string;
  /** Wird beim Wechsel dieses Felds (einer LoRA-Auswahl) mit deren Trigger vorbelegt. */
  fillFrom?: string;
}

export interface InputSpec extends FieldSpec {
  node: string;
  field: string;
}

export interface OutputSpec {
  node: string;
  optional?: boolean;
}

/** Weitere Bilder nach dem Hauptbild; das Backend hängt je Bild einen LoadImage-Node an. */
export interface RefSpec {
  max: number;
  /** Mindestzahl, z. B. 1 für das Endbild bei Start + Ende. */
  min?: number;
  /** Schreibweise im Prompt: {n} = Bildnummer ab 1 (<Picture {n}>, <image{n}>), {i} = ab 0 (<ref_image_{i}>); leer = nicht im Prompt. */
  token: string;
  /** Referenzen vor dem Hochladen auf höchstens so viele Pixel verkleinern (Qwen kodiert sie sonst in voller Größe). */
  maxPixels?: number;
  /** Je Ziel-Node: Feld = prefix + (start + i), z. B. images.image_2 – oder ein festes Feld bei max 1. */
  targets: ({ node: string; prefix: string; start: number } | { node: string; field: string })[];
}

export interface WorkflowMap {
  name: string;
  label: Text;
  /** Beschriftung des Absende-Knopfs. */
  submit?: Text;
  inputs: Record<string, InputSpec>;
  refs?: RefSpec;
  outputs: Record<string, OutputSpec>;
  /** video: ein Job aus vielen Blöcken, Quelle und Ziel sind Ordner (→ plan_video_upscale). text: liefert nur Text, ohne Galerie. */
  kind?: 'video' | 'text';
  /** Felder des Jobs selbst, nicht des Graphen – z. B. Quell- und Zielordner. */
  job?: Record<string, FieldSpec>;
}

export type Mode = 't2i' | 'edit' | 'upscale' | 'video' | 't2v' | 'i2v' | 'flf2v' | 'l2v' | 'prompt';

export interface ModelLicense {
  name: string;
  url: string;
  /** yes = frei, limited = mit Bedingungen, no = nicht kommerziell. */
  commercial: 'yes' | 'limited' | 'no';
  summary: Text;
}

/** Inhalt einer app/models/<id>.model.json. */
export interface ModelSpec {
  id: string;
  /** Anzeigename; Produktnamen als Text, ein Gattungsname je Sprache. */
  name: Text;
  short: string;
  vendor: string;
  order: number;
  /** Nur im privaten Repo: der Export ins öffentliche lässt Modell, Workflows und nur hiervon genutzte Downloads weg. */
  private?: boolean;
  /** Im Installer als Empfehlung markiert, per „rec“ wählbar. */
  recommended?: boolean;
  modes: Partial<Record<Mode, string>>;
  /** Erkennung eigener LoRAs: ein Schlüssel passt auf key (RegExp), seine lora_A/down-Matrix ist width breit. */
  lora?: { key: string; width: number };
  license: ModelLicense;
  bench?: ModelBench;
}

/** Eigene Laufzeiten, Schlüssel aus statKey: Median in ms und Zahl der Läufe. */
export type DurationStats = Record<string, { ms: number; n: number }>;

/** Schlüssel der Laufzeit-Statistik: Workflow, Megapixel-Stufe (nur Bilder), +pe mit Prompt-Erweiterung. */
export const statKey = (workflow: string, mp: number | undefined, enhanced: boolean): string =>
  `${workflow}${mp === undefined ? '' : `@${mp}`}${enhanced ? '+pe' : ''}`;

/** Gemessen auf RTX 3090 (plan_modellhilfe.md Phase 1): Tempo je Modus als Faktor, FLUX Text to Image 2 MP = 1. */
export interface ModelBench {
  speed: Partial<Record<Mode, number>>;
  /** Mit Prompt-Erweiterung, wo der Modus sie hat. */
  speedEnhanced?: Partial<Record<Mode, number>>;
  /** Andere Megapixel-Stufen (Schlüssel „1“, „4“ …); speed/speedEnhanced oben gelten für 2 MP. */
  speedAt?: Record<string, { speed: Partial<Record<Mode, number>>; speedEnhanced?: Partial<Record<Mode, number>> }>;
  /** Woran der Faktor gemessen ist, wenn nicht 2 MP (Video: Auflösung, Länge). */
  basis?: Text;
  /** Empfohlener Arbeitsspeicher für 12–16-GB-Karten. */
  ramGB: number;
}

/** Eintrag der Warteschlange: laufend zuerst, dann wartend in Ausführungsreihenfolge. */
export interface QueueItem {
  generation: Generation;
  state: 'running' | 'waiting';
  /** Wartet in ComfyUI und steht nicht schon vorn. */
  canFront: boolean;
}

/** Speicher laut ComfyUI /system_stats, in Bytes; vram null ohne GPU. */
/** Pfade für den MCP-Eintrag in Claude Desktop / Claude Code: das laufende Node und der MCP-Server. */
export interface ClaudeConfig {
  node: string;
  script: string;
}

export interface MemoryStats {
  vram: { used: number; total: number } | null;
  ram: { used: number; total: number };
  /** GPU-Last in %, null ohne nvidia-smi. */
  gpu?: number | null;
}

export interface ModelInfo extends ModelSpec {
  /** Fehlende Dateien als ordner/datei; null = ComfyUI nicht erreichbar, unbekannt. */
  missing: string[] | null;
  /** Download-Link je Datei (ordner/datei) aus models/downloads.json. */
  downloads: Record<string, string>;
}

export interface WorkflowInfo {
  name: string;
  label: Text;
  submit?: Text;
  kind?: 'video' | 'text';
  /** Sichtbare Felder: bei Video erst die des Jobs, dann die des Graphen. */
  inputs: Record<string, FieldSpec>;
  /** Höchstzahl der Referenzbilder zusätzlich zum Hauptbild. */
  refs: number;
  refToken?: string;
}

export type GenStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface Generation {
  id: string;
  workflow: string;
  status: GenStatus;
  prompt: string;
  expandedPrompt: string | null;
  params: Record<string, ParamValue>;
  parentId: string | null;
  hasInput: boolean;
  /** Ergebnis ist ein Video (/api/images/:id/video); preview und thumb zeigen einen Frame daraus. */
  video: boolean;
  /** Referenzbilder, abrufbar unter /api/images/:id/ref/1 … */
  refCount: number;
  width: number | null;
  height: number | null;
  error: string | null;
  favorite: boolean;
  durationMs: number | null;
  createdAt: string;
  /** Teil einer Serie (mehrere Varianten auf einen Klick), index ab 1. */
  series: SeriesRef | null;
}

export interface SeriesRef {
  id: string;
  index: number;
  size: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: number | null;
}

export interface GenerateRequest {
  workflow: string;
  /** Pflicht nur, wenn die Map ein Feld prompt hat. */
  prompt?: string;
  params?: Record<string, ParamValue>;
  /** Bild 1 wird bearbeitet, weitere sind Referenzen (im Prompt per RefSpec.token, z. B. <Picture n>). */
  images?: ImageSource[];
  series?: SeriesRef;
  /** Figuren-IDs: neue Szene auf leerer Fläche, je Figur Porträt + Blatt als Referenz; images kommen danach. → plan_referenz */
  figures?: string[];
  /** Seitenverhältnis der Szene (Breite/Höhe), nur mit figures; Standard 16:9. */
  aspect?: number;
}

/** upload: POST /api/upload · output: Ergebnis eines Jobs (Kette) · input: Eingabebild n eines Jobs, 0 = Hauptbild ·
 *  blank: leere graue Fläche im Seitenverhältnis Breite/Höhe, als Bild 1 einer neuen Szene aus Referenzen. */
export type ImageSource =
  | { kind: 'upload'; id: string }
  | { kind: 'output'; id: string }
  | { kind: 'input'; id: string; index: number }
  | { kind: 'blank'; aspect: number };

/** person = menschenähnliche Figur (auch Cartoon, humanoides Monster), creature = Wesen ohne Menschengestalt. */
export type FigureKind = 'person' | 'creature' | 'product';

export interface SheetPanel {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Blatt-Raster: 2 MP in 16:9 im 32er-Raster, damit die Edit-Workflows die Vorlage nicht skalieren. → plan_figurenblatt */
export const SHEET_SIZE = { width: 1920, height: 1088 } as const;

/** Felder je Art in der Reihenfolge des Prompts; Vorlage, Zusammensetzen und Zurückkleben nutzen dieselben Maße. */
export const SHEET_PANELS: Record<FigureKind, readonly SheetPanel[]> = {
  // Ganzkörper vorn, Ganzkörper Rücken, halbnah 45°, Kopf nah leicht gedreht
  person: [{ x: 0, y: 0, w: 384, h: 1088 }, { x: 384, y: 0, w: 384, h: 1088 }, { x: 768, y: 0, w: 576, h: 1088 }, { x: 1344, y: 0, w: 576, h: 1088 }],
  // vorn, Seite, Rücken, Kopf nah
  creature: [{ x: 0, y: 0, w: 960, h: 544 }, { x: 960, y: 0, w: 960, h: 544 }, { x: 0, y: 544, w: 960, h: 544 }, { x: 960, y: 544, w: 960, h: 544 }],
  // vorn, 45°, Rücken, Detail
  product: [{ x: 0, y: 0, w: 448, h: 1088 }, { x: 448, y: 0, w: 448, h: 1088 }, { x: 896, y: 0, w: 448, h: 1088 }, { x: 1344, y: 0, w: 576, h: 1088 }],
};

/** Weitere Fotos derselben Figur als Referenzen neben dem Porträt. */
export const MAX_EXTRA_VIEWS = 4;

/** Blatt auf der Vorlage oder frei auf Weiß; FLUX übernahm Kopf- und Stoffformen der Vorlage (Benchmark 23.11.2026, plan_figurenblatt). */
export const sheetTemplateDefault = (workflow: string): boolean => workflow !== 'flux3-edit';

/** Gleichbleibende Figur oder gleichbleibendes Produkt: das Porträt ist Referenz 1 des Blatt-Jobs. → plan_referenz */
export interface Figure {
  id: string;
  name: string;
  kind: FigureKind;
  sheetId: string;
  /** Der Blatt-Job; fehlt, wenn er aus der Datenbank verschwunden ist. */
  sheet: Generation | null;
  createdAt: string;
}

/** Blatt rechnen (Vorschau), ohne schon eine Figur anzulegen. Vorrang: sheet, dann views, sonst rechnet das Modell. */
export interface FigureSheetRequest {
  kind: FigureKind;
  /** Porträt bzw. Packshot; bleibt Referenz 1 des Blatts und geht so in jede Szene. */
  portrait: ImageSource;
  /** Edit-Workflow, der das Blatt rechnet. */
  workflow: string;
  /** Person: Kleidung in allen Ansichten · Kreatur und Produkt: Details, die das Foto nicht zeigt (z. B. die Rückseite). */
  outfit?: string;
  /** Mit Vorlage (Raster aus Puppen) oder frei auf weißer Fläche; fehlt es, gilt sheetTemplateDefault. */
  template?: boolean;
  /** Weitere Fotos derselben Figur als Referenzen, höchstens MAX_EXTRA_VIEWS. */
  extra?: ImageSource[];
  /** Ein Foto je Feld, alle vier in der Reihenfolge von SHEET_PANELS: wird nur zusammengesetzt, kein Modell-Lauf. */
  views?: ImageSource[];
  /** Fertiges Blatt (eigene Collage), wird unverändert übernommen. */
  sheet?: ImageSource;
}

/** Figur speichern: aus einer fertigen Vorschau (sheetId) oder in einem Zug, dann wird das Blatt erst gerechnet. */
export type FigureRequest = { name: string } & ({ kind: FigureKind; sheetId: string } | FigureSheetRequest);

export interface GenerationFilter {
  q?: string;
  favorite?: boolean;
  /** Nur diese Workflows (Modell- oder Art-Filter der Galerie); leer = nichts. */
  workflows?: string[];
  /** Diese Workflows ausblenden (Art „Bilder“ = alles außer Video). */
  notWorkflows?: string[];
}

export interface UploadResult {
  inputId: string;
  width: number;
  height: number;
}

export interface Health {
  comfy: boolean;
  queueRunning: number;
  queuePending: number;
}

export type SseEvent =
  | { type: 'status'; id: string; status: GenStatus }
  | { type: 'progress'; id: string; value: number; max: number; stage: string | null; pass?: number; passes?: number }
  /** Zwischenbild des Samplers als data-URL, nur für den laufenden Job. */
  | { type: 'preview'; id: string; url: string }
  | { type: 'done'; generation: Generation }
  | { type: 'error'; id: string; error: string }
  | { type: 'comfy'; connected: boolean }
  | { type: 'queue'; remaining: number }
  | { type: 'favorite'; id: string; favorite: boolean }
  | { type: 'deleted'; id: string }
  /** Eine Figur wurde angelegt, geändert oder gelöscht (auch per MCP). */
  | { type: 'figures' };

/** Bildbearbeitung → plan_bildbearbeitung: Projekt = Ebenen mit Quellen, gespeichert in den params des Ergebnisses. */
export const BLEND_MODES = ['normal', 'multiply', 'screen', 'overlay', 'soft-light', 'color-dodge'] as const;
export type BlendMode = (typeof BLEND_MODES)[number];
/** Obergrenze je Ebene und Arbeitsfläche, etwa ein generiertes Bild (2048²); größere Fotos werden beim Laden verkleinert. */
export const EDIT_MAX_PIXELS = 2048 * 2048;
export const EDIT_MAX_LAYERS = 40;
export type LayerSource = { kind: 'output' | 'input'; id: string };
export interface EditLayer {
  kind: 'image' | 'fill';
  name: string;
  visible: boolean;
  opacity: number;
  blend: BlendMode;
  /** Lage der Ebene auf der Arbeitsfläche in Pixeln, gespiegelt wird in ihrem eigenen Rahmen. */
  x: number;
  y: number;
  scale: number;
  flip: boolean;
  /** Nur Farbfläche. */
  color?: string;
  /** Nur Bildebene. */
  src?: LayerSource;
}
export interface EditProject { width: number; height: number; layers: EditLayer[] }

/** Fremde Daten (Request, alter Galerie-Eintrag): unbrauchbare Ebenen fallen weg, Werte werden begrenzt; null = keine Arbeitsfläche. */
export function parseEditProject(raw: unknown): EditProject | null {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const size = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 8192 ? v : null);
  const width = size(o.width);
  const height = size(o.height);
  if (width === null || height === null || width * height > EDIT_MAX_PIXELS) return null;
  const num = (v: unknown, d: number, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d);
  const layers = (Array.isArray(o.layers) ? o.layers : []).slice(0, EDIT_MAX_LAYERS).flatMap((x): EditLayer[] => {
    const l = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const base = {
      name: typeof l.name === 'string' ? l.name.slice(0, 80) : '',
      visible: l.visible !== false,
      opacity: num(l.opacity, 1, 0, 1),
      blend: BLEND_MODES.includes(l.blend as BlendMode) ? (l.blend as BlendMode) : 'normal',
      x: num(l.x, 0, -1e5, 1e5),
      y: num(l.y, 0, -1e5, 1e5),
      scale: num(l.scale, 1, 0.01, 20),
      flip: l.flip === true,
    };
    if (l.kind === 'fill') return [{ kind: 'fill', ...base, color: typeof l.color === 'string' && /^#[0-9a-f]{6}$/i.test(l.color) ? l.color : '#ffffff' }];
    const s = (l.src && typeof l.src === 'object' ? l.src : {}) as Record<string, unknown>;
    if (l.kind !== 'image' || (s.kind !== 'output' && s.kind !== 'input') || typeof s.id !== 'string' || !/^[0-9a-f-]{36,64}$/.test(s.id)) return [];
    return [{ kind: 'image', ...base, src: { kind: s.kind, id: s.id } }];
  });
  return { width, height, layers };
}

/** Einrasten auf einer Achse: nächste Zielkante zu Anfang oder Ende der Ebene innerhalb thr → [neue Lage, Kante | null]. */
export function snapAxis(pos: number, size: number, targets: number[], thr: number): [number, number | null] {
  let best: [number, number | null] = [Math.round(pos), null];
  let dist = thr;
  for (const at of targets) {
    for (const edge of [pos, pos + size]) {
      if (Math.abs(at - edge) <= dist) {
        dist = Math.abs(at - edge);
        best = [pos + at - edge, at];
      }
    }
  }
  return best;
}

/** Zoomstufen der Bildbearbeitung, 1 = ein Bildpixel auf ein Bildschirmpixel. */
export const ZOOM_LEVELS = [0.05, 0.1, 1 / 8, 1 / 6, 0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
/** Nächste Stufe vom aktuellen Zoom aus, auch wenn er (eingepasst) zwischen zwei Stufen liegt; Rundungsreste zählen als die Stufe. */
export function zoomStep(s: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_LEVELS.find((z) => z > s * 1.001) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1] ?? s;
  return [...ZOOM_LEVELS].reverse().find((z) => z < s / 1.001) ?? ZOOM_LEVELS[0] ?? s;
}
