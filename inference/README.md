# Gemma 4 Heretical model server

This is the inference half of your Companion stack. The private website uses this authenticated Ollama endpoint, Deepgram Nova-3 and Cartesia Sonic-2. GPT-4o and OpenAI keys are not used.

## Hardware

The upstream repository lists approximately 19 GB for Q4_K_M, 25 GB for Q6_K, 33 GB for Q8_0, or 17 GB for IQ4_NL. These are approximate weight sizes, not complete machine requirements. Allow extra RAM/VRAM for context and the operating system. A 24 GB NVIDIA GPU is a possible Q4_K_M starting point; 32 GB or more gives headroom. Test actual fit, time to first token, and sustained speech latency. For Q8_0, plan beyond 33 GB of available memory.

Use Docker Engine with Compose GPU support and the NVIDIA Container Toolkit. On Apple Silicon, run Ollama natively, not in a Linux Docker VM. No GPU or model is provisioned by the companion website.

## Linux NVIDIA host

1. Copy this directory to the GPU host.
2. Generate the access key locally, without putting it in source:

```bash
mkdir -p secrets
python3 -c 'import pathlib,secrets; p=pathlib.Path("secrets/model_gateway_key"); p.touch(mode=0o600,exist_ok=False); p.write_text(secrets.token_urlsafe(48))'
docker compose up -d ollama gateway
docker compose exec ollama bash /setup/install-model.sh Q4_K_M
```

The installer downloads the upstream GGUF and registers the name `gemma4-heretical` with `RENDERER gemma4` and `PARSER gemma4`. This is the crucial template fix from the selected repository. It does not run the abliteration pipeline. Model weight tags are controlled by the upstream publisher and may change; record the digest after installation:

```bash
docker compose exec ollama ollama list
docker compose exec ollama ollama show gemma4-heretical --modelfile
docker compose exec ollama ollama run gemma4-heretical "Say hello in one sentence."
```

3. Point a domain you control to the host. For Caddy TLS, ports 80 and 443 must reach this host. Put `MODEL_DOMAIN=your-real-model-domain.com` in a local `.env` file, then:

```bash
docker compose --profile https up -d
```

If your GPU provider supplies its own HTTPS ingress, route it to the gateway on port 8080. Adjust the gateway port bind only as required by that provider. Keep the Ollama service private. Never expose port 11434 directly.

4. Open Companion → Connections. Set the model server URL to that HTTPS origin (no `/v1` suffix) and enter the gateway access key from the protected local file. The website encrypts saved credentials. Add the Deepgram and Cartesia keys there, not in chat.

## Mac with native Ollama

Install Ollama 0.20.2 or newer, start it, then run `bash install-model.sh Q4_K_M`. Generate the gateway key as above. Run `python3 gateway.py` on the Mac (Python 3.12+) and place it behind authenticated HTTPS ingress. The gateway defaults to the Mac's local Ollama port. Do not use the Compose Ollama service on macOS.

## Voice setup

Deepgram must have available credits and a key with Member permissions so the website can mint a short-lived browser token. Nova-3 receives mono PCM audio at the browser's actual audio sample rate.

Cartesia needs a valid API key and a voice ID from your account. An agent ID is not a voice ID. Save the key, then load voices in Connections or enter your own voice ID. No new managed Cartesia agent is created.

The app pins `sonic-2-2025-06-11` and API version `2025-04-16`. Cartesia lists all Sonic-2 models as stopping after October 20, 2026. A later model migration requires an intentional update. No automatic substitution occurs.

## Verification

- In Connections, choose Test saved connections. It checks that Ollama has the exact model, grants a Deepgram token, and generates a short Sonic-2 sample. It may consume a small amount of speech-provider credits.
- Use typing to confirm Gemma produces coherent answers and the template does not repeat delimiters.
- Start talking, say a complete sentence, then interrupt the response. Audio should stop and a new reply should follow your next utterance.
- Try phone speakers and headphones. Browser echo cancellation helps, but speaker feedback may still trigger interruption.
- Reload and ask about an earlier turn or a saved memory note. Clear all memory to remove both.
- The app saves at most 24 recent turns; only displayed or fully spoken assistant text is committed. A partly spoken sentence is omitted on interruption.
- Thinking is off by default for voice latency. Deeper reasoning turns it on; reasoning traces are never sent to the voice synthesizer.
- No model weights or provider credentials were available in the build workspace, so live Gemma/Nova-3/Sonic-2 and device microphone tests remain to be completed on your host.

## Operations

The gateway permits only `GET /api/tags` and `POST /api/chat`, requires its access key for both, and bounds model context and generation. It logs no conversation content. Caddy handles TLS. Keep the host, Docker images, and Ollama patched; version 0.20.2 is the repository's documented minimum, not a claim that it is the latest release.

The setup uses community-modified weights. The repository's refusal rate and KL-divergence figures do not establish superiority in conversational quality. Benchmark tone, factuality, repetition, and latency with your own conversations.

Sources:
- https://github.com/pmarreck/gemma4-heretical
- https://docs.ollama.com/api/chat
- https://developers.deepgram.com/guides/fundamentals/token-based-authentication
- https://docs.cartesia.ai/build-with-cartesia/tts-models/older-models
