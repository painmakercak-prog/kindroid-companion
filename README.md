# Kindroid voice companion

The existing private Companion Site now supports Kindroid as its default conversation provider. Select Gemma in Connections to keep using the previous self-hosted model setup.

## Connect on your phone

Open Connections and enter your Kindroid API key (`kn_...`) and the AI ID of your existing Kin. Add the Deepgram API key, Cartesia API key and your Cartesia voice ID when they are not already saved. Load my voices lists the voices available to your Cartesia account. Save & test saves the form and checks all three connections. Then close the panel, tap Start talking and allow microphone access.

Keys are encrypted per user on the server. Only short-lived Deepgram access tokens reach the browser. Saved secrets are never returned to the interface. Existing encrypted settings and the Site encryption key are preserved.

## Voice behavior

The microphone continuously sends mono PCM to Deepgram Nova-3. Final utterances go to Kindroid's `/v1/send-message` with `stream: true`. The plain-text reply is decoded incrementally, split into speech segments, synthesized by Cartesia, and played as streaming 24 kHz PCM. The Cartesia model is pinned to `sonic-3.6-2026-08-27`, using API version `2026-08-14` and the string voice-ID contract.

Speech onset or the interrupt button stops queued audio and cancels the app's current request. Kindroid may still retain its entire generated reply, including unspoken content. Only the new user message is sent to Kindroid: its existing persona and memory remain authoritative, and no Gemma system prompt or local history is injected. There is no automatic retry of chat mutations.

The first-audio measurement shows elapsed time from submitting an utterance to scheduling its first audio sample; it excludes Deepgram's preceding transcription/endpointing delay. This is a browser measurement, not a guaranteed latency. Keep the app in the foreground. Use headphones if speaker audio causes echo or false interruptions. Audio recordings are not stored by this app.

## Validation and limits

Provider contract tests mock Kindroid, Deepgram and Cartesia to check authentication isolation, encrypted credential storage, split UTF-8 streaming, cancellation, failures, speech payloads, and non-mutating Kindroid connection checks. Existing tests cover interruption suppression and utterance assembly. They do not establish a successful real call or iPhone microphone behavior. Live validation requires the user's provider credentials and microphone permission.

Save & test reads one Kin history item without sending a message and generates a short Cartesia audio sample for validation. The sample is checked on the server. It does not test the device microphone or speaker. No Kindroid chat contents are returned by this check.

Official API references:
- https://kindroid.ai/v2/docs/api-documentation/
- https://developers.deepgram.com/reference/speech-to-text/listen-streaming
- https://developers.deepgram.com/guides/fundamentals/token-based-authentication
- https://docs.cartesia.ai/api-reference/tts/bytes
- https://docs.cartesia.ai/build-with-cartesia/tts-models/latest

---

## Earlier Gemma setup reference

# Companion

Private, mobile-friendly voice companion using **Gemma 4 Heretical 31B**, **Deepgram Nova-3**, and **Cartesia Sonic-2**. GPT-4o has been replaced; there is no OpenAI API dependency or silent model fallback.

The website is a Vinext application deployed through Sites. A separate GPU or Apple Silicon host runs Ollama. The reviewed model gateway and setup are in `inference/` and are also downloadable from the app's `/setup` page.

## What works in the implementation

- Direct browser-to-Deepgram WebSocket transcription using short-lived server-minted tokens; mono PCM from AudioWorklet, actual hardware sample rate, and echo cancellation.
- Native Ollama streaming with the exact model name `gemma4-heretical`. Optional thinking mode; only answer text reaches the voice service.
- Sentence-by-sentence Cartesia requests with streamed 24 kHz PCM playback, interruption, cancellation and stale-turn suppression.
- Account-scoped D1 memory, up to 24 recent turns, and an editable memory note. Only displayed or fully spoken responses enter history. A partly spoken sentence is omitted on interruption.
- Server-side encrypted credentials (AES-GCM, a unique nonce and user-bound authentication), private platform access, origin checks, and bounded requests.
- Connections screen with live provider checks and account voice selection. No microphone access until the user starts a conversation. Backgrounding the page stops listening.

## Activation

1. Run the model server using `inference/README.md` and supply its authenticated HTTPS address.
2. Open the private companion's Connections screen. Enter the gateway access key, Deepgram key with Member permissions, Cartesia key, and voice ID. Secrets are never requested in chat.
3. Save, then test the saved connections. This checks the installed model, grants a Deepgram token and generates a short Cartesia sample. It may use provider credits.
4. Check a typed reply, then start a real voice conversation and interrupt a reply. Evaluate actual model quality and latency on the selected host.

The server-side `COMPANION_SECRETS_KEY` is a random 32-byte base64 key stored in Sites as a secret. Preserve it across deployments or saved connection credentials cannot be decrypted. Provider keys are encrypted per-user in D1, not stored in frontend code or browser storage.

## Status and limits

The build workspace has no accessible GPU host, no installed model, and no Deepgram or Cartesia credentials. Model loading and live voice/microphone tests have **not** been completed. The app starts in an honest setup state, not a simulated conversation. No GPU hosting has been purchased.

Sonic-2 is pinned to `sonic-2-2025-06-11` with API version `2025-04-16`. Cartesia states that Sonic-2 stops working after October 20, 2026. An intentional migration will be needed; the requested model is preserved for now.

Q4_K_M is the supplied deployment default. The repository lists about 19 GB of weights, with additional memory needed for runtime and context. Q8_0 uses about 33 GB of weights. The community modification's reported refusal/KL figures are not proof of superior conversational ability.

This app sends speech to Deepgram, answer text to Cartesia, and conversation context to your model host. It stores no audio recordings itself. Provider-side retention follows the accounts' provider settings. Saved memory can be cleared in the app.

## Development and validation

Use the existing dependency installation and build scripts. Commands after installation:

- `npm run build` — Cloudflare-compatible production build.
- `npx tsc --noEmit` — static type checks.
- `npm run test:integration` — model stream/turn handling, encryption, API identity isolation and model-gateway integration tests. The API tests use an in-memory SQLite adapter and a local mock provider, not a live account.
- `node --test tests/rendered-html.test.mjs` — rendered entry point smoke check using a mocked Workers environment.

Schema definitions: `db/schema.ts`; migrations: `drizzle/`. Production schema changes use generated migrations only. Keep applied migrations immutable.

## Sources reviewed

- https://github.com/pmarreck/gemma4-heretical — selected setup repository; reviewed installer blob `ea7d3d96b9a5a3129dae1cfe95e905113844d0e2`.
- https://docs.ollama.com/api/chat — native chat streaming and separate thinking field.
- https://developers.deepgram.com/reference/speech-to-text/listen-streaming
- https://developers.deepgram.com/guides/fundamentals/token-based-authentication
- https://github.com/deepgram/deepgram-js-sdk/blob/main/src/CustomClient.ts — browser bearer WebSocket subprotocol.
- https://docs.cartesia.ai/api-reference/tts/bytes
- https://docs.cartesia.ai/build-with-cartesia/tts-models/older-models
