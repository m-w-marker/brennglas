import type { DurationStats, Mode, ModelSpec } from '@brennglas/shared';

/** 1× auf der RTX 3090: FLUX Text to Image 2 MP, Mittel des Testsatzes (→ plan_modellhilfe.md Phase 1). */
export const BENCH_UNIT_MS = 10200;

/** Ab so vielen eigenen Läufen gilt der eigene Median statt der Schätzung. */
export const MIN_RUNS = 3;

export interface BenchTimes {
  /** Eigener Median bzw. Schätzung in ms, ohne und mit Prompt-Erweiterung. */
  plain?: { ms: number; own: boolean };
  enhanced?: { ms: number; own: boolean };
}

/** Faktor eines Statistik-Schlüssels (`<workflow>` oder `<workflow>+pe`) laut Modell-Dateien. */
function factorOf(models: ModelSpec[], key: string): number | undefined {
  const pe = key.endsWith('+pe');
  const wf = pe ? key.slice(0, -3) : key;
  for (const m of models) {
    const mode = (Object.entries(m.modes) as [Mode, string][]).find(([, w]) => w === wf)?.[0];
    if (mode) return (pe ? m.bench?.speedEnhanced : m.bench?.speed)?.[mode];
  }
  return undefined;
}

/** Dauer von 1× auf diesem Rechner: Median über alle eigenen Läufe mit bekanntem Faktor. */
export function unitMs(models: ModelSpec[], stats: DurationStats): number | null {
  const units = Object.entries(stats).flatMap(([k, s]) => {
    const f = factorOf(models, k);
    return f && s.n >= MIN_RUNS ? [s.ms / f] : [];
  }).sort((a, b) => a - b);
  return units.length ? (units[Math.floor(units.length / 2)] as number) : null;
}

/** Eigene Zeit des Workflows, sonst Faktor × Takt dieses Rechners, sonst nichts. */
export function benchTimes(models: ModelSpec[], stats: DurationStats, model: ModelSpec, mode: Mode): BenchTimes {
  const wf = model.modes[mode];
  if (!wf || !model.bench) return {};
  const unit = unitMs(models, stats);
  const pick = (key: string, factor: number | undefined) => {
    const own = stats[key];
    if (own && own.n >= MIN_RUNS) return { ms: own.ms, own: true };
    return factor && unit ? { ms: factor * unit, own: false } : undefined;
  };
  const plain = pick(wf, model.bench.speed[mode]);
  const enhanced = pick(`${wf}+pe`, model.bench.speedEnhanced?.[mode]);
  return { ...(plain ? { plain } : {}), ...(enhanced ? { enhanced } : {}) };
}

/** Kurz und gerundet: unter 90 s in Sekunden, sonst Minuten mit einer Stelle. */
export function shortDuration(ms: number, locale: string): string {
  const s = ms / 1000;
  if (s < 90) return `${Math.max(1, Math.round(s))} s`;
  return `${(s / 60).toLocaleString(locale, { maximumFractionDigits: 1 })} min`;
}
