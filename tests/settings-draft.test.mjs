import test from "node:test";
import assert from "node:assert/strict";
import { acknowledgeSettingsEdits, connectionEdits, readSettingsDraft, writeSettingsDraft } from "../lib/settings-draft.ts";

function tabStorage() {
  const entries = new Map();
  return {
    entries,
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key),
  };
}

test("a pasted key and the open Connections panel recover immediately after a reload", () => {
  const storage = tabStorage();
  const firstEntry = { panel: "connections", values: { kindroidKey: "kn_draft_fixture", provider: "kindroid" } };
  assert.equal(writeSettingsDraft(storage, firstEntry, 1000), true);
  // Reload before any timer, blur, visibility handler, or network request runs.
  const restored = readSettingsDraft(storage, 1001);
  assert.deepEqual(restored, { ...firstEntry, values: { ...firstEntry.values, provider: "gemma" } });
  restored.values.kinId = "kin-copied-from-other-app";
  writeSettingsDraft(storage, restored, 1002);
  assert.equal(readSettingsDraft(storage, 1003).values.kindroidKey, firstEntry.values.kindroidKey);
  assert.equal(readSettingsDraft(storage, 1003).values.kinId, "kin-copied-from-other-app");
});

test("saving one field removes its temporary credential while retaining other drafts and the panel", () => {
  const storage = tabStorage();
  const values = { kindroidKey: "kn_draft_fixture", kinId: "kin-unsaved", deepgramKey: "other-unsaved-key", memory: "Unsaved note" };
  const remaining = acknowledgeSettingsEdits(values, { kindroidKey: values.kindroidKey });
  writeSettingsDraft(storage, { panel: "connections", values: remaining });
  assert.deepEqual(readSettingsDraft(storage).values, { kinId: "kin-unsaved", deepgramKey: "other-unsaved-key", memory: "Unsaved note" });
  assert.ok(![...storage.entries.values()].join("").includes("kn_draft_fixture"));
  assert.deepEqual(connectionEdits(remaining), { kinId: "kin-unsaved", deepgramKey: "other-unsaved-key" });
});

test("a delayed save response preserves edits made while the request was running", () => {
  const submitted = { kindroidKey: "kn_first_fixture", kinId: "old-kin" };
  const newer = { kindroidKey: "kn_new_fixture", kinId: "old-kin", voiceId: "new-voice" };
  assert.deepEqual(acknowledgeSettingsEdits(newer, submitted), { kindroidKey: "kn_new_fixture", voiceId: "new-voice" });
});

test("expired or malformed drafts are discarded and blocked tab storage does not break editing", () => {
  const storage = tabStorage();
  writeSettingsDraft(storage, { panel: "connections", values: { kindroidKey: "kn_expired_fixture" } }, 1000);
  assert.deepEqual(readSettingsDraft(storage, 3601000), { panel: null, values: {} });
  assert.equal(storage.entries.size, 0);
  storage.setItem("companion:settings-draft:v1", "{broken json");
  assert.deepEqual(readSettingsDraft(storage), { panel: null, values: {} });
  const blocked = { getItem() { throw new Error("Blocked"); }, setItem() { throw new Error("Blocked"); }, removeItem() { throw new Error("Blocked"); } };
  assert.deepEqual(readSettingsDraft(blocked), { panel: null, values: {} });
  assert.equal(writeSettingsDraft(blocked, { panel: "connections", values: { kinId: "kin" } }), false);
});

test("closing a fully saved panel removes the draft instead of reopening it on the next visit", () => {
  const storage = tabStorage();
  writeSettingsDraft(storage, { panel: "connections", values: {} });
  writeSettingsDraft(storage, { panel: null, values: {} });
  assert.equal(storage.entries.size, 0);
  assert.deepEqual(readSettingsDraft(storage), { panel: null, values: {} });
});
