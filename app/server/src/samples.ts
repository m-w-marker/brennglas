import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import type { FigureKind, ParamValue } from '@brennglas/shared';
import { finishDone, insertFigure, insertGeneration, type DB, type RefImage } from './db.ts';
import { saveInput, saveOutput } from './images.ts';

interface Sample {
  file: string;
  workflow: string;
  prompt: string;
  params: Record<string, ParamValue>;
}

const FILE = /^[\w.-]+\.(jpg|png|webp)$/;

function parseSamples(text: string): Sample[] {
  const list: unknown = JSON.parse(text);
  if (!Array.isArray(list)) throw new Error('samples.json: Liste erwartet');
  return list.map((s: unknown, i): Sample => {
    const o = (s ?? {}) as Partial<Sample>;
    const ok = typeof o.file === 'string' && FILE.test(o.file)
      && typeof o.workflow === 'string' && typeof o.prompt === 'string'
      && typeof o.params === 'object' && o.params !== null && !Array.isArray(o.params);
    if (!ok) throw new Error(`samples.json: Eintrag ${i} unvollständig`);
    return o as Sample;
  });
}

/** Legt die Beispielbilder als fertige Einträge an, nur in eine leere Galerie; liefert die Anzahl. */
export async function seedSamples(db: DB, dataDir: string, samplesDir: string): Promise<number> {
  if ((db.prepare('SELECT COUNT(*) AS n FROM generations').get() as { n: number }).n > 0) return 0;
  const list = parseSamples(readFileSync(join(samplesDir, 'samples.json'), 'utf8'));
  // Die Galerie zeigt die höchste rowid oben, darum der erste Eintrag zuletzt.
  for (const s of [...list].reverse()) {
    const id = randomUUID();
    const png = await sharp(readFileSync(join(samplesDir, s.file))).png().toBuffer();
    const saved = await saveOutput(dataDir, id, png);
    db.transaction(() => {
      insertGeneration(db, { id, workflow: s.workflow, prompt: s.prompt, params: { ...s.params, prompt: s.prompt } });
      finishDone(db, id, { expandedPrompt: null, ...saved, durationMs: 0 });
    })();
  }
  return list.length;
}

interface SampleFigure {
  name: string;
  kind: FigureKind;
  workflow: string;
  portrait: string;
  sheet: string;
  sheetPrompt: string;
}

interface SampleScene extends Sample {
  figures: string[];
  aspect: number;
}

function parseFigures(text: string): { figures: SampleFigure[]; scenes: SampleScene[] } {
  const o = JSON.parse(text) as { figures?: unknown; scenes?: unknown };
  if (!Array.isArray(o.figures) || !Array.isArray(o.scenes)) throw new Error('figures.json: figures und scenes als Listen erwartet');
  const figures = o.figures.map((x: unknown, i): SampleFigure => {
    const f = (x ?? {}) as Partial<SampleFigure>;
    const ok = typeof f.name === 'string' && (f.kind === 'person' || f.kind === 'product') && typeof f.workflow === 'string'
      && typeof f.portrait === 'string' && FILE.test(f.portrait) && typeof f.sheet === 'string' && FILE.test(f.sheet) && typeof f.sheetPrompt === 'string';
    if (!ok) throw new Error(`figures.json: Figur ${i} unvollständig`);
    return f as SampleFigure;
  });
  const names = new Set(figures.map((f) => f.name));
  const scenes = parseSamples(JSON.stringify(o.scenes)).map((sc, i): SampleScene => {
    const r = (o.scenes as Partial<SampleScene>[])[i] ?? {};
    if (!Array.isArray(r.figures) || !r.figures.length || !r.figures.every((n) => typeof n === 'string' && names.has(n)) || typeof r.aspect !== 'number') {
      throw new Error(`figures.json: Szene ${i} nennt unbekannte Figuren oder kein Format`);
    }
    return { ...sc, figures: r.figures, aspect: r.aspect };
  });
  return { figures, scenes };
}

/** Beispiel-Figuren samt Blatt und Szenen, einmal je Installation; liefert die Zahl der Figuren. → plan_referenz */
export async function seedFigures(db: DB, dataDir: string, samplesDir: string): Promise<number> {
  // Merkdatei statt „Tabelle leer“: wer die Beispiele löscht, bekommt sie nicht nach jedem Start zurück
  const marker = join(dataDir, 'figures-seeded');
  if (existsSync(marker)) return 0;
  if ((db.prepare('SELECT COUNT(*) AS n FROM figures').get() as { n: number }).n > 0) {
    writeFileSync(marker, '');
    return 0;
  }
  const { figures, scenes } = parseFigures(readFileSync(join(samplesDir, 'figures.json'), 'utf8'));
  // Erst alle Dateien, dann alle Zeilen in einer Transaktion: halb angelegt hielte der nächste Start für erledigt
  const made = new Map<string, { id: string; refs: RefImage[] }>();
  const rows: (() => void)[] = [];
  for (const f of figures) {
    const portrait = await saveInput(dataDir, readFileSync(join(samplesDir, f.portrait)));
    const sheetId = randomUUID();
    const sheet = await saveOutput(dataDir, sheetId, await sharp(readFileSync(join(samplesDir, f.sheet))).png().toBuffer());
    const id = randomUUID();
    const portraitRef = { path: portrait.inputPath, preview: portrait.inputPreviewPath };
    rows.push(() => {
      insertGeneration(db, { id: sheetId, workflow: f.workflow, prompt: f.sheetPrompt, params: { prompt: f.sheetPrompt }, refs: [portraitRef] });
      finishDone(db, sheetId, { expandedPrompt: null, ...sheet, durationMs: 0 });
      insertFigure(db, { id, name: f.name, kind: f.kind, sheetId });
    });
    made.set(f.name, { id, refs: [portraitRef, { path: sheet.outputPath, preview: sheet.previewPath }] });
  }
  for (const sc of scenes) {
    const figs = sc.figures.map((n) => made.get(n)).filter((x): x is { id: string; refs: RefImage[] } => !!x);
    const id = randomUUID();
    const saved = await saveOutput(dataDir, id, await sharp(readFileSync(join(samplesDir, sc.file))).png().toBuffer());
    rows.push(() => {
      insertGeneration(db, {
        id, workflow: sc.workflow, prompt: sc.prompt, refs: figs.flatMap((f) => f.refs),
        params: { ...sc.params, prompt: sc.prompt, figures: figs.map((f) => f.id).join(','), aspect: sc.aspect },
      });
      finishDone(db, id, { expandedPrompt: null, ...saved, durationMs: 0 });
    });
  }
  db.transaction(() => { for (const r of rows) r(); })();
  writeFileSync(marker, '');
  return figures.length;
}
