import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MAX_EXTRA_VIEWS } from '@brennglas/shared';
import type { FieldSpec, Figure, Generation, ParamValue, WorkflowInfo } from '@brennglas/shared';
import { z } from 'zod';
import { BASE, backend, en, galleryVideoFile, resolveEnum, toSource, toVideo, upscaleKind } from './backend.ts';

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
1. Use an existing one from figures, or create_figure (person, creature or product) from a photo with the face clearly visible, or a packshot (any gallery id
   or file; make one with text to image first if needed). Name the clothing in outfit; check the
   returned sheet against the portrait: face shape and build must match.
2. Per shot generate the start image with figures=[name] and an edit workflow. For people prefer qwen21-edit: it keeps face shape
   and build, flux3-edit tends to widen faces and bodies. Qwen is non-commercial; for commercial work use flux3-edit (products
   too), where a close-up portrait helps. Prompt only the scene, aspect sets the format, up to 3 figures per
   scene, images add further references (a location).
   Do not start from the previous shot here; the figure's sheet keeps the identity, chaining edits drifts.
3. Check the face with inspect_image against the portrait before animating; regenerate with another seed if it differs.
   Medium and close shots hold the likeness best; in wide shots describe face and hair in the prompt.
Layout to video (ltx25layout-l2v), when the user has a 3D layout (grey clay viewport or simple boxes from Max, Blender, Unreal):
1. The layout video (params.layout: file path or gallery id, 24 fps) sets camera, placement and motion exactly; people may be
   simple dummies (box body, sphere head). Length follows the layout (snapped to 8k+1 frames, at most 10 s).
2. The first frame (images[0]) sets the look: ask the user for their clean render of the shot's frame 0 (they have a
   renderer). Only without one build it from the layout's first frame with qwen21-edit, naming every shape by its place and
   what it becomes, each dummy as one person; a generic "the figures become people" turns lamps and balls into people too.
   Never use the grey frame itself as first frame (the result stays grey). Mention nothing that is not modelled: whatever the
   edit invents does not follow the layout and flickers or vanishes in the video. Use megapixels=4 for the edit.
   When you build the layout yourself (e.g. in Blender): only the heads are smooth spheres (lamps as drums, plants faceted),
   smooth by angle instead of fully smooth, ambient occlusion in the first frame, render it at about 4 MP.
