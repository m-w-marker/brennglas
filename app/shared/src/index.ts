export type InputType = 'string' | 'int' | 'float' | 'bool' | 'enum' | 'image';
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
  /** Feste Stufen statt freier Zahl, z. B. Fast Draft / Balanced / High Quality. */
  presets?: { label: Text; value: number }[];
  /** Einheit hinter Zahlen und Stufen, z. B. MP. */
  unit?: string;
  step?: number;
  /** Landet im einklappbaren Bereich „Erweitert“. */
  advanced?: boolean;
  /** Setzt nur das Backend, nicht im Formular. */
  hidden?: boolean;
  /** Bild darf fehlen: das Backend nimmt den Node samt Kanten aus dem Graphen. */
  optional?: boolean;
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

export type Mode = 't2i' | 'edit' | 'upscale' | 'video' | 't2v' | 'i2v' | 'flf2v' | 'prompt';

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
  modes: Partial<Record<Mode, string>>;
  license: ModelLicense;
}

/** Eintrag der Warteschlange: laufend zuerst, dann wartend in Ausführungsreihenfolge. */
export interface QueueItem {
  generation: Generation;
  state: 'running' | 'waiting';
  /** Wartet in ComfyUI und steht nicht schon vorn. */
  canFront: boolean;
}

/** Speicher laut ComfyUI /system_stats, in Bytes; vram null ohne GPU. */
export interface MemoryStats {
  vram: { used: number; total: number } | null;
  ram: { used: number; total: number };
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

export type FigureKind = 'person' | 'product';

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

export interface FigureRequest {
  name: string;
  kind: FigureKind;
  /** Porträt bzw. Packshot. */
  portrait: ImageSource;
  /** Edit-Workflow, der das Blatt rechnet. */
  workflow: string;
  /** Person: Kleidung für die Ganzkörper-Ansicht · Produkt: Details, die das Foto nicht zeigt (z. B. die Rückseite). */
  outfit?: string;
}

export interface GenerationFilter {
  q?: string;
  favorite?: boolean;
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
  | { type: 'progress'; id: string; value: number; max: number; stage: string | null }
  /** Zwischenbild des Samplers als data-URL, nur für den laufenden Job. */
  | { type: 'preview'; id: string; url: string }
  | { type: 'done'; generation: Generation }
  | { type: 'error'; id: string; error: string }
  | { type: 'comfy'; connected: boolean }
  | { type: 'queue'; remaining: number }
  | { type: 'favorite'; id: string; favorite: boolean }
  | { type: 'deleted'; id: string };
