// The Task integration settings section, rendered through the SDK's frontend test
// harness: guidance instead of a toggle while Tasks is missing, the two sub-options
// only while the integration is on, values kept across toggles, controls disabled
// during a write, failures that leave good values alone, and no traffic after unmount.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "KeyboardEvent", "MutationObserver", "navigator"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as any)[key] });
}
(globalThis as any).CSS = { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\\\${char}`) };
(globalThis as any).requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { act, fireEvent, waitFor } = await import("@testing-library/react");
const { definePluginApp } = await import("@get-bb/plugin-sdk/app");
const { TaskIntegrationSettings } = await import("../components/task-settings.tsx");

const app = await loadPluginApp({
  default: definePluginApp((builder) => {
    builder.slots.settingsSection({ id: "task-integration", title: "Task integration", component: TaskIntegrationSettings });
  }),
});
const section = app.settingsSections[0]!;

type State = { enabled: boolean; taskAiRecommendations: boolean; closeOnTasksDone: boolean; tasksPluginEnabled: boolean };
type Patch = Partial<{ enabled: boolean; taskAiRecommendations: boolean; closeOnTasksDone: boolean }>;
type Read = () => State | Promise<State>;
type Update = (patch: Patch) => State | Promise<State>;
type Deferred = { promise: Promise<State>; resolve: (state: State) => void; reject: (error: unknown) => void };

const START: State = { enabled: false, taskAiRecommendations: false, closeOnTasksDone: false, tasksPluginEnabled: true };

function deferred(): Deferred {
  let resolve!: (state: State) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<State>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/** Mount the section with a mutable server state; every rpc is recorded by the harness. */
function mount(options: { state?: Partial<State>; read?: Read; update?: Update } = {}) {
  let current: State = { ...START, ...options.state };
  const updates: Patch[] = [];
  const rpc = {
    pulse_task_settings: (_input: unknown) => (options.read ? options.read() : current),
    // The harness types every handler as `(input: unknown)`, as the wire does.
    pulse_task_settings_update: (input: unknown) => {
      const patch = input as Patch;
      updates.push(patch);
      if (options.update) return options.update(patch);
      current = { ...current, ...patch };
      return current;
    },
  };
  const slot = renderSlot(section, {}, { rpc });
  const reads = () => slot.inspection.rpcCalls.filter((call) => call.method === "pulse_task_settings").length;
  return { slot, reads, updates, updateCalls: () => updates, state: () => (current = { ...current }) };
}

/** Flush the mount read and any click's save: one macrotask-free act pass. */
const flush = async () => { await act(async () => {}); };

const master = (slot: Awaited<ReturnType<typeof mount>>["slot"]) => slot.queryByRole("switch", { name: "Enable Task integration" });
const aiSwitch = (slot: Awaited<ReturnType<typeof mount>>["slot"]) => slot.queryByRole("switch", { name: "Use AI for task recommendations" });
const closeSwitch = (slot: Awaited<ReturnType<typeof mount>>["slot"]) => slot.queryByRole("switch", { name: "Close Pulse items when all linked tasks are done" });

test("a missing or disabled Tasks plugin shows setup guidance and no switch", async () => {
  const { slot } = mount({ state: { tasksPluginEnabled: false } });
  try {
    await flush();
    assert.ok(slot.getByText(/Install and enable Tasks/));
    assert.equal(slot.queryAllByRole("switch").length, 0);
  } finally {
    slot.lifecycle.unmount();
  }
});

test("missing Tasks keeps the toggle hidden but allows disabling saved integration", async () => {
  const { slot, updates, state } = mount({ state: { enabled: true, tasksPluginEnabled: false, taskAiRecommendations: true, closeOnTasksDone: true } });
  try {
    await flush();
    assert.equal(slot.queryAllByRole("switch").length, 0);
    fireEvent.click(slot.getByRole("button", { name: "Disable Task integration" }));
    await flush();
    assert.deepEqual(updates, [{ enabled: false }]);
    assert.equal(state().enabled, false);
    assert.equal(state().taskAiRecommendations, true);
    assert.equal(state().closeOnTasksDone, true);
  } finally { slot.lifecycle.unmount(); }
});

test("with Tasks available and the integration off, only the master switch shows", async () => {
  const { slot, reads } = mount();
  try {
    await flush();
    assert.equal(reads(), 1);
    assert.equal(master(slot)!.getAttribute("aria-checked"), "false");
    assert.equal(aiSwitch(slot), null);
    assert.equal(closeSwitch(slot), null);
  } finally {
    slot.lifecycle.unmount();
  }
});

test("enabling reveals the two sub-options and sends only the master switch", async () => {
  const { slot, updates } = mount();
  try {
    await flush();
    fireEvent.click(master(slot)!);
    await flush();
    assert.deepEqual(updates, [{ enabled: true }]);
    assert.ok(aiSwitch(slot));
    assert.ok(closeSwitch(slot));
    assert.equal(aiSwitch(slot)!.getAttribute("aria-checked"), "false");
  } finally {
    slot.lifecycle.unmount();
  }
});

test("turning the integration off keeps the sub-option values it hides", async () => {
  const { slot, updates } = mount({ state: { enabled: true, taskAiRecommendations: true, closeOnTasksDone: true } });
  try {
    await flush();
    fireEvent.click(master(slot)!);
    await flush();
    // The hidden options are never written back as false.
    assert.deepEqual(updates, [{ enabled: false }]);
    assert.equal(master(slot)!.getAttribute("aria-checked"), "false");
    assert.equal(aiSwitch(slot), null);
    assert.equal(closeSwitch(slot), null);
    fireEvent.click(master(slot)!);
    await flush();
    assert.equal(aiSwitch(slot)!.getAttribute("aria-checked"), "true");
    assert.equal(closeSwitch(slot)!.getAttribute("aria-checked"), "true");
  } finally {
    slot.lifecycle.unmount();
  }
});

test("controls are disabled while a write is in flight", async () => {
  const pending = deferred();
  const { slot } = mount({ update: () => pending.promise });
  try {
    await flush();
    fireEvent.click(master(slot)!);
    await flush();
    assert.equal((master(slot) as HTMLButtonElement).disabled, true);
    assert.equal(master(slot)!.getAttribute("aria-checked"), "false");
    await act(async () => { pending.resolve({ enabled: true, taskAiRecommendations: false, closeOnTasksDone: false, tasksPluginEnabled: true }); });
    assert.equal(master(slot)!.getAttribute("aria-checked"), "true");
    assert.equal((master(slot) as HTMLButtonElement).disabled, false);
    assert.ok(aiSwitch(slot));
  } finally {
    slot.lifecycle.unmount();
  }
});

test("a failed save reports the error and keeps the values on screen", async () => {
  const { slot } = mount({ state: { enabled: true, taskAiRecommendations: true }, update: () => { throw new Error("settings row is locked"); } });
  try {
    await flush();
    fireEvent.click(master(slot)!);
    await flush();
    const alert = slot.getByRole("alert");
    assert.match(alert.textContent ?? "", /Settings were not saved/);
    assert.match(alert.textContent ?? "", /settings row is locked/);
    // The switch shows the last value the server confirmed, and is usable again.
    assert.equal(master(slot)!.getAttribute("aria-checked"), "true");
    assert.equal((master(slot) as HTMLButtonElement).disabled, false);
    assert.equal(aiSwitch(slot)!.getAttribute("aria-checked"), "true");
  } finally {
    slot.lifecycle.unmount();
  }
});

test("a failed refresh keeps the good values and says so", async () => {
  let calls = 0;
  const { slot } = mount({
    read: () => { calls += 1; if (calls === 1) return { ...START, enabled: true }; throw new Error("plugin timer is down"); },
  });
  try {
    await flush();
    assert.ok(aiSwitch(slot));
    await slot.behavior.emitRealtime("pulse-changed", {});
    assert.match(slot.getByText(/Showing the last known settings/).textContent ?? "", /plugin timer is down/);
    assert.equal(master(slot)!.getAttribute("aria-checked"), "true");
    assert.ok(aiSwitch(slot));
  } finally {
    slot.lifecycle.unmount();
  }
});

test("an older read never replaces a newer one", async () => {
  const first = deferred();
  let calls = 0;
  const { slot } = mount({ read: () => { calls += 1; return calls === 1 ? first.promise : { ...START, enabled: true }; } });
  try {
    await flush();
    assert.equal(master(slot), null);
    await slot.behavior.emitRealtime("pulse-changed", {});
    await flush();
    assert.equal(master(slot)!.getAttribute("aria-checked"), "true");
    first.resolve(START);
    await flush();
    assert.equal(master(slot)!.getAttribute("aria-checked"), "true");
  } finally {
    first.resolve(START);
    slot.lifecycle.unmount();
  }
});

test("the section re-reads every 30 seconds and stops when unmounted", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { slot, reads } = mount();
  try {
    await flush();
    assert.equal(reads(), 1);
    await act(async () => { t.mock.timers.tick(30_000); });
    assert.equal(reads(), 2);
    await slot.behavior.emitRealtime("pulse-changed", {});
    assert.equal(reads(), 3);
    slot.lifecycle.unmount();
    await act(async () => { t.mock.timers.tick(30_000); });
    await slot.behavior.emitRealtime("pulse-changed", {});
    assert.equal(reads(), 3);
  } finally {
    t.mock.timers.reset();
    slot.lifecycle.unmount();
  }
});
