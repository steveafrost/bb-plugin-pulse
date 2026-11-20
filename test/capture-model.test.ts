import { test } from "node:test";
import assert from "node:assert/strict";
import plugin from "../server.ts";
import { DEFAULT_MODEL, KNOWN_MODELS } from "../lib/jev-contract.ts";
import { fakeBb } from "./fake-bb.ts";

test("jev-contract removes pinned default model and known model list", () => {
  assert.equal(DEFAULT_MODEL, "");
  assert.deepEqual(KNOWN_MODELS, []);
});

test("pulse_model_get and pulse_model_set store captureModel in kv and pass execution options", async () => {
  const f = fakeBb();
  await plugin(f.bb as never);

  assert.deepEqual(await f.rpc.pulse_model_get!(null), { providerId: "", model: "", reasoningLevel: "" });

  const updated = await f.rpc.pulse_model_set!({
    providerId: " anthropic ",
    model: " claude-sonnet-4-6 ",
    reasoningLevel: " xhigh ",
  });
  assert.deepEqual(updated, { providerId: "anthropic", model: "claude-sonnet-4-6", reasoningLevel: "xhigh" });
  assert.deepEqual(f.kv.get("captureModel"), updated);
  assert.deepEqual(await f.rpc.pulse_model_get!(null), updated);

  await f.rpc.pulse_run_now!({ run: "hourly" });
  const spawned = f.calls["threads.spawn"]![0]![0] as Record<string, unknown>;
  assert.equal(spawned.providerId, "anthropic");
  assert.equal(spawned.model, "claude-sonnet-4-6");
  assert.equal(spawned.reasoningLevel, "xhigh");
  assert.deepEqual(spawned.executionInputSources, {
    providerId: "explicit",
    model: "explicit",
    reasoningLevel: "explicit",
  });

  await f.rpc.pulse_run_now!({ run: "hourly" });
  const sent = f.calls["threads.send"]![0]![0] as Record<string, unknown>;
  assert.equal("providerId" in sent, false);
  assert.equal(sent.model, "claude-sonnet-4-6");
  assert.equal(sent.reasoningLevel, "xhigh");
  assert.deepEqual(sent.executionInputSources, { model: "explicit", reasoningLevel: "explicit" });

  const cleared = await f.rpc.pulse_model_set!({ providerId: "", model: "", reasoningLevel: "" });
  assert.deepEqual(cleared, { providerId: "", model: "", reasoningLevel: "" });

  await f.rpc.pulse_run_now!({ run: "daily" });
  const spawnedDefault = f.calls["threads.spawn"]![1]![0] as Record<string, unknown>;
  assert.equal("providerId" in spawnedDefault, false);
  assert.equal("model" in spawnedDefault, false);
  assert.equal("reasoningLevel" in spawnedDefault, false);
  assert.equal("executionInputSources" in spawnedDefault, false);
});

async function loadModelMigration(settings: Record<string, unknown>, seed: Record<string, unknown> = {}) {
  const f = fakeBb({ settings, kv: seed });
  await plugin(f.bb as never);
  return f;
}

test("migrates a legacy model once and does not restore a cleared picker", async () => {
  const legacy = { model: "  saved-model  ", reasoningLevel: "default" };
  const first = await loadModelMigration(legacy);
  assert.deepEqual(first.kv.get("captureModel"), { providerId: "", model: "saved-model", reasoningLevel: "" });
  assert.deepEqual(first.kv.get("captureModel:legacy-settings-migrated"), true);
  first.kv.delete("captureModel");
  const s = await loadModelMigration(legacy, Object.fromEntries(first.kv));
  assert.deepEqual(s.kv.has("captureModel"), false);
});

test("keeps an existing picker value and records the migration", async () => {
  const picked = { providerId: "", model: "", reasoningLevel: "" };
  const existing = await loadModelMigration(
    { model: "  saved-model  ", reasoningLevel: "default" },
    { captureModel: picked },
  );
  assert.deepEqual(existing.kv.get("captureModel"), picked);
  assert.deepEqual(existing.kv.get("captureModel:legacy-settings-migrated"), true);
});

test("does not write a picker for absent or default legacy settings", async () => {
  for (const legacy of [{}, { model: "", reasoningLevel: "default" }]) {
    const s = await loadModelMigration(legacy);
    assert.deepEqual(s.kv.has("captureModel"), false);
    assert.deepEqual(s.kv.get("captureModel:legacy-settings-migrated"), true);
  }
});

test("migrates a legacy reasoning override without a legacy model", async () => {
  const s = await loadModelMigration({ reasoningLevel: "high" });
  assert.deepEqual(s.kv.get("captureModel"), { providerId: "", model: "", reasoningLevel: "high" });
});
