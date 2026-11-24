import { statKey, type DurationStats, type Mode, type ModelBench, type ModelSpec } from '@brennglas/shared';

/** 1× auf der RTX 3090: FLUX Text to Image 2 MP, Mittel des Testsatzes (→ plan_modellhilfe.md Phase 1). */
export const BENCH_UNIT_MS = 10200;
/** Stufe, für die speed/speedEnhanced gelten; andere Stufen stehen in speedAt. */
export const BENCH_MP = 2;

/** Ab so vielen eigenen Läufen gilt der eigene Median statt der Schätzung. */
export const MIN_RUNS = 3;

export interface BenchTimes {
  /** Eigener Median bzw. Schätzung in ms, ohne und mit Prompt-Erweiterung. */
  plain?: { ms: number; own: boolean };
  enhanced?: { ms: number; own: boolean };
  /** Eigene Läufe mit diesen Einstellungen bisher (für „n/3“). */
  runs: number;
}

/** Gemessener Faktor für Modus und Stufe; mp undefined = Video oder Modus ohne Stufen. */
export function refFactor(b: ModelBench | undefined, mode: Mode, mp: number | undefined, enhanced: boolean): number | undefined {
  const set = mp === undefined || mp === BENCH_MP ? b : b?.speedAt?.[String(mp)];
  return (enhanced ? set?.speedEnhanced : set?.speed)?.[mode];
}

/** Faktor eines Statistik-Schlüssels laut Modell-Dateien (Umkehrung von statKey). */
function factorOf(models: ModelSpec[], key: string): number | undefined {
  const m = /^(.*?)(?:@([\d.]+))?(\+pe)?$/.exec(key);
  if (!m) return undefined;
  const [, wf, mp, pe] = m;
  for (const model of models) {
    const mode = (Object.entries(model.modes) as [Mode, string][]).find(([, w]) => w === wf)?.[0];
    if (mode) return refFactor(model.bench, mode, mp === undefined ? undefined : Number(mp), !!pe);
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

/** Eigene Zeit des Workflows bei dieser Stufe, sonst Faktor × Takt dieses Rechners, sonst nichts. */
export function benchTimes(models: ModelSpec[], stats: DurationStats, model: ModelSpec, mode: Mode, mp?: number): BenchTimes {
  const wf = model.modes[mode];
  if (!wf) return { runs: 0 };
  const unit = unitMs(models, stats);
  const pick = (enhanced: boolean) => {
    const own = stats[statKey(wf, mp, enhanced)];
    if (own && own.n >= MIN_RUNS) return { ms: own.ms, own: true };
    const factor = refFactor(model.bench, mode, mp, enhanced);
    return factor && unit ? { ms: factor * unit, own: false } : undefined;
  };
  const plain = pick(false);
  const enhanced = pick(true);
  const runs = Math.max(stats[statKey(wf, mp, false)]?.n ?? 0, stats[statKey(wf, mp, true)]?.n ?? 0);
  return { ...(plain ? { plain } : {}), ...(enhanced ? { enhanced } : {}), runs };
}

/** Kurz und gerundet: unter 90 s in Sekunden, sonst Minuten mit einer Stelle. */
export function shortDuration(ms: number, locale: string): string {
  const s = ms / 1000;
  if (s < 90) return `${Math.max(1, Math.round(s))} s`;
  return `${(s / 60).toLocaleString(locale, { maximumFractionDigits: 1 })} min`;
}
