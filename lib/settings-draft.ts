export type SettingsPanel = "connections" | "memory" | null;
export type SettingsEdits = Partial<{
  provider: "kindroid" | "gemma";
  kinId: string;
  kindroidKey: string;
  modelUrl: string;
  modelKey: string;
  deepgramKey: string;
  cartesiaKey: string;
  voiceId: string;
  thinking: boolean;
  memory: string;
}>;
export type SettingsDraft = { values: SettingsEdits; panel: SettingsPanel };
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const storageKey = "companion:settings-draft:v1";
const maxAge = 60 * 60 * 1000;
const textFields = ["kinId", "kindroidKey", "modelUrl", "modelKey", "deepgramKey", "cartesiaKey", "voiceId", "memory"] as const;

// Unsaved credentials stay in this tab only, never in localStorage. The server
// remains authoritative; remove acknowledged fields immediately after a save.
export function settingsDraftStorage(): DraftStorage | undefined {
  try { return window.sessionStorage; } catch { return undefined; }
}

export function readSettingsDraft(storage: DraftStorage | undefined, now = Date.now()): SettingsDraft {
  const empty: SettingsDraft = { values: {}, panel: null };
  try {
    const raw = storage?.getItem(storageKey);
    if (!raw) return empty;
    const stored = JSON.parse(raw);
    if (!stored || !Number.isFinite(stored.expiresAt) || stored.expiresAt <= now || stored.expiresAt > now + maxAge || !stored.values || typeof stored.values !== "object") {
      storage?.removeItem(storageKey);
      return empty;
    }
    const values: SettingsEdits = {};
    for (const key of textFields) {
      if (typeof stored.values[key] === "string" && stored.values[key].length <= 4000) values[key] = stored.values[key];
    }
    if (stored.values.provider) values.provider = "gemma";
    if (typeof stored.values.thinking === "boolean") values.thinking = stored.values.thinking;
    const panel = stored.panel === "connections" || stored.panel === "memory" ? stored.panel : null;
    return { values, panel };
  } catch {
    try { storage?.removeItem(storageKey); } catch {}
    return empty;
  }
}

export function writeSettingsDraft(storage: DraftStorage | undefined, draft: SettingsDraft, now = Date.now()): boolean {
  try {
    if (!storage) return false;
    if (draft.panel === null && Object.keys(draft.values).length === 0) storage.removeItem(storageKey);
    else storage.setItem(storageKey, JSON.stringify({ ...draft, expiresAt: now + maxAge }));
    return true;
  } catch { return false; }
}

export function acknowledgeSettingsEdits(current: SettingsEdits, submitted: SettingsEdits): SettingsEdits {
  const remaining = { ...current };
  for (const key of Object.keys(submitted) as (keyof SettingsEdits)[]) {
    // A slow save must not clear a newer edit or another provider's unsaved key.
    if (current[key] === submitted[key]) delete remaining[key];
  }
  return remaining;
}

export function connectionEdits(values: SettingsEdits): SettingsEdits {
  const connections = { ...values };
  delete connections.memory;
  return connections;
}
