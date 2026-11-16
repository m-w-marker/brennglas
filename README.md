# Brennglas

Brennglas is a local web app for open image and video models.
ComfyUI renders everything on your own GPU.
One user, one machine, no login.

![Editing with reference images, before/after slider and edit chain](screenshots/edit.png)

## What it does

- Text to image and image editing with up to 16 reference images.
- Text to video, image to video, and first plus last frame video, with sound.
- Camera presets and looks for video, and real camera paths with Wan Fun Camera.
- Upscaling of images to 8K and of render sequences to UHD 4K.
- A prompt assistant that turns short notes (in any language) into a good English prompt.
- Live preview while rendering, before/after slider, remix, edit chains, queue.
- A gallery with search, favorites and series.
- Claude can drive Brennglas as a director over MCP: plan shots, render, check details, cut the clip.
- Interface in English and German.

![Image to video with camera preset and look](screenshots/video.png)

## Models

Each model has its own license. Brennglas shows it before you first use the model.
The table is a short summary, not legal advice. Read the license yourself.

| Model | Use | License | Commercial use |
|---|---|---|---|
| MiniMax H3 Image | image, edit | [MiniMax-H3-Image Community](https://huggingface.co/MiniMaxAI/MiniMax-H3-Image/blob/main/LICENSE) | Limited. Not licensed in the EU, UK, South Korea and USA. |
| Qwen-Image-2.1 Turbo | image, edit | [Qwen Research](https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo) | No. Research and evaluation only. |
| FLUX 3 Image Klein | image, edit | [FLUX Community](https://huggingface.co/black-forest-labs/flux-3-image-klein) | Below USD 5M yearly revenue, with content filters. |
| Krea 2 Turbo | image | [Krea 2 Community](https://huggingface.co/krea/Krea-2-Turbo) | Below USD 1M yearly revenue, with content filters. |
| Z-Image Turbo | image | [Apache 2.0](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo) | Yes. |
| LTX-2.5 22B | video with sound | [LTX-2 Community](https://huggingface.co/Lightricks/LTX-2.5/blob/main/LICENSE) | Below USD 10M yearly revenue. |
| Wan 2.2 Fun Camera 14B | video with camera path | [Apache 2.0](https://huggingface.co/alibaba-pai/Wan2.2-Fun-A14B-Control-Camera) | Yes. |
| SeedVR2 7B | upscaling | [Apache 2.0](https://huggingface.co/ByteDance-Seed/SeedVR2-7B) | Yes. |
| Gemma 4 E2B, Qwen 3.5 9B | prompt assistant | [Apache 2.0](https://huggingface.co/Qwen/Qwen3.5-9B) | Yes. |

## Requirements

- Windows 10 or 11. Other systems may work with `pnpm dev`, but are not tested.
- An NVIDIA GPU. Tested on an RTX 3090 with 24 GB.
- [Node.js 22](https://nodejs.org/).
- A recent [ComfyUI](https://github.com/comfyanonymous/ComfyUI). The portable build works.
- The model files in the ComfyUI `models` folders. Brennglas checks them and lists what is missing.
- Optional: ffmpeg, for MP4 and ProRes output of upscaled sequences.

## Setup

```
git clone https://github.com/m-w-marker/brennglas.git
cd brennglas\app
corepack enable --install-directory "%APPDATA%\npm" pnpm
pnpm install
copy .env.example .env
```

Open `app\.env` and set `COMFY_DIR` to your ComfyUI folder.

## Start

Double click `start.bat`. It starts ComfyUI, Brennglas and your browser.

Or start ComfyUI yourself, then run `pnpm dev` in `app` and open http://127.0.0.1:5173.

## Use with Claude

The file `.mcp.json` registers the Brennglas MCP server.
Open this folder in Claude Code and Claude can use Brennglas.
It plans a shot list, renders start images, checks hands and faces, animates each shot and cuts the clip with music and logo.
Every result shows up live in your gallery.

## Ideas, and your opinion

- **A light version.** Small and easy to host, without ComfyUI and without a strong GPU.
  All models would run through cloud APIs such as fal or Replicate, and you pay the provider per image.
  Would you use this? Please open an issue and tell me.
- **Remote access**, for example over Tailscale, is not a feature yet. If you need it, open an issue.

## License

Brennglas is licensed under [AGPL-3.0-only](LICENSE).
You can use it freely. If you share a changed version or run it as a web service for others, you must publish your code.
The models have their own licenses, see above.