3. Prompt: one or two sentences describing the finished shot; do not write "clay", "3D" or "render". The result is silent.
LoRAs: image models have loraOn, lora (only matching files are listed) and loraStrength; the LoRA's trigger word is appended
automatically (set loraTrigger to override, "" for none). Style LoRAs on Krea 2 and Z-Image; Qwen/FLUX edit offer helper LoRAs
(Consistency keeps edits pixel-aligned, Outpaint fills gray padding).
Edit strength (denoise, 0.8 to 1): 1 is the free edit, below that the edit starts from the original and keeps layout and
perspective. Around 0.9 turns a 3D render into a photo without rebuilding it; below 0.85 hardly anything changes.
Call list_models first to see models, fields and option names. Prefer English prompts. Tell the user the gallery ids and links.`;

const server = new McpServer({ name: 'brennglas', version: '0.9.0' }, { instructions: INSTRUCTIONS });

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
  if (s.hint) out.hint = en(s.hint);
  if (s.type === 'video') out.hint = 'gallery id of a video or absolute path of a local mp4, webm or mov file';
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
  annotations: { readOnlyHint: true },
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
    + 'falls back to a gentle push-in. For those use duration >= 5 and either pe=true or a detailed prompt that also describes the camera path. '
    + 'Runs locally on the user\'s GPU (no credits); jobs queue and render one after another, a running one can be stopped with cancel_job. '
    + 'With figures, aspect sets the scene format and the figures\' sheets are added as references. For upscaling use upscale. '
    + 'Fails right away on an unknown workflow, field option or image; a failed render returns status "error" with the reason.',
  inputSchema: {
    workflow: z.string().describe('Workflow name, e.g. "zimage-t2i", "ltx25-i2v", "wan22cam-i2v"'),
    prompt: z.string().optional().describe('Prompt text; English works best'),
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Field values by key, see list_models'),
    images: z.array(z.string()).optional().describe('Gallery ids, "upload:…" refs from last_frame, or absolute paths of local image files'),
    figures: z.array(z.string()).max(3).optional().describe('Figure names or ids (see figures): new scene with these characters/products '
      + 'on an empty canvas; needs an edit workflow, prompt = the scene only, images become further references'),
    aspect: z.union([z.string(), z.number()]).optional().describe('Scene format with figures, e.g. "16:9" (default), "9:16", "4:5"'),
    wait_seconds: z.number().min(0).max(600).default(90).describe('Seconds to wait for the result before returning the id; 0 = start only, then use wait'),
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
      p[k] = spec?.type === 'enum' && typeof v === 'string' ? resolveEnum(spec, v)
        : spec?.type === 'video' && typeof v === 'string' ? await toVideo(v) : v;
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

server.registerTool('upscale', {
  title: 'Upscale an image or video',
  description: 'Upscales with SeedVR2. An image (gallery id, "upload:…" ref or image file) becomes a new gallery item up to 8192 px on the '
    + 'long edge, in one to a few minutes. A video (gallery id of a video, a video file or a folder of frames) is upscaled frame by '
    + 'frame up to 3840 px into the folder dst; that takes far longer than an image, so start it with wait_seconds 0 and '
    + 'check with get_item. A second run into the same dst skips finished frames. Upscale finished shots, not start images: '
    + 'the video models render at their own size. Fails if SeedVR2 is not installed or the source cannot be read.',
  inputSchema: {
    source: z.string().describe('Gallery id, "upload:…" ref, or absolute path of an image, a video file or a folder of frames'),
    long_edge: z.number().int().min(512).max(8192).optional().describe('Target size of the long edge in px; default 6144 for images, 3840 (max) for videos'),
    strength: z.number().min(0).max(1).optional().describe('Image only: share of SeedVR2 against plain Lanczos scaling, default 0.5; lower if it over-sharpens'),
    dst: z.string().optional().describe('Video only, required there: absolute path of the target folder, created if missing'),
    video: z.enum(['mp4', 'prores', 'none']).default('mp4').describe('Video only: file written next to the frames; none = frames only'),
    frames: z.enum(['jpg', 'png16', 'png8']).default('jpg').describe('Video only: format of the single frames; png16 for grading, about 4x larger'),
    wait_seconds: z.number().min(0).max(600).default(180).describe('Seconds to wait for the result; 0 = start only, then use wait or get_item'),
  },
}, async ({ source, long_edge, strength, dst, video, frames, wait_seconds }) => {
  try {
    const models = await backend.models();
    const m = models.find((x) => x.modes.upscale);
    if (!m?.modes.upscale) throw new Error('No upscale model loaded');
    if (m.missing?.length) throw new Error(`SeedVR2 is not installed, missing: ${m.missing.join(', ')}`);
    const file = upscaleKind(source) === 'video';
    const galleryVideo = !file && /^[0-9a-f-]{36}$/i.test(source) && (await backend.generation(source)).video;
    if (file || galleryVideo) {
      if (!dst) throw new Error('dst (target folder) is required for a video');
      if (!m.modes.video) throw new Error('Video upscale workflow not loaded');
      const src = file ? source : await galleryVideoFile(source);
      const params: Record<string, ParamValue> = { src, dst, still: frames, format: video === 'none' ? 'png' : video,
        ...(long_edge ? { size: Math.min(long_edge, 3840) } : {}) };
      const { id } = await backend.generate({ workflow: m.modes.video, params });
      return await report(await waitFor(id, wait_seconds));
    }
    if (dst) throw new Error('dst only applies to videos; an upscaled image goes to the gallery');
    const params: Record<string, ParamValue> = { ...(long_edge ? { target: long_edge } : {}), ...(strength === undefined ? {} : { strength }) };
    const { id } = await backend.generate({ workflow: m.modes.upscale, params, images: [await toSource(source)] });
    return await report(await waitFor(id, wait_seconds));
  } catch (e) {
    return fail(e);
  }
});

const figureLine = (f: Figure) => JSON.stringify({ id: f.id, name: f.name, kind: f.kind, sheet: f.sheetId, sheetStatus: f.sheet?.status ?? 'missing' });

server.registerTool('figures', {
  title: 'List characters and products',
  description: 'Lists the saved figures (recurring people and products) with name, kind and the gallery id of their reference sheet. '
    + 'Pass a name in generate.figures to put the figure into a new scene. Returns one JSON line per figure, newest first, or a hint '
    + 'when there are none; to add one use create_figure, to remove one delete_figure.',
  annotations: { readOnlyHint: true },
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
  description: 'Saves a recurring character, creature or product for consistent shots: renders a reference sheet (four views in a fixed '
    + 'grid, in the style of the portrait) and returns its preview. The face should be clearly visible; with flux3-edit a close-up works '
    + 'best. Takes about 30 to 90 s. To use real photos instead of rendering, pass views (one photo per panel) or sheet (a finished '
    + 'sheet); they are placed unchanged. Afterwards refer to the figure by its name in generate.figures. To change a figure, delete it '
    + 'with delete_figure and create it again. Fails if the name is taken; if the sheet fails, the figure is removed again so the name stays free.',
  inputSchema: {
    name: z.string().min(1).max(60).describe('Short name used in prompts, e.g. "Mara"'),
    kind: z.enum(['person', 'creature', 'product']).default('person')
      .describe('person = human-like character (also cartoon or humanoid monster), creature = animal or being without human shape, product = object or packshot'),
    portrait: z.string().describe('Gallery id, "upload:…" ref or absolute path of the portrait or packshot; scenes use it next to the sheet'),
    outfit: z.string().max(200).optional().describe('Person: clothing in every view · creature and product: details the photo does not show. Fill it whenever the portrait misses parts (legs, shoes, the back), otherwise the model invents them'),
    extra_views: z.array(z.string()).max(MAX_EXTRA_VIEWS).optional()
      .describe(`Up to ${MAX_EXTRA_VIEWS} more photos of the same figure in the same outfit (side view, close-up), used as references while rendering`),
    views: z.array(z.string()).length(4).optional()
      .describe('One photo per panel instead of rendering, placed unchanged. person: full body front, full body back, medium shot 45°, head close-up · '
        + 'creature: front, side, back, head close-up · product: front, 45°, back, detail'),
    sheet: z.string().optional().describe('A finished sheet (own collage) taken as it is instead of rendering'),
    workflow: z.string().optional().describe('Edit workflow that renders the sheet; default qwen21-edit for people and creatures (non-commercial), flux3-edit for products, the other one if that is not installed'),
    template: z.boolean().optional().describe('Render on the grey mannequin template (fixed grid) or freely on white. Default: with template for qwen21-edit, without for flux3-edit (FLUX copies the template shapes)'),
    wait_seconds: z.number().min(0).max(600).default(180).describe('Seconds to wait for the sheet; if it is not done yet, call wait with the returned id'),
  },
}, async ({ name, kind, portrait, outfit, extra_views, views, sheet, workflow, template, wait_seconds }) => {
  try {
    // Vorgabe wie im Web-Dialog: das bevorzugte Modell nur, wenn es installiert ist, sonst das andere
    const prefer = kind === 'product' ? ['flux3-edit', 'qwen21-edit'] : ['qwen21-edit', 'flux3-edit'];
    const installed = new Set((await backend.models()).filter((m) => m.missing?.length === 0).map((m) => m.modes.edit));
    const wf = workflow ?? prefer.find((w) => installed.has(w)) ?? prefer[0] as string;
    const f = await backend.createFigure({
      name, kind, portrait: await toSource(portrait), workflow: wf, ...(outfit ? { outfit } : {}), ...(template === undefined ? {} : { template }),
      ...(extra_views?.length ? { extra: await Promise.all(extra_views.map(toSource)) } : {}),
      ...(views ? { views: await Promise.all(views.map(toSource)) } : {}),
      ...(sheet ? { sheet: await toSource(sheet) } : {}),
    });
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

server.registerTool('delete_figure', {
  title: 'Delete a character or product',
  description: 'Removes a saved figure by name or id, e.g. a failed one or one to create again with other settings. Only call it when the '
    + 'user asks. Its reference sheet stays in the gallery (delete it afterwards with delete_item if wanted); scenes already rendered '
    + 'with the figure are not touched. Returns a confirmation; fails on an unknown name with the list of known figures.',
  inputSchema: { figure: z.string().describe('Name or id of the figure, see figures') },
  annotations: { destructiveHint: true, idempotentHint: true },
}, async ({ figure }) => {
  try {
    const [f] = await resolveFigures([figure]);
    if (!f) throw new Error(`Unknown figure "${figure}"`);
    await backend.deleteFigure(f.id);
    return text(`Figure "${f.name}" deleted; its sheet ${f.sheetId} is still in the gallery.`);
  } catch (e) {
    return fail(e);
  }
});

server.registerTool('wait', {
  title: 'Wait for a job',
  description: 'Blocks until a queued or running job finishes, then returns its result: status, size, image/video links and a 512 px preview. '
    + 'Use it when generate or create_figure came back with "Still rendering". If the timeout passes first, the status is still '
    + 'queued or running; call wait again with the same id. A job cancelled meanwhile returns at once with status "cancelled", '
    + 'a failed one with status "error" and the reason; an unknown id fails. To look at a job without waiting, use get_item.',
  inputSchema: {
    id: z.string().describe('Gallery id returned by generate, create_figure or gallery'),
    timeout_seconds: z.number().min(1).max(600).default(180).describe('Longest wait; videos often need 60 to 300 s'),
  },
  annotations: { readOnlyHint: true },
}, async ({ id, timeout_seconds }) => {
  try {
    return await report(await waitFor(id, timeout_seconds));
  } catch (e) {
    return fail(e);
  }
});

server.registerTool('get_item', {
  title: 'Get one gallery item',
  description: 'Returns one gallery item right away, without waiting: status, workflow, prompt, size, image/video links and, when done, '
    + 'a 512 px preview (queued or running jobs have none yet). Use it to look up an id from gallery or to check a job\'s progress; '
    + 'to wait for the end use wait. Fails on an unknown id.',
  inputSchema: { id: z.string().describe('Gallery id') },
  annotations: { readOnlyHint: true },
}, async ({ id }) => {
  try {
    return await report(await backend.generation(id));
  } catch (e) {
    return fail(e);
  }
});

server.registerTool('cancel_job', {
  title: 'Cancel a job',
  description: 'Cancels a queued or running job (image, video or upscale); the item stays in the gallery with status "cancelled". '
    + 'Use it when a job was started with wrong settings or takes too long. Returns the item with its new status. Fails on an unknown id '
    + 'and on a job that already ended (done, error or cancelled); to remove a finished item use delete_item.',
  inputSchema: { id: z.string().describe('Gallery id of the queued or running job') },
  annotations: { destructiveHint: false, idempotentHint: true },
}, async ({ id }) => {
  try {
    await backend.cancel(id);
    return await report(await backend.generation(id));
  } catch (e) {
    return fail(e);
  }
});

server.registerTool('delete_item', {
  title: 'Delete a gallery item',
  description: 'Permanently deletes a finished, failed or cancelled gallery item together with its image and video files; this cannot be undone. '
    + 'Only call it when the user asks to delete that item. Returns "Deleted <id>"; fails with the reason on an unknown id, on a running '
    + 'job (cancel it first with cancel_job) and on the reference sheet of a figure (delete the figure first with delete_figure).',
  inputSchema: { id: z.string().describe('Gallery id of the item to delete') },
  annotations: { destructiveHint: true, idempotentHint: true },
}, async ({ id }) => {
  try {
    await backend.remove(id);
    return text(`Deleted ${id}.`);
  } catch (e) {
    return fail(e);
  }
});

server.registerTool('enhance_prompt', {
  title: 'Write a prompt with the local language model',
  description: 'Turns a short idea (any language) into a detailed English prompt for a target: "Generate image", "Edit image", '
    + '"Text to video (LTX)", "Image to video (LTX)" or "Wan camera move". Optional image (gallery id or path) for image-based targets. '
    + 'large=true uses Qwen 3.5 9B instead of Gemma 4 E2B. Takes 1 to 4 seconds, each call words it differently. '
    + 'Skip it when you already wrote a detailed prompt yourself and pass that straight to generate. Returns the prompt as plain text, '
    + 'nothing is added to the gallery; fails on an unknown target or when the language model is not installed.',
  inputSchema: {
    idea: z.string().describe('Short idea or rough prompt, any language'),
    target: z.string().default('Generate image').describe('What the prompt is for, one of the names above'),
    large: z.boolean().default(false).describe('true = larger, slower model with better wording'),
    image: z.string().optional().describe('Gallery id or absolute path of the image the prompt refers to (edit, image to video)'),
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
    + 'Region as fractions of the image: x, y = top-left corner, w, h = size (0 to 1). Default: the whole image. '
    + 'Returns the crop as an inline WebP image; read-only, fails on an unknown id. For a first look at the whole result the preview '
    + 'from generate, wait or get_item is enough; use this for the details.',
  inputSchema: {
    id: z.string().describe('Gallery id of an image or video'),
    x: z.number().min(0).max(1).default(0).describe('Left edge as a fraction of the width'),
    y: z.number().min(0).max(1).default(0).describe('Top edge as a fraction of the height'),
    w: z.number().min(0.02).max(1).default(1).describe('Width of the region as a fraction, e.g. 0.25 = a quarter'),
    h: z.number().min(0.02).max(1).default(1).describe('Height of the region as a fraction'),
  },
  annotations: { readOnlyHint: true },
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
    + 'Returns an image reference ("upload:…") and its size, to pass in generate.images; it is not added to the gallery. '
    + 'Use the id of a finished shot from generate, wait or gallery. Fails if the id is not a finished video. '
    + 'For a cut to a separate scene start from a new image instead.',
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
    + 'shot\x27s size and frame rate; shots without sound get silence. '
    + 'Use it as the last step of a film, after every shot was checked; it does not change the shots, redo a weak one with generate first. '
    + 'Renders right away (seconds to a few minutes) and returns '
    + 'the new gallery id with a preview; fails if an id is unknown or not a finished video, or a music/logo file cannot be read.',
  inputSchema: {
    ids: z.array(z.string()).min(2).max(30).describe('Gallery ids of finished videos, in playing order'),
    fade: z.number().min(0).max(3).default(0).describe('Seconds of each transition; 0 = hard cut'),
    transition: z.enum(['fade', 'fadeblack', 'fadewhite', 'wipeleft', 'slideleft']).default('fade')
      .describe('Kind of transition when fade > 0: fade = cross-dissolve, fadeblack/fadewhite = dip to black/white, wipeleft, slideleft'),
    fade_in: z.number().min(0).max(5).default(0).describe('Seconds of fade from black at the start (picture and sound)'),
    fade_out: z.number().min(0).max(5).default(0).describe('Seconds of fade to black at the end (picture and sound)'),
    format: z.enum(['mp4', 'webm']).default('mp4').describe('mp4 = H.264/AAC, plays everywhere; webm = VP9/Opus, royalty free'),
    music: z.string().optional().describe('Absolute path of an audio file (mp3, wav, m4a, aac, flac, ogg); trimmed to the clip, fades out at the end'),
    music_volume: z.number().min(0).max(2).default(0.8).describe('Music level, 1 = unchanged'),
    shot_volume: z.number().min(0).max(1).default(0.35).describe('Level of the shots\' own sounds under the music'),
    logo: z.string().optional().describe('Gallery id or absolute path of a PNG (transparency kept), shown over the whole clip'),
    logo_position: z.enum(['tl', 'tr', 'bl', 'br']).default('br').describe('Corner: top/bottom + left/right'),
    logo_scale: z.number().min(0.03).max(0.5).default(0.12).describe('Logo width as a share of the video width'),
    endcard: z.string().optional().describe('Gallery id or absolute path of an image appended as the last shot'),
    endcard_seconds: z.number().min(0.5).max(10).default(2).describe('How long the end card is shown'),
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
    + 'Use the ids as images in generate, e.g. to animate an image or edit it further. Returns one line per item (at most 50, no paging); '
    + 'search matches any part of the prompt, ignoring case. For the details and preview of one item use get_item, '
    + 'for characters and products figures.',
  inputSchema: {
    limit: z.number().min(1).max(50).default(10).describe('How many items, newest first'),
    search: z.string().optional().describe('Only items whose prompt or expanded prompt contains this text'),
  },
  annotations: { readOnlyHint: true },
}, async ({ limit, search }) => {
  try {
    const page = await backend.gallery(limit, search);
    return text(page.items.map((g) => `${g.id}  ${g.workflow}  ${g.status}${g.video ? '  video' : ''}  ${g.prompt.slice(0, 100)}`).join('\n') || 'Gallery is empty.');
  } catch (e) {
    return fail(e);
  }
});

await server.connect(new StdioServerTransport());
