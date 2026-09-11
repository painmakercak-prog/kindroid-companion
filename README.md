# Llama 3.1 voice companion

The companion now uses `mannix/llama3.1-8b-abliterated:q5_k_m` through an authenticated Ollama gateway. Existing encrypted model settings, Deepgram/Cartesia credentials, and local memory are preserved. The internal legacy provider value remains `gemma` for profile compatibility; it no longer selects Gemma weights.

## What runs where

- The website runs on the existing Cloudflare/Sites stack with authenticated, per-user encrypted settings and D1 conversation memory.
- A separate machine runs Llama 3.1 8B Abliterated Q5_K_M through Ollama and the authenticated gateway in `inference/`.
- Deepgram Nova-3 transcribes microphone audio.
- Cartesia Sonic 3.6 generates streaming 24 kHz PCM audio.

The pinned Ollama build is about 5.7 GB. The default Docker stack is CPU-compatible; `inference/compose.gpu.yaml` optionally enables NVIDIA GPU acceleration.

## Connect the model

1. Run the model setup in `inference/README.md`, or download `/llama-model-server.zip` from the setup page.
2. The installer pulls the exact model `mannix/llama3.1-8b-abliterated:q5_k_m`.
3. Open Companion → Connections and save the gateway HTTPS origin and access key.
4. Keep or enter the Deepgram and Cartesia connections, choose a voice, then use Save & test.

The app sends native Ollama streaming chat requests with the companion system prompt, saved memory note, and recent conversation context. The runtime is intentionally bounded to an 8K context for predictable memory use and latency.

## Security

Ollama itself stays private. The gateway exposes only authenticated `GET /api/tags` and `POST /api/chat`, bounds request sizes/generation, and does not log conversation content. Provider keys remain encrypted per user. Preserve the deployment's `COMPANION_SECRETS_KEY` across releases.

## Validation

- `npm run build` builds the Worker and website.
- `node --test tests/*.test.mjs` runs the JavaScript tests after building.
- `python3 -m unittest discover -s tests -p test_gateway.py` checks the model gateway.

The tests simulate the external providers; they do not prove live model speed, microphone behavior, or speech-provider credentials on a specific device.
