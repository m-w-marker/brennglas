import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import type { ParamValue } from '@brennglas/shared';
import { finishDone, insertGeneration, type DB } from './db.ts';
import { saveOutput } from './images.ts';

interface Sample {
  file: string;
  workflow: string;
  prompt: string;
  params: Record<string, ParamValue>;
}

function parseSamples(text: string): Sample[] {
  const list: unknown = JSON.parse(text);
  if (!Array.isArray(list)) throw new Error('samples.json: Liste erwartet');
  return list.map((s: unknown, i): Sample => {
    const o = (s ?? {}) as Partial<Sample>;
    const ok = typeof o.file === 'string' && /^[\w.-]+\.(jpg|png|webp)$/.test(o.file)
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
