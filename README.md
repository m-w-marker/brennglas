# Brennglas

Brennglas is a local web app for open image and video models.
ComfyUI renders everything on your own GPU.
One user, one machine, no login.

Brennglas is also an MCP server: Claude can direct whole clips for you, see [Claude as your director](#claude-as-your-director).

![Editing with reference images, before/after slider and edit chain](screenshots/edit.png)

## What it does

- Text to image and image editing with up to 16 input images.
- Text to video, image to video, and first plus last frame video, with sound.
- Camera presets and looks for video, and real camera paths with Wan Fun Camera.
- Upscaling of images to 8K and of render sequences to UHD 4K.
- A prompt assistant that turns short notes (in any language) into a good English prompt.
- Live preview while rendering, before/after slider, remix, edit chains, queue.
- A gallery with search, favorites and series.
- Claude can drive Brennglas as a director over MCP: plan shots, render, check details, cut the clip.
- Interface in English and German.

![Image to video with camera preset and look](screenshots/video.png)

## Claude as your director

Brennglas comes with an MCP server. With it, Claude works your GPU like a small film crew.
Ask for a spot, and Claude:

1. plans a shot list with subject, camera move and look for each shot,
2. renders a start image per shot and checks hands, faces and products at full resolution,
3. animates each shot with LTX-2.5 or Wan Fun Camera,
4. looks at every result and redoes weak shots,
5. cuts the clip with one music track, your logo and an end card.

Every image and video shows up live in your gallery, so you can watch and step in.

Try something like this:

> Make a 15 second spot for a ceramic vase brand. Three shots in a calm Japandi living room, golden hour light, soft piano music, our logo at the end.

The tools Claude gets:

- `generate` starts an image or video job with any model and option.
- `wait` waits for a job and returns a preview.
- `inspect_image` shows a region of a result at full resolution.
- `last_frame` takes the last frame of a video as the start of the next shot.
- `concat` cuts shots into one clip with cuts or fades, music, logo and end card.
- `list_models`, `gallery` and `enhance_prompt` read the models, browse results and write prompts.

The server also hands Claude a short directing guide with the known limits of the video models and what helps.

### Connect

Brennglas must be running (`start.bat`), the MCP server talks to it.

- **Claude Code:** open the Brennglas folder. The file `.mcp.json` registers the server. Confirm it once.
- **Claude Desktop:** open Settings, Developer, Edit Config, add the block below and restart Claude Desktop.
  Replace `<brennglas folder>` with the full path of your clone.

```json
{
  "mcpServers": {
    "brennglas": {
      "command": "node",
      "args": ["<brennglas folder>\\app\\mcp\\src\\index.ts"]
    }
  }
}
```

- **Other MCP clients** that start local (stdio) servers should work the same way, for example Codex CLI or LM Studio. They are not tested.
  The client must pass images from tool results to the model. Small local models handle single images well, whole clips less so.

Clients that only connect to servers on the internet cannot reach Brennglas. It only listens on your own computer.

## Models

Each model has its own license. Brennglas shows it before you first use the model.
The table is a short summary, not legal advice. Read the license yourself.

| Model | Use | License | Commercial use |
|---|---|---|---|
| MiniMax H3 Image | image, edit | [MiniMax-H3-Image Community](https://huggingface.co/MiniMaxAI/MiniMax-H3-Image/blob/main/LICENSE) | Limited. Not licensed in the EU, UK, South Korea and USA. Above USD 1M yearly revenue only with permission. |
| Qwen-Image-2.1 Turbo | image, edit | [Qwen Research](https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo) | No. Research and evaluation only. |
| FLUX 3 Image Klein | image, edit | [FLUX Kommunity](https://huggingface.co/black-forest-labs/flux-3-image-klein) | Below USD 5M yearly revenue, with content filters or output review. |
| Krea 2 Turbo | image | [Krea 2 Community](https://huggingface.co/krea/Krea-2-Turbo) | Below USD 1M yearly revenue, with content filters or an equivalent review. |
| Z-Image Turbo | image | [Apache 2.0](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo) | Yes. |
| LTX-2.5 22B | video with sound | [LTX-2.x Community](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x) | Below USD 10M yearly revenue. |
| Wan 2.2 Fun Camera 14B | video with camera path | [Apache 2.0](https://huggingface.co/alibaba-pai/Wan2.2-Fun-A14B-Control-Camera) | Yes. |
| SeedVR2 7B | upscaling | [Apache 2.0](https://huggingface.co/ByteDance-Seed/SeedVR2-7B) | Yes. |
| Gemma 4 E2B, Qwen 3.5 9B | prompt assistant | [Apache 2.0](https://huggingface.co/Qwen/Qwen3.5-9B) | Yes. |

## Requirements

- Windows 10 or 11. Other systems may work with `pnpm dev`, but are not tested.
- An NVIDIA GPU. Tested on an RTX 3090 with 24 GB.
- [Node.js](https://nodejs.org/) 22 (22.18 or newer) or 24. Newer versions no longer ship corepack.
- A recent [ComfyUI](https://github.com/comfyanonymous/ComfyUI), tested with 0.45. `start.bat` needs the portable build.
- The model files in the ComfyUI `models` folders. Brennglas checks them and lists what is missing.
- For upscaling render sequences: the custom nodes [VideoHelperSuite](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite) and [WAS Node Suite](https://github.com/WASasquatch/was-node-suite-comfyui).
- Optional: ffmpeg and ffprobe in your `PATH`. They cut clips, take the last frame of a video and write MP4 or ProRes from upscaled sequences.

## Setup

Run these lines in a Command Prompt (cmd), not in PowerShell.

```
git clone https://github.com/m-w-marker/brennglas.git
cd brennglas\app
corepack enable --install-directory "%APPDATA%\npm" pnpm
pnpm install
copy .env.example .env
```

Open `app\.env`, remove the `#` in front of `COMFY_DIR` and set it to your portable ComfyUI folder (the one with `python_embeded`). Write the path without quotes.

## Start

Double click `start.bat`. It starts ComfyUI, Brennglas and your browser.

Or start ComfyUI yourself, then run `pnpm dev` in `app` and open http://127.0.0.1:5173.

On the first start the gallery holds eight sample images, all made with Brennglas.
Click one and press Remix to see its prompt and settings.
To try an edit, open the living room, press Keep editing and add the blue vase as a reference.

## Ideas, and your opinion

- **A light version.** Small and easy to host, without ComfyUI and without a strong GPU.
  All models would run through cloud APIs such as fal or Replicate, and you pay the provider per image.
  Would you use this? Please open an issue and tell me.
- **Remote access**, for example over Tailscale, is not a feature yet. If you need it, open an issue.

## License

Brennglas is licensed under [AGPL-3.0-only](LICENSE).
You can use it freely. If you share a changed version or run it as a web service for others, you must publish your code.
The models have their own licenses, see above.
