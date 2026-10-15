# Image generation tool

Status: current
Owner: src/tools/image/

`image.generate` draws pictures through Atomic Chat Core's diffusion jobs (`src/local-llm/core/core-image.ts`) and copies the files into the session's working folder; the agent shows them with `reply.attachments`. With an OpenRouter key the job runs in the cloud (`target: {provider: "openrouter", model}`, key registered with Core per call, never through Core's environment) and asks for approval below level 3 (`paid_generation`); `model: "local"` uses the model loaded in Core and never asks. The prompt offers the tool only while an OpenRouter key is configured (`GATED_TOOLS.image`). Analytics: `image_generated`, shape only.

Read [tool instructions](../AGENTS.md), [Core client](../../local-llm/core/core-image.ts) and the adjacent tests before changing arguments, approval or where files are saved.
