import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { FieldSpec, Figure, Generation, ParamValue, WorkflowInfo } from '@brennglas/shared';
import { z } from 'zod';
import { BASE, backend, en, resolveEnum, toSource } from './backend.ts';

// Regie-Anleitung: Claude bekommt sie in jedem Projekt, sobald der Server verbunden ist
const INSTRUCTIONS = `Brennglas renders images and videos locally on the user's GPU; every result shows up live in the user's gallery.
Work like a director when asked for a film, spot or sequence:
1. Plan a shot list first: per shot the subject, action, camera move, shot size and look. Keep characters, products and
   the setting consistent across shots by repeating the same concrete descriptions.
2. Create a strong start image per shot (text to image), check the preview, regenerate if it is off. For continuity,
   edit the previous image instead (edit mode with the earlier result as main image) or use last_frame of the previous shot.
   Before animating, check hands, faces, products and lettering with inspect_image: the video model carries every flaw of the
   start image through the whole shot. FLUX 3 Klein is weak at gripping hands; prefer relaxed poses (bag on the forearm,
   hand loosely at the handle) or try several seeds.
3. Animate each shot with image to video. LTX-2.5 (ltx25-i2v) has camera presets, look and sound; Wan Fun Camera
   (wan22cam-i2v) gives precise pan/zoom/roll paths but no sound. Large LTX moves need >= 5 s and pe=true or a detailed prompt.
   First + last frame (ltx25-flf2v) makes controlled transitions between two images.
4. Look at each result preview; redo a shot rather than keep a weak one. Then join the shots with concat (fade 0 for cuts,
   0.3 to 0.8 for soft transitions).
5. Finish in concat, not in the model: one continuous music track (music, the shots' own sounds are ducked under it), the logo
   as a sharp overlay (logo) and an end card image (endcard). Never let the video model render logos or lettering; it smears.
   A dip to black (transition fadeblack) separates scenes, fade_in/fade_out open from and end on black. The user can open the
   result in Brennglas' editor (tab "Video editor" / "Schnitt" in the top bar) to trim shots, change single transitions and render again.
Known LTX limits and what helps:
- Camera presets are text appended to the prompt, not a camera path. "Tracking shot" is a sideways move; for a subject walking
  towards the camera use "Lead shot (subject walks towards camera)" or "Slow pull out" and say "full body in frame".
- Whatever is outside the start image gets invented (extra people, props). Show the whole set in the start image.
- Stage directions are suggestions ("turns to the camera" may become a turn away). When the end pose matters, generate the
  end image too and use first + last frame (ltx25-flf2v).
- Faces in wide shots have few pixels and lose likeness: prefer medium/close shots, or 1080p for wide shots.
- For an exact camera path use Wan Fun Camera (no sound, max 720p) and add sound via the music track.
Recurring characters and products (same person or product in several shots):
1. Use an existing one from figures, or create_figure from a photo with the face clearly visible, or a packshot (any gallery id
   or file; make one with text to image first if needed). Name the clothing in outfit; check the
   returned sheet against the portrait: face shape and build must match.
2. Per shot generate the start image with figures=[name] and an edit workflow. For people prefer qwen21-edit: it keeps face shape
   and build, flux3-edit tends to widen faces and bodies. Qwen is non-commercial; for commercial work use flux3-edit (products
   too), where a close-up portrait helps. Prompt only the scene, aspect sets the format, up to 3 figures per
   scene, images add further references (a location).
   Do not start from the previous shot here; the figure's sheet keeps the identity, chaining edits drifts.
3. Check the face with inspect_image against the portrait before animating; regenerate with another seed if it differs.
   Medium and close shots hold the likeness best; in wide shots describe face and hair in the prompt.
LoRAs: image models have loraOn, lora (only matching files are listed) and loraStrength; the LoRA's trigger word is appended
automatically (set loraTrigger to override, "" for none). Style LoRAs on Krea 2 and Z-Image; Qwen/FLUX edit offer helper LoRAs
(Consistency keeps edits pixel-aligned, Outpaint fills gray padding).
Call list_models first to see models, fields and option names. Prefer English prompts. Tell the user the gallery ids and links.`;

const server = new McpServer({ name: 'brennglas', version: '0.4.0' }, { instructions: INSTRUCTIONS });

