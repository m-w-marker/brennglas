import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Figure, FigureKind, Generation, GenerationFilter, GenStatus, Page, ParamValue, SeriesRef } from '@brennglas/shared';

export type DB = Database.Database;

const MIGRATIONS = [
  `CREATE TABLE generations (
     id               TEXT PRIMARY KEY,
     workflow         TEXT NOT NULL,
     status           TEXT NOT NULL,
     prompt           TEXT NOT NULL,
     expanded_prompt  TEXT,
     params_json      TEXT NOT NULL,
     parent_id        TEXT REFERENCES generations(id),
     input_path       TEXT,
     output_path      TEXT,
     preview_path     TEXT,
     thumb_path       TEXT,
     width            INTEGER,
     height           INTEGER,
     comfy_prompt_id  TEXT,
     error            TEXT,
     favorite         INTEGER NOT NULL DEFAULT 0,
     duration_ms      INTEGER,
     created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   );
   CREATE INDEX idx_gen_created ON generations(created_at DESC);
   CREATE INDEX idx_gen_comfy ON generations(comfy_prompt_id);`,
  `ALTER TABLE generations ADD COLUMN input_preview_path TEXT;`,
  // Workflows tragen seit der Modellwahl das Modell im Namen.
  `UPDATE generations SET workflow = CASE workflow
     WHEN 't2i' THEN 'h3-t2i' WHEN 'edit' THEN 'h3-edit' WHEN 'upscale' THEN 'seedvr2-upscale'
     ELSE workflow END;`,
  // Referenzbilder als JSON [{ path, preview }], Reihenfolge = <Picture 2> …
  `ALTER TABLE generations ADD COLUMN refs_json TEXT;`,
  // Video-Modelle: MP4 neben dem Vorschau-Frame in output_path
  `ALTER TABLE generations ADD COLUMN video_path TEXT;`,
  // Serien: { id, index, size } – mehrere Varianten aus einem Klick
  `ALTER TABLE generations ADD COLUMN series_json TEXT;`,
  // Figuren: das Porträt ist Referenz 1 des Blatt-Jobs, darum nur dessen ID
  `CREATE TABLE figures (
     id          TEXT PRIMARY KEY,
     name        TEXT NOT NULL,
     kind        TEXT NOT NULL,
     sheet_id    TEXT NOT NULL REFERENCES generations(id),
     created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   );`,
];

export interface RefImage {
  path: string;
  preview: string;
}

export interface GenRow {
  rowid: number;
  id: string;
  workflow: string;
  status: GenStatus;
  prompt: string;
  expanded_prompt: string | null;
  params_json: string;
  parent_id: string | null;
  input_path: string | null;
  input_preview_path: string | null;
  refs_json: string | null;
  video_path: string | null;
  series_json: string | null;
  output_path: string | null;
  preview_path: string | null;
  thumb_path: string | null;
  width: number | null;
  height: number | null;
  comfy_prompt_id: string | null;
  error: string | null;
  favorite: number;
  duration_ms: number | null;
  created_at: string;
}

/** Übernimmt die DB unter altem Namen einmalig als Kopie; die alte Datei bleibt als Sicherung. */
export function adoptLegacyDb(file: string, legacy: string): boolean {
  if (existsSync(file) || !existsSync(legacy)) return false;
  // Ohne Checkpoint fehlten die Zeilen, die noch nur in der -wal stehen.
  const old = new Database(legacy);
  try {
    old.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    old.close();
  }
  copyFileSync(legacy, file);
  return true;
}

