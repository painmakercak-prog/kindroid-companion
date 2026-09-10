import { env } from "cloudflare:workers";
import { getRawDb } from "@/db";
import { seal, unseal } from "./crypto.mjs";
import { validateModelUrl, MODEL, CARTESIA_VERSION, speechPayload } from "./core.mjs";

export type Config = { provider: "kindroid" | "gemma"; kindroidKey: string; kinId: string; modelUrl: string; modelKey: string; deepgramKey: string; cartesiaKey: string; voiceId: string; thinking: boolean };
export const emptyConfig: Config = { provider: "kindroid", kindroidKey: "", kinId: "", modelUrl: "", modelKey: "", deepgramKey: "", cartesiaKey: "", voiceId: "", thinking: false };
export class ApiError extends Error { constructor(message: string, public status = 400) { super(message); } }
export const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
export function identity(request: Request) {
  const user = request.headers.get("oai-authenticated-user-id");
  if (!user) throw new ApiError("Sign in to use your companion.", 401);
  if (request.method !== "GET") {
    const origin = request.headers.get("origin");
    if (!origin || origin !== new URL(request.url).origin) throw new ApiError("Please reload the companion and try again.", 403);
  }
  return user;
}
export async function body(request: Request) {
  if (!request.headers.get("content-type")?.includes("application/json")) throw new ApiError("Expected JSON.", 415);
  const content = await request.text();
  if (content.length > 16000) throw new ApiError("That input is too long.", 413);
  try { return JSON.parse(content); } catch { throw new ApiError("Invalid request."); }
}
function encryptionKey() { return (env as unknown as Record<string, string>).COMPANION_SECRETS_KEY; }
export async function profile(user: string) {
  const row = await getRawDb().prepare("SELECT config, memory FROM profiles WHERE user_id = ?").bind(user).first<{ config: string; memory: string }>();
  return { config: row ? { ...emptyConfig, ...await unseal(row.config, user, encryptionKey()) } as Config : { ...emptyConfig }, memory: row?.memory ?? "" };
}
export function publicConfig(config: Config, memory: string) {
  const textReady = config.provider === "kindroid" ? !!(config.kindroidKey && config.kinId) : !!(config.modelUrl && config.modelKey);
  return { provider: config.provider, kinId: config.kinId, modelUrl: config.modelUrl, voiceId: config.voiceId, thinking: config.thinking, memory,
    model: config.provider === "kindroid" ? "Kindroid" : MODEL,
    keys: { kindroid: !!config.kindroidKey, model: !!config.modelKey, deepgram: !!config.deepgramKey, cartesia: !!config.cartesiaKey },
    textReady, voiceReady: textReady && !!(config.deepgramKey && config.cartesiaKey && config.voiceId) };
}
export async function saveProfile(user: string, input: Record<string, unknown>) {
  const current = await profile(user);
  const config = { ...current.config };
  if (input.provider !== undefined) {
    if (input.provider !== "kindroid" && input.provider !== "gemma") throw new ApiError("Choose Kindroid or Gemma.");
    config.provider = input.provider;
  }
  if (typeof input.kinId === "string") {
    const id = input.kinId.trim();
    if (id && !/^[\w-]{1,160}$/.test(id)) throw new ApiError("Copy your Kin's AI ID from Kindroid's API & integrations settings.");
    config.kinId = id;
  }
  if (typeof input.modelUrl === "string") config.modelUrl = validateModelUrl(input.modelUrl.trim());
  if (typeof input.voiceId === "string") {
    if (input.voiceId && !/^[\w-]{1,100}$/.test(input.voiceId)) throw new ApiError("Enter a valid Cartesia voice ID.");
    config.voiceId = input.voiceId;
  }
  for (const name of ["kindroidKey", "modelKey", "deepgramKey", "cartesiaKey"] as const) {
    if (typeof input[name] === "string" && (input[name] as string).trim()) {
      const value = (input[name] as string).trim();
      if (value.length > 2048 || /[\r\n]/.test(value)) throw new ApiError("Invalid API key.");
      if (name === "kindroidKey" && !value.startsWith("kn_")) throw new ApiError("Your Kindroid API key should start with kn_.");
      config[name] = value;
    }
  }
  if (typeof input.thinking === "boolean") config.thinking = input.thinking;
  const memory = typeof input.memory === "string" ? input.memory.trim() : current.memory;
  if (memory.length > 3000) throw new ApiError("Keep saved memory under 3,000 characters.");
  const encrypted = await seal(config, user, encryptionKey());
  await getRawDb().prepare("INSERT INTO profiles (user_id, config, memory, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET config = excluded.config, memory = excluded.memory, updated_at = excluded.updated_at")
    .bind(user, encrypted, memory, Date.now()).run();
  return publicConfig(config, memory);
}
export async function rateLimit(user: string, operation: string, max: number) {
  const now = Date.now(), minute = Math.floor(now / 60000);
  const row = await getRawDb().prepare("INSERT INTO rate_limits (id, count, expires_at) VALUES (?, 1, ?) ON CONFLICT(id) DO UPDATE SET count = count + 1 RETURNING count")
    .bind(`${user}:${operation}:${minute}`, now + 120000).first<{ count: number }>();
  if ((row?.count ?? max + 1) > max) throw new ApiError("A little too fast. Please try again in a minute.", 429);
  await getRawDb().prepare("DELETE FROM rate_limits WHERE expires_at < ?").bind(now).run();
}
export async function providerFetch(provider: string, url: string, init: RequestInit = {}) {
  // Workers rejects redirect: "error". Handle redirects explicitly so credentials
  // are never forwarded to another destination.
  const response = await fetch(url, { ...init, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw new ApiError(`${provider} returned an unexpected redirect. The connection was stopped.`, 502);
  }
  return response;
}
export function modelFetch(config: Config, path: string, init: RequestInit = {}) {
  if (!config.modelUrl || !config.modelKey) throw new ApiError("Connect your Gemma model server in Connections.", 503);
  return providerFetch("Gemma", `${validateModelUrl(config.modelUrl)}${path}`, { ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.modelKey}` } });
}
export function cartesiaFetch(config: Config, path: string, init: RequestInit = {}) {
  if (!config.cartesiaKey) throw new ApiError("Add your Cartesia key in Connections.", 503);
  return providerFetch("Cartesia", `https://api.cartesia.ai${path}`, { ...init, headers: {
    "Content-Type": "application/json", Authorization: `Bearer ${config.cartesiaKey}`, "Cartesia-Version": CARTESIA_VERSION } });
}
export async function grant(config: Config) {
  if (!config.deepgramKey) throw new ApiError("Add your Deepgram key in Connections.", 503);
  const response = await providerFetch("Deepgram", "https://api.deepgram.com/v1/auth/grant", { method: "POST",
    headers: { Authorization: `Token ${config.deepgramKey}` }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new ApiError(`Deepgram could not connect (${response.status}). Check your credits and that your key has Member permissions.`, 502);
  const data = await response.json() as { access_token?: string };
  if (!data.access_token) throw new ApiError("Deepgram returned no session token.", 502);
  return data.access_token;
}
export async function speech(config: Config, text: string, signal: AbortSignal) {
  if (!config.voiceId) throw new ApiError("Choose a Cartesia voice in Connections.", 503);
  const response = await cartesiaFetch(config, "/tts/bytes", { method: "POST", body: JSON.stringify(speechPayload(text, config.voiceId)), signal });
  if (!response.ok || !response.body) throw new ApiError(`Cartesia could not speak (${response.status}). Check your key, voice ID, credits, and model access.`, 502);
  return new Response(response.body, { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store", "X-Audio-Sample-Rate": "24000" } });
}
export function failure(error: unknown) {
  if (error instanceof ApiError) return json({ error: error.message }, error.status);
  if (error instanceof Error && /HTTPS|address|memory|storage/.test(error.message)) return json({ error: error.message }, 400);
  return json({ error: "The connection or storage is unavailable. Please try again." }, 503);
}
