import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(new URL("../drizzle/0000_jazzy_blonde_phantom.sql", import.meta.url), "utf8"));
function prepare(sql, values = []) {
  return {
    bind(...next) { return prepare(sql, next); },
    async first(column) { const row = sqlite.prepare(sql).get(...values); return column ? row?.[column] ?? null : row ?? null; },
    async all() { return { results: sqlite.prepare(sql).all(...values), success: true, meta: {} }; },
    async run() { const result = sqlite.prepare(sql).run(...values); return { results: [], success: true, meta: { changes: Number(result.changes) } }; },
    async raw() { return sqlite.prepare(sql).all(...values).map(row => Object.values(row)); }
  };
}
export const testEnv = { DB: { prepare, async batch(statements) { return Promise.all(statements.map(s => s.run())); } }, COMPANION_SECRETS_KEY: Buffer.alloc(32, 4).toString("base64") };
globalThis.__companionTestEnv = testEnv;
registerHooks({
  resolve(specifier, context, next) { return specifier === "cloudflare:workers" ? { url: "companion-test:workers", shortCircuit: true } : next(specifier, context); },
  load(url, context, next) { return url === "companion-test:workers" ? { format: "module", source: "export const env = globalThis.__companionTestEnv;", shortCircuit: true } : next(url, context); }
});