export function openDb(file: string): DB {
  const onDisk = file !== ':memory:';
  if (onDisk) mkdirSync(dirname(file), { recursive: true });
  const existed = onDisk && existsSync(file);
  const db = new Database(file);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    const version = db.pragma('user_version', { simple: true }) as number;
    // Vor jeder Migration einer bestehenden DB eine Kopie – die Galerie ist nicht wiederherstellbar.
    if (existed && version > 0 && version < MIGRATIONS.length) {
      db.pragma('wal_checkpoint(TRUNCATE)');
      copyFileSync(file, `${file}.v${version}.bak`);
    }
    for (let v = version; v < MIGRATIONS.length; v++) {
      db.transaction(() => {
        db.exec(MIGRATIONS[v] as string);
        db.pragma(`user_version = ${v + 1}`);
      })();
    }
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

export function toApi(r: GenRow): Generation {
  return {
    id: r.id,
    workflow: r.workflow,
    status: r.status,
    prompt: r.prompt,
    expandedPrompt: r.expanded_prompt,
    params: parseParams(r.params_json),
    parentId: r.parent_id,
    hasInput: r.input_preview_path !== null,
    video: r.video_path !== null,
    refCount: refsOf(r).length,
    width: r.width,
    height: r.height,
    error: r.error,
    favorite: r.favorite === 1,
    durationMs: r.duration_ms,
    createdAt: r.created_at,
    series: seriesOf(r),
  };
}

function seriesOf(r: GenRow): SeriesRef | null {
  const v = parseJson(r.series_json) as Partial<SeriesRef> | null | undefined;
  return v && typeof v.id === 'string' && Number.isInteger(v.index) && Number.isInteger(v.size) ? { id: v.id, index: v.index as number, size: v.size as number } : null;
}

export function insertGeneration(
  db: DB,
  g: {
    id: string;
    workflow: string;
    prompt: string;
    params: Record<string, ParamValue>;
    parentId?: string | null;
    inputPath?: string | null;
    inputPreviewPath?: string | null;
    refs?: RefImage[];
    series?: SeriesRef | null;
  },
): void {
  db.prepare(
    `INSERT INTO generations (id, workflow, status, prompt, params_json, parent_id, input_path, input_preview_path, refs_json, series_json)
     VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(g.id, g.workflow, g.prompt, JSON.stringify(g.params), g.parentId ?? null, g.inputPath ?? null, g.inputPreviewPath ?? null,
    g.refs?.length ? JSON.stringify(g.refs) : null, g.series ? JSON.stringify(g.series) : null);
}

// Eine kaputte Zeile darf nicht die ganze Galerie-Seite mitreißen.
function parseJson(text: string | null): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function parseParams(text: string): Record<string, ParamValue> {
  const v = parseJson(text);
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, ParamValue>) : {};
}

export function refsOf(r: GenRow): RefImage[] {
  const v = parseJson(r.refs_json);
  return Array.isArray(v)
    ? v.filter((x: unknown): x is RefImage =>
      typeof (x as RefImage | null)?.path === 'string' && typeof (x as RefImage | null)?.preview === 'string')
    : [];
}

export function setComfyId(db: DB, id: string, promptId: string): void {
  db.prepare('UPDATE generations SET comfy_prompt_id = ? WHERE id = ?').run(promptId, id);
}

export function setStatus(db: DB, id: string, status: GenStatus): void {
  db.prepare('UPDATE generations SET status = ? WHERE id = ?').run(status, id);
}

export function finishDone(
  db: DB,
  id: string,
  d: {
    expandedPrompt: string | null;
    outputPath: string;
    previewPath: string;
    thumbPath: string;
    width: number;
    height: number;
    durationMs: number;
    videoPath?: string | null;
  },
): void {
  db.prepare(
    `UPDATE generations SET status = 'done', expanded_prompt = ?, output_path = ?, preview_path = ?,
       thumb_path = ?, width = ?, height = ?, duration_ms = ?, video_path = ?, error = NULL WHERE id = ?`,
  ).run(d.expandedPrompt, d.outputPath, d.previewPath, d.thumbPath, d.width, d.height, d.durationMs, d.videoPath ?? null, id);
}

export function finishError(db: DB, id: string, error: string, status: 'error' | 'cancelled' = 'error'): void {
  db.prepare('UPDATE generations SET status = ?, error = ? WHERE id = ?').run(status, error, id);
}

/** Löscht eine Zeile; liefert die Dateien, die keine andere Zeile mehr nutzt. Kinder verlieren nur den Ketten-Verweis. */
export function deleteGeneration(db: DB, id: string): string[] | null {
  const r = getRow(db, id);
  if (!r) return null;
  const own = [r.output_path, r.preview_path, r.thumb_path, r.video_path, r.input_path, r.input_preview_path, ...refsOf(r).flatMap((x) => [x.path, x.preview])]
    .filter((p): p is string => !!p);
  const used = db.prepare(`SELECT 1 FROM generations WHERE output_path = @p OR preview_path = @p OR thumb_path = @p OR video_path = @p
    OR input_path = @p OR input_preview_path = @p OR instr(refs_json, @q) > 0 LIMIT 1`);
  return db.transaction(() => {
    db.prepare('UPDATE generations SET parent_id = NULL WHERE parent_id = ?').run(id);
    db.prepare('DELETE FROM generations WHERE id = ?').run(id);
    return [...new Set(own)].filter((p) => used.get({ p, q: JSON.stringify(p) }) === undefined);
  })();
}

export function setFavorite(db: DB, id: string, favorite: boolean): boolean {
  return db.prepare('UPDATE generations SET favorite = ? WHERE id = ?').run(favorite ? 1 : 0, id).changes > 0;
}

export function getRow(db: DB, id: string): GenRow | undefined {
  return db.prepare('SELECT rowid, * FROM generations WHERE id = ?').get(id) as GenRow | undefined;
}

export function listGenerations(db: DB, cursor: number | null, limit: number, filter: GenerationFilter = {}): Page<Generation> {
  const where = ['rowid < ?'];
  const args: (string | number)[] = [cursor ?? Number.MAX_SAFE_INTEGER];
  if (filter.favorite) where.push('favorite = 1');
  const q = filter.q?.trim();
  if (q) {
    // % und _ im Suchtext wörtlich nehmen, nicht als LIKE-Platzhalter
    const like = `%${q.replace(/[!%_]/g, (c) => `!${c}`)}%`;
    where.push("(prompt LIKE ? ESCAPE '!' OR expanded_prompt LIKE ? ESCAPE '!')");
    args.push(like, like);
  }
  const marks = (list: string[]) => list.map(() => '?').join(', ');
  if (filter.workflows) {
    where.push(`workflow IN (${marks(filter.workflows)})`); // leeres IN () liefert in SQLite nichts
    args.push(...filter.workflows);
  }
  if (filter.notWorkflows?.length) {
    where.push(`workflow NOT IN (${marks(filter.notWorkflows)})`);
    args.push(...filter.notWorkflows);
  }
  const rows = db
    .prepare(`SELECT rowid, * FROM generations WHERE ${where.join(' AND ')} ORDER BY rowid DESC LIMIT ?`)
    .all(...args, limit + 1) as GenRow[];
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  return { items: page.map(toApi), nextCursor: more ? (page.at(-1)?.rowid ?? null) : null };
}

/** Workflows, die in der Galerie vorkommen – die Galerie bietet nur dafür Modell-Filter an. */
export function usedWorkflows(db: DB): string[] {
  return (db.prepare('SELECT DISTINCT workflow FROM generations ORDER BY workflow').all() as { workflow: string }[]).map((r) => r.workflow);
}

export function listUnfinished(db: DB): GenRow[] {
  return db
    .prepare(`SELECT rowid, * FROM generations WHERE status IN ('queued', 'running') ORDER BY rowid`)
    .all() as GenRow[];
}

/** Vorfahren bis zur Wurzel, älteste zuerst; ein Zyklus in parent_id bricht ab statt endlos zu laufen. */
export function getChain(db: DB, id: string): Generation[] {
  const chain: Generation[] = [];
  const seen = new Set<string>();
  let row = getRow(db, id);
  while (row && !seen.has(row.id) && chain.length < 200) {
    seen.add(row.id);
    chain.unshift(toApi(row));
    row = row.parent_id ? getRow(db, row.parent_id) : undefined;
  }
  return chain;
}

interface FigureRow {
  id: string;
  name: string;
  kind: FigureKind;
  sheet_id: string;
  created_at: string;
}

export function insertFigure(db: DB, f: { id: string; name: string; kind: FigureKind; sheetId: string }): void {
  db.prepare('INSERT INTO figures (id, name, kind, sheet_id) VALUES (?, ?, ?, ?)').run(f.id, f.name, f.kind, f.sheetId);
}

/** Neueste zuerst, mit dem Blatt-Job für Status und Vorschau. */
export function listFigures(db: DB): Figure[] {
  const rows = db.prepare('SELECT * FROM figures ORDER BY rowid DESC').all() as FigureRow[];
  return rows.map((r) => {
    const sheet = getRow(db, r.sheet_id);
    return { id: r.id, name: r.name, kind: r.kind, sheetId: r.sheet_id, sheet: sheet ? toApi(sheet) : null, createdAt: r.created_at };
  });
}

export function getFigure(db: DB, id: string): { name: string; kind: FigureKind; sheetId: string } | undefined {
  const r = db.prepare('SELECT * FROM figures WHERE id = ?').get(id) as FigureRow | undefined;
  return r ? { name: r.name, kind: r.kind, sheetId: r.sheet_id } : undefined;
}

export function deleteFigure(db: DB, id: string): boolean {
  return db.prepare('DELETE FROM figures WHERE id = ?').run(id).changes > 0;
}

/** Name der Figur, deren Blatt dieser Job ist – solange es sie gibt, darf das Bild nicht gelöscht werden. */
export function figureUsing(db: DB, generationId: string): string | null {
  const r = db.prepare('SELECT name FROM figures WHERE sheet_id = ? LIMIT 1').get(generationId) as { name: string } | undefined;
  return r?.name ?? null;
}
