import { getRawDb } from "@/db";
import { identity, body, json, profile, publicConfig, saveProfile, failure, rateLimit, grant, cartesiaFetch, speech, modelFetch, ApiError } from "@/lib/server";
import { chat, commitTurn } from "@/lib/chat";
import { MODEL } from "@/lib/core.mjs";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path: string[] }> };
async function handle(request: Request, context: Context) {
  try {
    const user = identity(request), path = (await context.params).path.join("/");
    if (request.method === "GET" && path === "settings") {
      const { config, memory } = await profile(user);
      return json(publicConfig(config, memory));
    }
    if (request.method === "POST" && path === "settings") {
      await rateLimit(user, "settings", 20);
      return json(await saveProfile(user, await body(request)));
    }
    if (request.method === "DELETE" && path === "settings") {
      await getRawDb().prepare("DELETE FROM profiles WHERE user_id = ?").bind(user).run();
      return json({ ok: true });
    }
    if (request.method === "DELETE" && path === "memory") {
      await getRawDb().batch([
        getRawDb().prepare("DELETE FROM turns WHERE user_id = ?").bind(user),
        getRawDb().prepare("UPDATE profiles SET memory = '', updated_at = ? WHERE user_id = ?").bind(Date.now(), user)
      ]);
      return json({ ok: true });
    }
    if (request.method === "POST" && path === "chat") {
      await rateLimit(user, "chat", 30);
      return await chat(user, await body(request), request);
    }
    if (request.method === "POST" && path === "commit") {
      const input = await body(request);
      await commitTurn(user, input);
      return json({ ok: true });
    }
    const { config } = await profile(user);
    if (request.method === "POST" && path === "listen-token") {
      await rateLimit(user, "listen", 6);
      return json({ token: await grant(config) });
    }
    if (request.method === "POST" && path === "speak") {
      await rateLimit(user, "speak", 80);
      const input = await body(request);
      if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 1600) throw new ApiError("Invalid speech text.");
      return await speech(config, input.text, AbortSignal.any([request.signal, AbortSignal.timeout(30000)]));
    }
    if (request.method === "GET" && path === "voices") {
      await rateLimit(user, "voices", 10);
      const response = await cartesiaFetch(config, "/voices", { signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new ApiError(`Cartesia could not list voices (${response.status}). Check your key.`, 502);
      const data = await response.json() as { data?: { id: string; name: string; language?: string }[] } | { id: string; name: string; language?: string }[];
      const voices = Array.isArray(data) ? data : data.data ?? [];
      return json({ voices: voices.map(v => ({ id: v.id, name: v.name, language: v.language })) });
    }
    if (request.method === "POST" && path === "check") {
      await rateLimit(user, "check", 4);
      const checks = await Promise.allSettled([
        (async () => {
          const r = await modelFetch(config, "/api/tags", { signal: AbortSignal.timeout(12000) });
          if (!r.ok) throw new Error(`Model server returned ${r.status}.`);
          const data = await r.json() as { models?: { name: string }[] };
          if (!data.models?.some(m => m.name === MODEL || m.name === MODEL + ":latest")) throw new Error("Install gemma4-heretical on the model server.");
          return "Gemma model is installed";
        })(),
        grant(config).then(() => "Deepgram token created"),
        (async () => {
          if (!config.voiceId) throw new Error("Select your Cartesia voice first.");
          const r = await speech(config, "Your companion is connected.", AbortSignal.timeout(15000));
          const bytes = await r.arrayBuffer();
          if (bytes.byteLength < 100) throw new Error("Cartesia returned no audio.");
          return "Cartesia generated audio";
        })(),
      ]);
      return json({ checks: checks.map((r, i) => ({ provider: ["Gemma", "Deepgram", "Cartesia"][i],
        ok: r.status === "fulfilled", message: r.status === "fulfilled" ? r.value : r.reason instanceof Error ? r.reason.message : "Connection failed" })) });
    }
    return json({ error: "Not found." }, 404);
  } catch (error) { return failure(error); }
}
export const GET = handle;
export const POST = handle;
export const DELETE = handle;
