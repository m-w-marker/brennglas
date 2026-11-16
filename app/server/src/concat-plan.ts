/** Eckdaten eines Shots laut ffprobe. */
export interface ClipInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

export interface ConcatPlan {
  filter: string;
  /** Länge des fertigen Clips in Sekunden. */
  duration: number;
  width: number;
  height: number;
  fps: number;
}

/** Zusätze nach dem Schnitt; input = Index der ffmpeg-Eingabe (nach den Shots). */
export interface ConcatExtras {
  /** Durchgehender Track; die Geräusche der Shots werden auf shotVolume abgesenkt. */
  music?: { input: number; volume: number; shotVolume: number };
  /** Logo (PNG mit Alpha) in einer Ecke, scale = Anteil an der Bildbreite. */
  logo?: { input: number; scale: number; position: 'tl' | 'tr' | 'bl' | 'br' };
}

/** filter_complex für n Shots auf Größe/fps des ersten; ohne Ton → Stille, sonst scheitern concat/acrossfade. */
export function planConcat(clips: ClipInfo[], fade: number, extras: ConcatExtras = {}): ConcatPlan {
  const first = clips[0];
  if (!first || clips.length < 2) throw new Error('Mindestens zwei Shots');
  const shortest = Math.min(...clips.map((c) => c.duration));
  if (fade < 0 || (fade > 0 && fade >= shortest)) throw new Error(`Überblendung muss kürzer sein als der kürzeste Shot (${shortest.toFixed(2)} s)`);
  // yuv420p braucht gerade Kanten
  const w = Math.round(first.width / 2) * 2;
  const h = Math.round(first.height / 2) * 2;
  const fps = first.fps;
  const parts: string[] = [];
  clips.forEach((c, i) => {
    parts.push(`[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p,settb=AVTB[v${i}]`);
    parts.push(c.hasAudio
      ? `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${c.duration}[a${i}]`
      : `anullsrc=r=48000:cl=stereo,atrim=duration=${c.duration},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
  });
  const total = clips.reduce((s, c) => s + c.duration, 0) - fade * (clips.length - 1);
  // Mit Zusätzen endet der Schnitt in Zwischen-Labels, die Zusätze liefern dann [v]/[a]
  const vEnd = extras.logo ? 'vc' : 'v';
  const aEnd = extras.music ? 'ac' : 'a';
  const finish = () => {
    if (extras.logo) {
      const { input, scale, position } = extras.logo;
      const m = Math.round(w * 0.03);
      const x = position.endsWith('l') ? `${m}` : `main_w-overlay_w-${m}`;
      const y = position.startsWith('t') ? `${m}` : `main_h-overlay_h-${m}`;
      parts.push(`[${input}:v]scale=${Math.round(w * scale / 2) * 2}:-1[logo]`);
      parts.push(`[vc][logo]overlay=${x}:${y}:format=auto,format=yuv420p[v]`);
    }
    if (extras.music) {
      const { input, volume, shotVolume } = extras.music;
      parts.push(`[ac]volume=${shotVolume}[as]`);
      parts.push(`[${input}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${round(total)},`
        + `afade=t=in:d=0.3,afade=t=out:st=${round(Math.max(0, total - 1.5))}:d=1.5,volume=${volume}[am]`);
      parts.push('[as][am]amix=inputs=2:duration=first:normalize=0[a]');
    }
    return { filter: parts.join(';'), duration: total, width: w, height: h, fps };
  };
  if (fade === 0) {
    parts.push(`${clips.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${clips.length}:v=1:a=1[${vEnd}][${aEnd}]`);
    return finish();
  }
  // Kette: Überblendung k beginnt am Ende des bisher Zusammengesetzten minus fade
  let vPrev = 'v0';
  let aPrev = 'a0';
  let length = first.duration;
  for (let k = 1; k < clips.length; k++) {
    const last = k === clips.length - 1;
    const vOut = last ? vEnd : `vx${k}`;
    const aOut = last ? aEnd : `ax${k}`;
    parts.push(`[${vPrev}][v${k}]xfade=transition=fade:duration=${fade}:offset=${round(length - fade)}[${vOut}]`);
    parts.push(`[${aPrev}][a${k}]acrossfade=d=${fade}[${aOut}]`);
    length += (clips[k] as ClipInfo).duration - fade;
    vPrev = vOut;
    aPrev = aOut;
  }
  return finish();
}

const round = (x: number) => Math.round(x * 1000) / 1000;
