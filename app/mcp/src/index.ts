import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { FieldSpec, Generation, ParamValue, WorkflowInfo } from '@brennglas/shared';
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
Known LTX limits and what helps:
- Camera presets are text appended to the prompt, not a camera path. "Tracking shot" is a sideways move; for a subject walking
  towards the camera use "Lead shot (subject walks towards camera)" or "Slow pull out" and say "full body in frame".
- Whatever is outside the start image gets invented (extra people, props). Show the whole set in the start image.
- Stage directions are suggestions ("turns to the camera" may become a turn away). When the end pose matters, generate the
  end image too and use first + last frame (ltx25-flf2v).
- Faces in wide shots have few pixels and lose likeness: prefer medium/close shots, or 1080p for wide shots.
- For an exact camera path use Wan Fun Camera (no sound, max 720p) and add sound via the music track.
Call list_models first to see models, fields and option names. Prefer English prompts. Tell the user the gallery ids and links.`;

const server = new McpServer({ name: 'brennglas', version: '0.3.0' }, { instructions: INSTRUCTIONS });

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
      id: m.id, name: m.name, license: `${m.license.name} (commercial: ${m.license.commercial})`,
      ...(m.missing?.length ? { missing: m.missing } : {}),
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
    wait_seconds: z.number().min(0).max(600).default(90),
  },
}, async ({ workflow, prompt, params, images, wait_seconds }) => {
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
    const { id } = await backend.generate({ workflow, prompt, params: p, ...(sources.length ? { images: sources } : {}) });
    return await report(await waitFor(id, wait_seconds));
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
  description: 'Joins finished videos (gallery ids, in order) into one MP4 that appears in the gallery. Shots are matched to the first '
    + 'shot\x27s size and frame rate; shots without sound get silence. fade: seconds of cross-fade between shots, 0 = hard cut.',
  inputSchema: {
    ids: z.array(z.string()).min(2).max(30),
    fade: z.number().min(0).max(3).default(0),
    music: z.string().optional().describe('Absolute path of an audio file (mp3, wav, m4a, aac, flac, ogg); trimmed to the clip, fades out at the end'),
    music_volume: z.number().min(0).max(2).default(0.8),
    shot_volume: z.number().min(0).max(1).default(0.35).describe('Level of the shots\' own sounds under the music'),
    logo: z.string().optional().describe('Gallery id or absolute path of a PNG (transparency kept), shown over the whole clip'),
    logo_position: z.enum(['tl', 'tr', 'bl', 'br']).default('br'),
    logo_scale: z.number().min(0.03).max(0.5).default(0.12).describe('Logo width as a share of the video width'),
    endcard: z.string().optional().describe('Gallery id or absolute path of an image appended as the last shot'),
    endcard_seconds: z.number().min(0.5).max(10).default(2),
  },
}, async ({ ids, fade, music, music_volume, shot_volume, logo, logo_position, logo_scale, endcard, endcard_seconds }) => {
  try {
    return await report(await backend.concat({
      ids, fade, musicVolume: music_volume, shotVolume: shot_volume, logoPosition: logo_position, logoScale: logo_scale,
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
