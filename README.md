# Gemma voice companion

The companion uses the supplied `gemma-model-server.zip` setup instead of Kindroid. Existing profiles are read as Gemma profiles, retaining saved model settings, voice credentials and local memory. Older tabs cannot switch the server back to Kindroid. Kindroid conversation history is not imported.

## What runs where

- The website runs on ChatGPT Sites with authenticated, per-user encrypted settings and D1 conversation memory.
- A separate machine runs Gemma 4 Heretical through Ollama and the authenticated gateway in `inference/`.
- Deepgram Nova-3 transcribes microphone audio.
- Cartesia Sonic 3.6 generates streaming 24 kHz PCM audio. The app pins `sonic-3.6-2026-08-27` and API version `2026-08-14`.

The ZIP is an installer and gateway package, not model weights or a running service. Publishing the website does not provision GPU hosting or install the model. The original package's Sonic-2 notes are historical; the website uses Sonic 3.6.

## Connect the model

1. Run the supplied setup on your model host using `inference/README.md`. It registers `gemma4-heretical` and exposes only authenticated `/api/tags` and `/api/chat` routes through its gateway.
2. Open Companion → Connections. Save the gateway's HTTPS origin and server access key. Do not expose Ollama directly.
3. Keep the existing Deepgram and Cartesia connections, or enter them securely in Connections.
4. Use Save & test to check the installed model and voice services, then start a conversation.

Use the exact model name `gemma4-heretical`. The app sends Ollama NDJSON requests, including a system prompt, your saved note and recent local conversation context. Only displayed or fully spoken replies are committed to memory. Thinking is off by default.

## Secrets and hosting

Provider keys are encrypted per user. Preserve the Sites `COMPANION_SECRETS_KEY` across deployments. No API keys or model server credentials belong in Git. The `.env.example` contains only an empty template.

This repository depends on the Cloudflare Worker runtime, a D1 binding named `DB`, and Sites authentication. Independent hosting requires configuring those resources and trusted authentication. GitHub uploads do not automatically deploy the website or the GPU server.

## Validation

- `npm run build` builds the Worker and website.
- `node --test tests/*.test.mjs` runs the test suite after building.
- `python3 -m unittest discover -s tests -p test_gateway.py` checks the supplied gateway.

Tests exercise simulated model responses, actual Worker execution, client audio decoding, credential preservation and account isolation. They do not verify model quality, live GPU inference or iPhone microphone behavior.
