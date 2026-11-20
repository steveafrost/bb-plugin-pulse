import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
  pretendToBeVisual: true,
});
for (const key of [
  "window",
  "document",
  "HTMLElement",
  "Element",
  "Node",
  "KeyboardEvent",
  "MutationObserver",
  "navigator",
]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as any)[key] });
}
(globalThis as any).CSS = { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\\\${char}`) };
(globalThis as any).requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { act, fireEvent, within } = await import("@testing-library/react");
const app = await loadPluginApp(() => import("../app.tsx"));

const flush = async () => {
  await act(async () => {});
};

type ModelSelection = { providerId: string; model: string; reasoningLevel: string };

function mount(
  options: { initial?: ModelSelection; set?: (next: ModelSelection) => ModelSelection | Promise<ModelSelection> } = {},
) {
  let stored: ModelSelection = options.initial ?? { providerId: "", model: "", reasoningLevel: "" };
  const section = app.settingsSections.find((s) => s.id === "capture-model")!;
  const slot = renderSlot(
    section,
    {},
    {
      rpc: {
        pulse_model_get: () => stored,
        pulse_model_set: (input: unknown) => {
          const next = input as ModelSelection;
          if (options.set) return options.set(next);
          stored = next;
          return stored;
        },
      },
    },
  );
  return { slot, stored: () => stored };
}

test("registers capture-model settings section", () => {
  assert.ok(app.settingsSections.some((s) => s.id === "capture-model" && s.title === "Capture run model"));
  assert.ok(app.settingsSections.some((s) => s.id === "task-integration"));
});

test("shows thread default initially and disables clear button", async () => {
  const { slot } = mount();
  try {
    await flush();
    assert.ok(slot.getByText("Using thread default for capture runs."));
    const clear = slot.getByRole("button", { name: "Use thread default" }) as HTMLButtonElement;
    assert.equal(clear.disabled, true);
  } finally {
    slot.lifecycle.unmount();
  }
});

test("saves picker selection and clears back to thread default", async () => {
  const { slot, stored } = mount();
  try {
    await flush();
    const picker = within(slot.getByTestId("bb-provider-model-picker"));
    fireEvent.change(picker.getByLabelText("Provider ID"), { target: { value: "openai" } });
    fireEvent.change(picker.getByLabelText("Model"), { target: { value: "gpt-5" } });
    fireEvent.change(picker.getByLabelText("Reasoning level"), { target: { value: "xhigh" } });
    fireEvent.click(picker.getByRole("button", { name: "Apply execution selection" }));
    await flush();

    assert.deepEqual(stored(), { providerId: "openai", model: "gpt-5", reasoningLevel: "xhigh" });
    assert.ok(slot.getByText("Using openai / gpt-5 / xhigh for capture runs."));
    const clear = slot.getByRole("button", { name: "Use thread default" }) as HTMLButtonElement;
    assert.equal(clear.disabled, false);

    fireEvent.click(clear);
    await flush();
    assert.deepEqual(stored(), { providerId: "", model: "", reasoningLevel: "" });
    assert.ok(slot.getByText("Using thread default for capture runs."));
    assert.equal(clear.disabled, true);
  } finally {
    slot.lifecycle.unmount();
  }
});

test("reports save errors and preserves previous selection", async () => {
  const { slot } = mount({
    initial: { providerId: "anthropic", model: "claude-sonnet-4-6", reasoningLevel: "high" },
    set: () => {
      throw new Error("kv unavailable");
    },
  });
  try {
    await flush();
    fireEvent.click(slot.getByRole("button", { name: "Use thread default" }));
    await flush();
    assert.match(slot.getByRole("alert").textContent ?? "", /kv unavailable/);
    assert.ok(slot.getByText("Using anthropic / claude-sonnet-4-6 / high for capture runs."));
  } finally {
    slot.lifecycle.unmount();
  }
});
