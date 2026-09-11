# Llama 3.1 8B Abliterated model server

This is the inference half of the Companion stack. The website talks to an authenticated Ollama gateway, while Deepgram Nova-3 handles speech recognition and Cartesia Sonic 3.6 handles speech output.

## Model

Pinned Ollama model:

```text
mannix/llama3.1-8b-abliterated:q5_k_m
```

Ollama lists this build as an 8.03B-parameter Llama model using Q5_K_M quantization, about 5.7 GB of model weights. The companion deliberately uses an 8K runtime context for predictable memory use and latency even though the published model supports a larger context window.

## Linux host

Install Docker Engine with Compose support. NVIDIA GPU acceleration is optional but strongly improves response latency; the 8B Q5 model can also run on ordinary system RAM/CPU if you accept slower generation.

Generate the gateway access key locally, then start the services and install the model:

```bash
mkdir -p secrets
python3 -c 'import pathlib,secrets; p=pathlib.Path("secrets/model_gateway_key"); p.touch(mode=0o600,exist_ok=False); p.write_text(secrets.token_urlsafe(48))'
docker compose up -d ollama gateway
docker compose exec ollama bash /setup/install-model.sh
```

Verify the exact model is present:

```bash
docker compose exec ollama ollama list
docker compose exec ollama ollama show mannix/llama3.1-8b-abliterated:q5_k_m
docker compose exec ollama ollama run mannix/llama3.1-8b-abliterated:q5_k_m "Say hello in one sentence."
```

The installer uses Ollama's published model directly. There is no custom Gemma renderer, parser, Modelfile, or local conversion step.

## HTTPS

Do not expose Ollama port 11434 to the public internet. The included gateway only permits authenticated `GET /api/tags` and `POST /api/chat` requests.

If you control a domain and ports 80/443 reach the host, set the domain in a local `.env` file:

```bash
MODEL_DOMAIN=your-real-model-domain.com
```

Then start Caddy:

```bash
docker compose --profile https up -d
```

If your hosting provider supplies HTTPS ingress, route it to gateway port 8080 and keep Ollama private.

## Mac

On Apple Silicon, run Ollama natively instead of inside a Linux Docker VM. Install the model with:

```bash
bash install-model.sh
```

Then generate the gateway key and run:

```bash
python3 gateway.py
```

Place the gateway behind authenticated HTTPS before connecting the companion website.

## Companion setup

In Companion → Connections, enter:

- the public HTTPS origin of this gateway, without `/v1`
- the gateway access key
- your Deepgram API key
- your Cartesia API key
- your Cartesia voice ID

Use **Save & test**. The model check requires the exact `mannix/llama3.1-8b-abliterated:q5_k_m` tag to appear in Ollama's model list.

## Voice behavior

Deepgram Nova-3 receives mono PCM from the browser. Cartesia Sonic 3.6 returns 24 kHz PCM audio. The companion streams Ollama NDJSON text, begins synthesizing complete sentences as they arrive, and supports interruption/cancellation.

The app stores no audio recordings. Recent text conversation memory and the editable memory note remain account-scoped in the companion website.

## Security

Keep the gateway key out of Git. The gateway logs no conversation contents and bounds context, generation length, temperature, and concurrent inference. Keep the host and Ollama installation patched.