const text = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }] });
const fail = (e: unknown): CallToolResult => ({ content: [{ type: 'text', text: (e as Error).message }], isError: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Felder kompakt für Claude: lange Enum-Werte (Prompt-Bausteine) nur mit Namen, die versteht resolveEnum. */
function describeField(key: string, s: FieldSpec): Record<string, unknown> {
  const out: Record<string, unknown> = { key, type: s.type, label: en(s.label) };
  if (s.default !== undefined && !(typeof s.default === 'string' && s.default.length > 60)) out.default = s.default;
  if (s.min !== undefined) out.min = s.min;
  if (s.max !== undefined) out.max = s.max;
  if (s.presets) out.presets = s.presets.map((p) => `${en(p.label)}=${p.value}`);
  if (s.options) out.options = s.options.map((o) => (o.length > 40 || !o ? en(s.optionLabels?.[o]) ?? o : o));
  if (s.optional) out.optional = true;
  if (s.advanced) out.advanced = true;
  // LoRA: Trigger je Datei aus Katalog/Metadaten – zeigt Claude, welchen Look eine LoRA macht
  if (s.triggers && Object.keys(s.triggers).length) out.triggers = s.triggers;
  return out;
}

async function catalogue() {
  const [models, workflows] = await Promise.all([backend.models(), backend.workflows()]);
  const byName = new Map(workflows.map((w) => [w.name, w]));
  return { models, byName };
}

/** Ergebnis für Claude: Zusammenfassung als Text, dazu das 512-px-Vorschaubild, damit es beurteilt werden kann. */
async function report(g: Generation): Promise<CallToolResult> {
  const info = {
    id: g.id, status: g.status, workflow: g.workflow, prompt: g.prompt,
    ...(g.expandedPrompt && g.expandedPrompt !== g.prompt ? { expandedPrompt: g.expandedPrompt } : {}),
    ...(g.status === 'done' ? { size: `${g.width}x${g.height}`, seconds: g.durationMs ? Math.round(g.durationMs / 1000) : null } : {}),
    ...(g.status === 'done' ? { image: `${BASE}/api/images/${g.id}/full`, ...(g.video ? { video: `${BASE}/api/images/${g.id}/video` } : {}) } : {}),
    ...(g.error ? { error: g.error } : {}),
    ...(g.status === 'queued' || g.status === 'running' ? { hint: 'Still rendering; call wait with this id.' } : {}),
  };
  const content: CallToolResult['content'] = [{ type: 'text', text: JSON.stringify(info, null, 1) }];
  if (g.status === 'done') {
    const data = await backend.thumb(g.id);
    if (data) content.push({ type: 'image', data, mimeType: 'image/webp' });
  }
  return { content, ...(g.status === 'error' ? { isError: true } : {}) };
}

/** Figur per ID oder Name (ohne Groß-/Kleinschreibung). */
async function resolveFigures(refs: string[]): Promise<Figure[]> {
  const all = await backend.figures();
  return refs.map((r) => {
    const want = r.trim().toLowerCase();
    const hit = all.find((f) => f.id === r) ?? all.find((f) => f.name.toLowerCase() === want);
    if (!hit) throw new Error(`Unknown figure "${r}"; known: ${all.map((f) => f.name).join(', ') || 'none'}`);
    return hit;
  });
}

/** "16:9", "9:16", "1:1" oder Zahl Breite/Höhe. */
function parseAspect(a: string | number): number {
  const m = typeof a === 'string' ? /^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/.exec(a) : null;
  const v = typeof a === 'number' ? a : m ? Number(m[1]) / Number(m[2]) : Number(a);
  if (!Number.isFinite(v) || v < 0.25 || v > 4) throw new Error(`aspect "${a}": use e.g. "16:9", "9:16", "4:5" or a number between 0.25 and 4`);
  return v;
}

async function waitFor(id: string, seconds: number): Promise<Generation> {
  const until = Date.now() + seconds * 1000;
  for (;;) {
    const g = await backend.generation(id);
    if (g.status !== 'queued' && g.status !== 'running') return g;
    if (Date.now() >= until) return g;
    await sleep(2000);
  }
}

server.registerTool('list_models', {
  title: 'List Brennglas models',
  description: 'Lists the local image and video models with their modes, the workflow name per mode, and every input field (type, default, range, options). '
    + 'Call this first. Enum options can be passed by their shown name (e.g. camera "Arc left"). Models with "missing" files cannot run.',
}, async () => {
  try {
    const { models, byName } = await catalogue();
    const out = models.map((m) => ({
      id: m.id, name: typeof m.name === 'string' ? m.name : m.name.en, license: `${m.license.name} (commercial: ${m.license.commercial})`,
      ...(m.missing?.length ? { missing: m.missing.map((f) => (m.downloads[f] ? `${f} (download: ${m.downloads[f]})` : f)) } : {}),
      modes: Object.fromEntries(Object.entries(m.modes).filter(([, w]) => w && byName.get(w)?.kind !== 'video').map(([mode, w]) => {
        const wf = byName.get(w as string) as WorkflowInfo;
        return [mode, { workflow: wf.name, ...(wf.refs ? { extraImages: wf.refs, refToken: wf.refToken } : {}),
          fields: Object.entries(wf.inputs).map(([k, s]) => describeField(k, s)) }];
      })),
    }));
    return text(JSON.stringify(out));
  } catch (e) {
    return fail(e);
  }
});

server.registerTool('generate', {
  title: 'Generate image or video',
  description: 'Starts a job in Brennglas (it appears live in the user\'s gallery). Pick the workflow from list_models. '
    + 'images: gallery ids or absolute file paths; the first is the main/start image, further ones are references (for first+last frame video, the second is the last frame). '
    + 'Waits up to wait_seconds, then returns the result with a preview image, or the id to pass to wait. Videos take 30 s to several minutes. '
    + 'Camera moves in image to video (LTX): large moves (arc, orbit, crane, drone, bullet time) only show from about 5 s; with 3 s the model '
    + 'falls back to a gentle push-in. For those use duration >= 5 and either pe=true or a detailed prompt that also describes the camera path.',
  inputSchema: {
    workflow: z.string().describe('Workflow name, e.g. "zimage-t2i", "ltx25-i2v", "wan22cam-i2v"'),
    prompt: z.string().optional().describe('Prompt text; English works best'),
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Field values by key, see list_models'),
    images: z.array(z.string()).optional().describe('Gallery ids, "upload:…" refs from last_frame, or absolute paths of local image files'),
    figures: z.array(z.string()).max(3).optional().describe('Figure names or ids (see figures): new scene with these characters/products '
      + 'on an empty canvas; needs an edit workflow, prompt = the scene only, images become further references'),
    aspect: z.union([z.string(), z.number()]).optional().describe('Scene format with figures, e.g. "16:9" (default), "9:16", "4:5"'),
    wait_seconds: z.number().min(0).max(600).default(90),
  },
}, async ({ workflow, prompt, params, images, figures, aspect, wait_seconds }) => {
  try {
    const { byName } = await catalogue();
    const wf = byName.get(workflow);
    if (!wf) throw new Error(`Unknown workflow ${workflow}; see list_models`);
    if (wf.kind === 'text') throw new Error(`${workflow} writes text; use enhance_prompt`);
    const p: Record<string, ParamValue> = {};
    for (const [k, v] of Object.entries(params ?? {})) {
      const spec = wf.inputs[k];
      p[k] = spec?.type === 'enum' && typeof v === 'string' ? resolveEnum(spec, v) : v;
    }
    const sources = await Promise.all((images ?? []).map(toSource));
    const figs = figures?.length ? (await resolveFigures(figures)).map((f) => f.id) : undefined;
    if (!figs && aspect !== undefined) throw new Error('aspect only applies with figures; for text to image use the size fields of the model');
    const { id } = await backend.generate({
      workflow, prompt, params: p, ...(sources.length ? { images: sources } : {}),
      ...(figs ? { figures: figs, aspect: aspect === undefined ? 16 / 9 : parseAspect(aspect) } : {}),
    });
    return await report(await waitFor(id, wait_seconds));
  } catch (e) {
    return fail(e);
  }
});

const figureLine = (f: Figure) => JSON.stringify({ id: f.id, name: f.name, kind: f.kind, sheet: f.sheetId, sheetStatus: f.sheet?.status ?? 'missing' });

server.registerTool('figures', {
  title: 'List characters and products',
  description: 'Lists the saved figures (recurring people and products) with name, kind and the gallery id of their reference sheet. '
    + 'Pass a name in generate.figures to put the figure into a new scene.',
}, async () => {
  try {
    const all = await backend.figures();
    return text(all.map(figureLine).join('\n') || 'No figures yet; create one with create_figure.');
  } catch (e) {
    return fail(e);
  }
});

server.registerTool('create_figure', {
  title: 'Create a character or product',
  description: 'Saves a recurring person or product for consistent shots: renders a reference sheet (four views) from a portrait or packshot '
    + 'and returns its preview. The face should be clearly visible; with flux3-edit a close-up works best. Takes about 30 to 90 s.',
  inputSchema: {
    name: z.string().min(1).max(60).describe('Short name used in prompts, e.g. "Mara"'),
    kind: z.enum(['person', 'product']).default('person'),
    portrait: z.string().describe('Gallery id, "upload:…" ref or absolute path of the portrait or packshot'),
    outfit: z.string().max(200).optional().describe('Person: clothing for the full body view · product: details the photo does not show'),
    workflow: z.string().optional().describe('Edit workflow that renders the sheet; default qwen21-edit for people (non-commercial), flux3-edit for products, the other one if that is not installed'),
    wait_seconds: z.number().min(0).max(600).default(180),
  },
}, async ({ name, kind, portrait, outfit, workflow, wait_seconds }) => {
  try {
    // Vorgabe wie im Web-Dialog: das bevorzugte Modell nur, wenn es installiert ist, sonst das andere
    const prefer = kind === 'person' ? ['qwen21-edit', 'flux3-edit'] : ['flux3-edit', 'qwen21-edit'];
    const installed = new Set((await backend.models()).filter((m) => m.missing?.length === 0).map((m) => m.modes.edit));
    const wf = workflow ?? prefer.find((w) => installed.has(w)) ?? prefer[0] as string;
    const f = await backend.createFigure({ name, kind, portrait: await toSource(portrait), workflow: wf, ...(outfit ? { outfit } : {}) });
    const g = await waitFor(f.sheetId, wait_seconds);
    const failed = g.status === 'error' || g.status === 'cancelled';
    // Gescheitertes Blatt: Figur wieder weg, sonst blockiert sie den Namen
    if (failed) await backend.deleteFigure(f.id);
    const r = await report(g);
    r.content.unshift({ type: 'text', text: failed ? `Sheet failed, figure "${f.name}" was removed again; fix the portrait or try another workflow.` : `Figure "${f.name}" saved (id ${f.id}); its sheet:` });
    return r;
  } catch (e) {
    return fail(e);
  }
});

server.registerTool('wait', {
  title: 'Wait for a job',
  description: 'Waits until a Brennglas job is done (or the timeout passes) and returns its result with a preview image.',
  inputSchema: { id: z.string(), timeout_seconds: z.number().min(1).max(600).default(180) },
}, async ({ id, timeout_seconds }) => {
  try {
    return await report(await waitFor(id, timeout_seconds));
  } catch (e) {
    return fail(e);
  }
});

server.registerTool('enhance_prompt', {
  title: 'Write a prompt with the local language model',
  description: 'Turns a short idea (any language) into a detailed English prompt for a target: "Generate image", "Edit image", '
    + '"Text to video (LTX)", "Image to video (LTX)" or "Wan camera move". Optional image (gallery id or path) for image-based targets. '
    + 'large=true uses Qwen 3.5 9B instead of Gemma 4 E2B. Takes 1 to 4 seconds. You may also write prompts yourself; this is a helper.',
  inputSchema: {
    idea: z.string(),
    target: z.string().default('Generate image'),
    large: z.boolean().default(false),
    image: z.string().optional(),
  },
}, async ({ idea, target, large, image }) => {
  try {
    const { models, byName } = await catalogue();
    const wfName = models.find((m) => m.modes.prompt)?.modes.prompt;
    const wf = wfName ? byName.get(wfName) : undefined;
    const spec = wf?.inputs.target;
    if (!wf || !spec) throw new Error('Prompt assistant workflow not loaded');
    const r = await backend.enhance({
      workflow: wf.name, prompt: idea, params: { target: resolveEnum(spec, target), large },
      ...(image ? { images: [await toSource(image)] } : {}),
    });
    return text(r.text);
  } catch (e) {
    return fail(e);
  }
});

server.registerTool('inspect_image', {
  title: 'Inspect part of an image at full resolution',
  description: 'Returns a region of a gallery image (or a video\'s preview frame) at full resolution, up to 1024 px. '
    + 'The previews from generate are only 512 px; use this to check hands, faces, products and lettering before animating. '
    + 'Region as fractions of the image: x, y = top-left corner, w, h = size (0 to 1). Default: the whole image.',
  inputSchema: {
    id: z.string(),
    x: z.number().min(0).max(1).default(0),
    y: z.number().min(0).max(1).default(0),
    w: z.number().min(0.02).max(1).default(1),
    h: z.number().min(0.02).max(1).default(1),
  },
}, async ({ id, x, y, w, h }) => {
  try {
    return { content: [{ type: 'image', data: await backend.crop(id, { x, y, w, h }), mimeType: 'image/webp' }] };
  } catch (e) {
    return fail(e);
  }
});

server.registerTool('last_frame', {
  title: 'Last frame of a video',
  description: 'Extracts the last frame of a finished video as a new start image, for a follow-up shot that continues seamlessly. '
    + 'Returns an image reference ("upload:…") to pass in generate.images.',
  inputSchema: { id: z.string().describe('Gallery id of a finished video') },
}, async ({ id }) => {
  try {
    const r = await backend.lastFrame(id);
    return text(JSON.stringify({ image: `upload:${r.inputId}`, size: `${r.width}x${r.height}` }));
  } catch (e) {
    return fail(e);
  }
});

server.registerTool('concat', {
  title: 'Join shots into one clip',
  description: 'Joins finished videos (gallery ids, in order) into one MP4 or WebM that appears in the gallery. Shots are matched to the first '
    + 'shot\x27s size and frame rate; shots without sound get silence. fade: seconds of the transition between shots, 0 = hard cut.',
  inputSchema: {
    ids: z.array(z.string()).min(2).max(30),
    fade: z.number().min(0).max(3).default(0),
    transition: z.enum(['fade', 'fadeblack', 'fadewhite', 'wipeleft', 'slideleft']).default('fade')
      .describe('Kind of transition when fade > 0: fade = cross-dissolve, fadeblack/fadewhite = dip to black/white, wipeleft, slideleft'),
    fade_in: z.number().min(0).max(5).default(0).describe('Seconds of fade from black at the start (picture and sound)'),
    fade_out: z.number().min(0).max(5).default(0).describe('Seconds of fade to black at the end (picture and sound)'),
    format: z.enum(['mp4', 'webm']).default('mp4').describe('mp4 = H.264/AAC, plays everywhere; webm = VP9/Opus, royalty free'),
    music: z.string().optional().describe('Absolute path of an audio file (mp3, wav, m4a, aac, flac, ogg); trimmed to the clip, fades out at the end'),
    music_volume: z.number().min(0).max(2).default(0.8),
    shot_volume: z.number().min(0).max(1).default(0.35).describe('Level of the shots\' own sounds under the music'),
    logo: z.string().optional().describe('Gallery id or absolute path of a PNG (transparency kept), shown over the whole clip'),
    logo_position: z.enum(['tl', 'tr', 'bl', 'br']).default('br'),
    logo_scale: z.number().min(0.03).max(0.5).default(0.12).describe('Logo width as a share of the video width'),
    endcard: z.string().optional().describe('Gallery id or absolute path of an image appended as the last shot'),
    endcard_seconds: z.number().min(0.5).max(10).default(2),
  },
}, async ({ ids, fade, transition, fade_in, fade_out, format, music, music_volume, shot_volume, logo, logo_position, logo_scale, endcard, endcard_seconds }) => {
  try {
    const join = { duration: fade, type: transition };
    return await report(await backend.concat({
      ids, fade, format, fadeIn: fade_in, fadeOut: fade_out,
      ...(fade > 0 && transition !== 'fade' ? { joins: ids.slice(1).map(() => join), endJoin: join } : {}),
      musicVolume: music_volume, shotVolume: shot_volume, logoPosition: logo_position, logoScale: logo_scale,
      endcardSeconds: endcard_seconds, ...(music ? { music } : {}), ...(logo ? { logo } : {}), ...(endcard ? { endcard } : {}),
    }));
  } catch (e) {
    return fail(e);
  }
});

server.registerTool('gallery', {
  title: 'Recent gallery items',
  description: 'Lists recent results (newest first) with id, workflow, status and prompt, optionally filtered by a search text. '
    + 'Use the ids as images in generate, e.g. to animate an image or edit it further.',
  inputSchema: { limit: z.number().min(1).max(50).default(10), search: z.string().optional() },
}, async ({ limit, search }) => {
  try {
    const page = await backend.gallery(limit, search);
    return text(page.items.map((g) => `${g.id}  ${g.workflow}  ${g.status}${g.video ? '  video' : ''}  ${g.prompt.slice(0, 100)}`).join('\n') || 'Gallery is empty.');
  } catch (e) {
    return fail(e);
  }
});

await server.connect(new StdioServerTransport());
