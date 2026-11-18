/** Schritt-Ereignis eines Durchgangs: Zeitpunkt in ms und erreichter Schritt. */
export interface Tick {
  t: number;
  v: number;
}

/** Tempo und Restzeit aus erstem und letztem Ereignis; der erste Schritt enthält oft das Modell-Laden, darum erst ab ihm. */
export function eta(first: Tick, last: Tick, max: number): { perStep: number; left: number } | null {
  const steps = last.v - first.v;
  if (steps < 1 || last.t <= first.t) return null;
  const perStep = (last.t - first.t) / steps;
  return { perStep, left: perStep * Math.max(0, max - last.v) };
}

/** Dauer als m:ss, ab einer Stunde h:mm:ss. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const two = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}
