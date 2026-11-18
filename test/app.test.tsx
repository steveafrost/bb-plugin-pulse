import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "KeyboardEvent", "MutationObserver", "navigator"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as any)[key] });
}
(globalThis as any).CSS = { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\\\${char}`) };
(globalThis as any).requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { fireEvent, waitFor, act, within } = await import("@testing-library/react");
const app = await loadPluginApp(() => import("../app.tsx"));
const baseItem = { id: "slack:ui", source: "slack", kind: "followup", title: "Review bins", detail: "UI details", url: null, due: null, priority: "normal", people: [], status: "open", snoozedUntil: null, resolution: null, firstSeenAt: "2026-11-11T12:00:00Z", lastSeenAt: "2026-11-11T12:00:00Z", updatedAt: "2026-11-11T12:00:00Z", resolvedAt: null, lastChangedBy: "hourly", taskLinks: [] };
let revision = 0;
function snapshot(items = [baseItem], suggestions = "missing", integrationEnabled = true, caps?: { tasksAvailable?: boolean; tasksPluginEnabled?: boolean }) {
  return { home: "/tmp", generatedAt: new Date(Date.now() + ++revision * 1000).toISOString(), lastViewedAt: null, items, lastRuns: {}, recentRuns: [], tasksAvailable: integrationEnabled && (caps?.tasksAvailable ?? true), tasksPluginEnabled: integrationEnabled && (caps?.tasksPluginEnabled ?? true), taskIntegrationEnabled: integrationEnabled, taskSuggestions: suggestions, automations: [], missedRuns: [], parentThreadId: null };
}
async function mount(options: { items?: any[]; suggestions?: string; create?: () => Promise<unknown>; recommend?: () => unknown; search?: (input: { search: string; cursor?: string; statuses?: ("todo" | "backlog" | "done")[] }) => unknown; link?: () => unknown; integrationEnabled?: boolean; tasksAvailable?: boolean; tasksPluginEnabled?: boolean } = {}) {
  let current = snapshot(options.items, options.suggestions, options.integrationEnabled, options);
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
    pulse_snapshot: () => current,
    pulse_task_projects: () => ({ projects: [{ id: "p1", name: "Project", prefix: "ABC" }] }),
    pulse_task_labels: () => ({ labels: [] }),
    pulse_task_search: options.search ?? (() => ({ tasks: [{ id: "t1", key: "ABC-1", title: "Task", status: "todo" }], nextCursor: null })),
    pulse_task_create: options.create ?? (() => Promise.resolve(current)),
    pulse_task_link: options.link ?? (() => current),
    pulse_task_recommend: options.recommend ?? (() => { throw new Error("Jev failed"); }),
    pulse_seen: () => current,
  } });
  await waitFor(() => assert.ok(slot.inspection.rpcCalls.some((call) => call.method === "pulse_snapshot")));
  return { slot, refresh: async () => {
    current = snapshot(options.items, options.suggestions, options.integrationEnabled, options);
    await slot.behavior.emitRealtime("pulse-changed", {});
  } };
}

test("missing Jev keeps manual task actions, guidance, and a surviving dialog", async () => {
  const { slot, refresh } = await mount();
  try {
    const trigger = await slot.findByRole("button", { name: "Quick actions" });
    fireEvent.click(trigger);
    assert.ok(await slot.findByText(/Install and enable Jev/));
    assert.ok(slot.getByRole("menuitem", { name: "Create task…" }));
    assert.ok(slot.getByRole("menuitem", { name: "Link custom task…" }));
    assert.equal(slot.inspection.rpcCalls.some((call) => call.method === "pulse_task_recommend"), false);
    fireEvent.click(slot.getByRole("menuitem", { name: "Create task…" }));
    const dialog = await slot.findByRole("dialog", { name: "Create task" });
    const title = slot.getByRole("textbox", { name: "Title" }) as HTMLInputElement;
    await waitFor(() => assert.equal(document.activeElement, title));
    fireEvent.change(title, { target: { value: "Keep this draft" } });
    await act(refresh);
    assert.equal((slot.getByRole("textbox", { name: "Title" }) as HTMLInputElement).value, "Keep this draft");
    const cancel = slot.getByRole("button", { name: "Cancel" });
    const submit = slot.getByRole("button", { name: "Create task" });
    await waitFor(() => assert.equal((submit as HTMLButtonElement).disabled, false));
    submit.focus(); fireEvent.keyDown(submit, { key: "Tab" });
    assert.equal(document.activeElement, title);
    fireEvent.keyDown(title, { key: "Tab", shiftKey: true });
    assert.equal(document.activeElement, submit);
    let escaped = false;
    const host = () => { escaped = true; };
    document.addEventListener("keydown", host);
    fireEvent.keyDown(cancel, { key: "Escape" });
    document.removeEventListener("keydown", host);
    await waitFor(() => assert.equal(dialog.isConnected, false));
    assert.equal(escaped, false);
    assert.equal(document.activeElement, trigger);
  } finally { slot.lifecycle.unmount(); }
});

test("busy task creation cannot close on Escape", async () => {
  let finish!: (value: unknown) => void;
  const { slot } = await mount({ create: () => new Promise((resolve) => { finish = resolve; }) });
  try {
    fireEvent.click(await slot.findByRole("button", { name: "Quick actions" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Create task…" }));
    await slot.findByRole("dialog");
    const submit = slot.getByRole("button", { name: "Create task" });
    await waitFor(() => assert.equal((submit as HTMLButtonElement).disabled, false));
    fireEvent.click(submit);
    await waitFor(() => assert.ok(slot.getByRole("button", { name: "Creating…" })));
    fireEvent.keyDown(document, { key: "Escape" });
    assert.ok(slot.getByRole("dialog"));
    await act(async () => { finish(snapshot()); });
    await waitFor(() => assert.equal(slot.queryByRole("dialog"), null));
  } finally { slot.lifecycle.unmount(); }
});

test("failed Jev leaves custom linking and stored links available", async () => {
  const { slot } = await mount({ suggestions: "available", items: [{ ...baseItem, taskLinks: [{ id: "linked", key: "ABC-9", title: "Linked" }] }] });
  try {
    fireEvent.click(await slot.findByRole("button", { name: "Quick actions" }));
    assert.ok(await slot.findByText("Task suggestions unavailable."));
    assert.ok(slot.getByRole("menuitem", { name: "Open linked task ABC-9" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Link custom task…" }));
    await slot.findByRole("dialog", { name: "Link custom task" });
    assert.ok(await within(slot.getByRole("region", { name: "Possible related tasks" })).findByText("Task suggestions unavailable."));
    const resultButton = await slot.findByRole("button", { name: "Link task ABC-1" });
    fireEvent.click(resultButton);
    await waitFor(() => assert.equal(slot.queryByRole("dialog") === null, true));
    assert.ok(slot.inspection.rpcCalls.some((call) => call.method === "pulse_task_link"));
  } finally { slot.lifecycle.unmount(); }
});

test("AI off does not request recommendations or show a loading message", async () => {
  const { slot } = await mount({ suggestions: "off" });
  try {
    fireEvent.click(await slot.findByRole("button", { name: "Quick actions" }));
    assert.ok(slot.getByRole("menuitem", { name: "Create task…" }));
    assert.equal(slot.queryByText("Finding tasks…"), null);
    assert.equal(slot.inspection.rpcCalls.some((call) => call.method === "pulse_task_recommend"), false);
  } finally { slot.lifecycle.unmount(); }
});

test("manual linking receives late suggestions, shows three, preserves search, and waits for a click", async () => {
  let resolve!: (value: unknown) => void;
  const pending = new Promise((done) => { resolve = done; });
  const candidates = ["2", "1", "3", "4"].map((id) => ({ id: "suggested" + id, key: "ABC-" + id, title: "Candidate " + id, status: "todo" }));
  const { slot, refresh } = await mount({ suggestions: "available", recommend: () => pending });
  try {
    fireEvent.click(await slot.findByRole("button", { name: "Quick actions" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Link custom task…" }));
    await slot.findByRole("dialog", { name: "Link custom task" });
    const region = slot.getByRole("region", { name: "Possible related tasks" });
    const search = slot.getByRole("textbox", { name: "Search tasks" });
    await waitFor(() => assert.equal(document.activeElement === search, true));
    fireEvent.change(search, { target: { value: "ownership" } });
    await act(refresh);
    assert.equal((search as HTMLInputElement).value, "ownership");
    await act(async () => { resolve({ match: null, related: null, suggestions: candidates, projects: [] }); });
    await waitFor(() => assert.equal(within(region).getAllByRole("button").length, 3));
    assert.deepEqual(within(region).getAllByRole("button").map((button) => button.getAttribute("aria-label")), ["Link suggested task ABC-2", "Link suggested task ABC-1", "Link suggested task ABC-3"]);
    assert.equal(slot.inspection.rpcCalls.some((call) => call.method === "pulse_task_link"), false);
    await waitFor(() => assert.equal((within(region).getAllByRole("button")[0] as HTMLButtonElement).disabled, false));
    fireEvent.click(within(region).getByRole("button", { name: "Link suggested task ABC-2" }));
    await waitFor(() => assert.equal(slot.queryByRole("dialog") === null, true));
    const linked = slot.inspection.rpcCalls.find((call) => call.method === "pulse_task_link");
    assert.deepEqual(linked?.input, { id: baseItem.id, key: "ABC-2", recommended: true });
  } finally { slot.lifecycle.unmount(); }
});

test("completed menu suggestions are reused without a second request or loading state", async () => {
  let calls = 0;
  const candidate = { id: "suggested", key: "ABC-2", title: "Tracking task", status: "todo" };
  const { slot } = await mount({ suggestions: "available", recommend: () => {
    if (++calls > 1) throw new Error("Do not replace the completed result");
    return { match: null, related: null, suggestions: [candidate], projects: [] };
  } });
  try {
    fireEvent.click(await slot.findByRole("button", { name: "Quick actions" }));
    await waitFor(() => { assert.equal(calls, 1); assert.equal(slot.queryByText("Finding tasks…") === null, true); });
    fireEvent.click(slot.getByRole("menuitem", { name: "Link custom task…" }));
    await slot.findByRole("dialog");
    const region = slot.getByRole("region", { name: "Possible related tasks" });
    assert.equal(calls, 1);
    assert.equal(within(region).queryByRole("button", { name: "Link suggested task ABC-2" }) !== null, true);
    await slot.findByRole("button", { name: "Link task ABC-1" });
    assert.equal(calls, 1);
    assert.equal(within(region).queryByText("Finding related tasks…") === null, true);
    assert.equal(within(region).queryByText("Task suggestions unavailable.") === null, true);
  } finally {
    const cancel = slot.queryByRole("button", { name: "Cancel" });
    if (cancel) fireEvent.click(cancel);
    slot.lifecycle.unmount();
  }
});

test("capability checking preserves completed suggestions without another request", async () => {
  let calls = 0;
  const options = { suggestions: "available", recommend: () => { calls++; return { match: null, related: null, suggestions: [{ id: "suggested", key: "ABC-2", title: "Tracking", status: "todo" }], projects: [] }; } };
  const { slot, refresh } = await mount(options);
  try {
    fireEvent.click(await slot.findByRole("button", { name: "Quick actions" }));
    await waitFor(() => { assert.equal(calls, 1); assert.equal(slot.queryByText("Finding tasks…") === null, true); });
    fireEvent.click(slot.getByRole("menuitem", { name: "Link custom task…" }));
    await slot.findByRole("dialog");
    const snapshotCalls = slot.inspection.rpcCalls.filter((call) => call.method === "pulse_snapshot").length;
    options.suggestions = "checking";
    await act(refresh);
    await waitFor(() => assert.equal(slot.inspection.rpcCalls.filter((call) => call.method === "pulse_snapshot").length > snapshotCalls, true));
    const region = slot.getByRole("region", { name: "Possible related tasks" });
    assert.equal(within(region).queryByRole("button", { name: "Link suggested task ABC-2" }) !== null, true);
    assert.equal(within(region).queryByText("Finding related tasks…") === null, true);
    assert.equal(calls, 1);
  } finally {
    const cancel = slot.queryByRole("button", { name: "Cancel" });
    if (cancel) fireEvent.click(cancel);
    slot.lifecycle.unmount();
  }
});

test("all suggested tasks already linked produces the filtered empty state", async () => {
  const candidate = { id: "linked", key: "ABC-9", title: "Already linked", status: "todo" };
  const { slot } = await mount({ suggestions: "available", items: [{ ...baseItem, taskLinks: [candidate] }], recommend: () => ({ match: null, related: null, suggestions: [candidate], projects: [] }) });
  try {
    fireEvent.click(await slot.findByRole("button", { name: "Quick actions" }));
    await waitFor(() => assert.equal(slot.queryByText("Finding tasks…") === null, true));
    fireEvent.click(slot.getByRole("menuitem", { name: "Link custom task…" }));
    await slot.findByRole("dialog");
    const region = slot.getByRole("region", { name: "Possible related tasks" });
    await slot.findByRole("button", { name: "Link task ABC-1" });
    await waitFor(() => assert.equal(within(region).queryByText("No related tasks suggested.") !== null, true));
    assert.equal(within(region).queryAllByRole("button").length, 0);
  } finally {
    const cancel = slot.queryByRole("button", { name: "Cancel" });
    if (cancel) fireEvent.click(cancel);
    slot.lifecycle.unmount();
  }
});

test("AI-off manual linking skips suggestions and keeps search available", async () => {
  const { slot } = await mount({ suggestions: "off" });
  try {
    fireEvent.click(await slot.findByRole("button", { name: "Quick actions" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Link custom task…" }));
    await slot.findByRole("dialog");
    assert.ok(slot.getByRole("textbox", { name: "Search tasks" }));
    assert.equal(slot.queryByRole("region", { name: "Possible related tasks" }), null);
    assert.equal(slot.inspection.rpcCalls.some((call) => call.method === "pulse_task_recommend"), false);
  } finally {
    const cancel = slot.queryByRole("button", { name: "Cancel" });
    if (cancel) fireEvent.click(cancel);
    slot.lifecycle.unmount();
  }
});

const page = (key: string, nextCursor: string | null = null) => ({ tasks: [{ id: key, key, title: "Task " + key, status: "todo" }], nextCursor });
async function openLink(options: Parameters<typeof mount>[0] = {}) {
  const mounted = await mount({ suggestions: "off", ...options });
  fireEvent.click(await mounted.slot.findByRole("button", { name: "Quick actions" }));
  fireEvent.click(mounted.slot.getByRole("menuitem", { name: "Link custom task…" }));
  await mounted.slot.findByRole("dialog");
  return mounted;
}
function closeLink(slot: ReturnType<typeof renderSlot>) {
  const cancel = slot.queryByRole("button", { name: "Cancel" });
  if (cancel) fireEvent.click(cancel);
  slot.lifecycle.unmount();
}

test("pending linking traps both Tab directions on the modal and isolates the board", async () => {
  let finish!: (value: unknown) => void;
  const { slot } = await openLink({ link: () => new Promise(resolve => { finish = resolve; }) });
  try {
    fireEvent.click(await slot.findByRole("button", { name: "Link task ABC-1" }));
    const dialog = slot.getByRole("dialog");
    await waitFor(() => assert.equal(dialog.querySelectorAll('button:not([disabled]), input:not([disabled])').length, 0));
    for (const shiftKey of [false, true]) {
      const event = new window.KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
      document.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true);
      assert.equal(document.activeElement, dialog);
    }
    assert.equal(dialog.closest(".pulse")?.querySelector(".pulse__inner")?.hasAttribute("inert"), true);
  } finally {
    await act(async () => { finish(snapshot()); });
    closeLink(slot);
  }
});

test("typing debounces server search, removes Search, and clearing restores browsing", async () => {
  const calls: string[] = [];
  const { slot } = await openLink({ search: ({ search }) => { calls.push(search); return page(search ? "ABC-2" : "ABC-1"); } });
  try {
    await slot.findByRole("button", { name: "Link task ABC-1" });
    const input = slot.getByRole("textbox", { name: "Search tasks" });
    assert.equal(slot.queryByRole("button", { name: "Search", exact: true }) === null, true);
    fireEvent.change(input, { target: { value: "cl" } });
    await act(async () => { await delay(150); });
    assert.deepEqual(calls, [""]);
    assert.equal((slot.getByRole("button", { name: "Link task ABC-1" }) as HTMLButtonElement).disabled, true);
    fireEvent.change(input, { target: { value: "cloudsync" } });
    await slot.findByRole("button", { name: "Link task ABC-2" });
    assert.deepEqual(calls, ["", "cloudsync"]);
    assert.equal(document.activeElement === input, true);
    fireEvent.change(input, { target: { value: "" } });
    await slot.findByRole("button", { name: "Link task ABC-1" });
    assert.deepEqual(calls, ["", "cloudsync", ""]);
  } finally { closeLink(slot); }
});

test("out-of-order search replies cannot replace the latest query", async () => {
  const pending = new Map<string, (value: unknown) => void>();
  const { slot } = await openLink({ search: ({ search }) => new Promise((resolve) => pending.set(search, resolve)) });
  try {
    const input = slot.getByRole("textbox", { name: "Search tasks" });
    assert.equal((input as HTMLInputElement).disabled, false);
    assert.equal((slot.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled, false);
    fireEvent.change(input, { target: { value: "cloud" } });
    await waitFor(() => assert.equal(pending.has("cloud"), true));
    fireEvent.change(input, { target: { value: "heartbeat" } });
    await waitFor(() => assert.equal(pending.has("heartbeat"), true));
    await act(async () => { pending.get("heartbeat")!(page("ABC-3")); });
    await slot.findByRole("button", { name: "Link task ABC-3" });
    await act(async () => { pending.get("cloud")!(page("ABC-2")); pending.get("")!(page("ABC-1")); });
    assert.equal(slot.queryByRole("button", { name: "Link task ABC-2" }) === null, true);
    assert.equal(slot.queryByRole("button", { name: "Link task ABC-1" }) === null, true);
    assert.equal(slot.queryByRole("button", { name: "Link task ABC-3" }) !== null, true);
  } finally { closeLink(slot); }
});

test("closing during search cancels debounce and ignores a late response", async () => {
  let finish!: (value: unknown) => void;
  const calls: string[] = [];
  const { slot } = await openLink({ search: ({ search }) => { calls.push(search); return new Promise((resolve) => { finish = resolve; }); } });
  try {
    fireEvent.change(slot.getByRole("textbox", { name: "Search tasks" }), { target: { value: "do not send" } });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => assert.equal(slot.queryByRole("dialog") === null, true));
    await act(async () => { finish(page("ABC-9")); await delay(350); });
    assert.deepEqual(calls, [""]);
    assert.equal(slot.queryByRole("dialog") === null, true);
  } finally { closeLink(slot); }
});

test("a stale pagination reply cannot append tasks or clear current search loading", async () => {
  let finishPage!: (value: unknown) => void;
  let finishSearch!: (value: unknown) => void;
  const { slot } = await openLink({ search: ({ search, cursor }) => cursor ? new Promise((resolve) => { finishPage = resolve; }) : search ? new Promise((resolve) => { finishSearch = resolve; }) : page("ABC-1", "next") });
  try {
    fireEvent.click(await slot.findByRole("button", { name: "Load more" }));
    fireEvent.change(slot.getByRole("textbox", { name: "Search tasks" }), { target: { value: "new" } });
    await waitFor(() => assert.equal(typeof finishSearch, "function"));
    await act(async () => { finishPage(page("ABC-2", "stale")); });
    const region = slot.getByRole("region", { name: "Search results" });
    assert.equal(within(region).queryByText("Searching…") !== null, true);
    await act(async () => { finishSearch(page("ABC-3")); });
    await slot.findByRole("button", { name: "Link task ABC-3" });
    assert.equal(slot.queryByRole("button", { name: "Link task ABC-2" }) === null, true);
    assert.equal(slot.queryByRole("button", { name: "Load more" }) === null, true);
  } finally { closeLink(slot); }
});

test("search failures offer retry without blocking Cancel", async () => {
  let calls = 0;
  const { slot } = await openLink({ search: () => { if (++calls === 1) throw new Error("Search failed"); return page("ABC-1"); } });
  try {
    assert.ok(await slot.findByText("Search failed"));
    assert.equal((slot.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled, false);
    fireEvent.click(slot.getByRole("button", { name: "Retry search" }));
    await slot.findByRole("button", { name: "Link task ABC-1" });
    assert.equal(calls, 2);
  } finally { closeLink(slot); }
});

test("retrying a failed page preserves loaded pages and retries the failed cursor", async () => {
  let lastPageCalls = 0;
  const cursors: (string | undefined)[] = [];
  const { slot } = await openLink({ search: ({ cursor }) => {
    cursors.push(cursor);
    if (!cursor) return page("ABC-1", "first");
    if (cursor === "first") return page("ABC-2", "second");
    if (++lastPageCalls === 1) throw new Error("Page failed");
    return page("ABC-3");
  } });
  try {
    fireEvent.click(await slot.findByRole("button", { name: "Load more" }));
    await slot.findByRole("button", { name: "Link task ABC-2" });
    fireEvent.click(slot.getByRole("button", { name: "Load more" }));
    fireEvent.click(await slot.findByRole("button", { name: "Retry loading more" }));
    await slot.findByRole("button", { name: "Link task ABC-3" });
    assert.equal(slot.queryByRole("button", { name: "Link task ABC-1" }) !== null, true);
    assert.equal(slot.queryByRole("button", { name: "Link task ABC-2" }) !== null, true);
    assert.deepEqual(cursors, [undefined, "first", "second", "second"]);
  } finally { closeLink(slot); }
});

test("a failed link restores input focus and keeps keyboard navigation in the dialog", async () => {
  let reject!: (reason: Error) => void;
  const { slot } = await openLink({ link: () => new Promise((_resolve, fail) => { reject = fail; }) });
  try {
    const button = await slot.findByRole("button", { name: "Link task ABC-1" });
    const input = slot.getByRole("textbox", { name: "Search tasks" });
    button.focus(); fireEvent.click(button);
    await waitFor(() => assert.equal((button as HTMLButtonElement).disabled, true));
    button.blur();
    await act(async () => { reject(new Error("Link failed")); });
    await waitFor(() => assert.equal(document.activeElement === input, true));
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    assert.equal(document.activeElement === slot.getByRole("button", { name: "Cancel" }), true);
  } finally { closeLink(slot); }
});

test("status pills combine in browse and search; All overrides and empty selection reads nothing", async () => {
  const tasks = ["todo", "backlog", "done", "in_progress"].map((status) => ({ id: status, key: status, title: status, status }));
  const calls: { search: string; statuses?: string[] }[] = [];
  const { slot } = await openLink({ search: (input) => { calls.push(input); return { tasks: tasks.filter((task) => !input.statuses || input.statuses.some((s) => s === task.status)), nextCursor: null }; } });
  try {
    await slot.findByRole("button", { name: "Link task todo" });
    assert.equal(slot.queryByRole("button", { name: "Link task done" }) === null, true);
    assert.deepEqual(calls[0].statuses, ["todo", "backlog"]);
    const pills = within(slot.getByRole("group", { name: "Task status filters" }));
    fireEvent.click(pills.getByRole("button", { name: "Done" }));
    await slot.findByRole("button", { name: "Link task done" });
    fireEvent.change(slot.getByRole("textbox", { name: "Search tasks" }), { target: { value: "cloudsync" } });
    await waitFor(() => assert.equal(calls.at(-1)?.search, "cloudsync"));
    assert.deepEqual(calls.at(-1)?.statuses, ["todo", "backlog", "done"]);
    fireEvent.click(pills.getByRole("button", { name: "All" }));
    await slot.findByRole("button", { name: "Link task in_progress" });
    assert.equal("statuses" in calls.at(-1)!, false);
    assert.equal(pills.getByRole("button", { name: "Todo" }).getAttribute("aria-pressed"), "false");
    fireEvent.click(pills.getByRole("button", { name: "Todo" }));
    await waitFor(() => assert.equal(slot.queryByRole("button", { name: "Link task done" }) === null, true));
    const count = calls.length;
    fireEvent.click(pills.getByRole("button", { name: "Todo" }));
    await slot.findByText("Select a status to browse tasks.");
    assert.equal(calls.length, count);
  } finally { closeLink(slot); }
});

test("a failed filter change keeps stale rows and cursors unusable", async () => {
  const { slot } = await openLink({ search: ({ statuses }) => {
    if (statuses?.includes("done")) throw new Error("Filter failed");
    return page("ABC-1", "old");
  } });
  try {
    await slot.findByRole("button", { name: "Link task ABC-1" });
    fireEvent.click(within(slot.getByRole("group", { name: "Task status filters" })).getByRole("button", { name: "Done" }));
    await slot.findByText("Filter failed");
    assert.equal((slot.getByRole("button", { name: "Link task ABC-1" }) as HTMLButtonElement).disabled, true);
    assert.equal(slot.queryByRole("button", { name: "Load more" }) === null, true);
  } finally { closeLink(slot); }
});

test("disabling integration stops an open dialog from issuing more Task requests", async () => {
  const options = { integrationEnabled: true };
  const { slot, refresh } = await mount(options);
  try {
    fireEvent.click(await slot.findByRole("button", { name: "Quick actions" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Link custom task…" }));
    await slot.findByRole("button", { name: "Link task ABC-1" });
    const count = slot.inspection.rpcCalls.filter((call) => call.method === "pulse_task_search").length;
    options.integrationEnabled = false;
    await act(refresh);
    await waitFor(() => assert.equal((slot.getByRole("textbox", { name: "Search tasks" }) as HTMLInputElement).disabled, true));
    assert.equal((slot.getByRole("button", { name: "Link task ABC-1" }) as HTMLButtonElement).disabled, true);
    assert.equal(slot.inspection.rpcCalls.filter((call) => call.method === "pulse_task_search").length, count);
  } finally { closeLink(slot); }
});

test("linked tasks allow local unlink while installed Tasks RPCs are unavailable", async () => {
  const { slot } = await mount({ tasksAvailable: false, tasksPluginEnabled: true, items: [{ ...baseItem, taskLinks: [{ id: "t1", key: "ABC-1", title: "Existing" }] }] });
  try {
    fireEvent.click(await slot.findByText("Review bins"));
    const button = await slot.findByRole("button", { name: "Unlink" });
    assert.equal((button as HTMLButtonElement).disabled, false);
  } finally { slot.lifecycle.unmount(); }
});

test("legacy boolean titles can open both Task dialogs", async () => {
  for (const mode of ["Create task…", "Link custom task…"]) {
    const { slot } = await mount({ items: [{ ...baseItem, title: true }], suggestions: "off" });
    try {
      fireEvent.click(await slot.findByRole("button", { name: "Quick actions" }));
      fireEvent.click(slot.getByRole("menuitem", { name: mode }));
      await slot.findByRole("dialog");
      if (mode === "Create task…") assert.equal((slot.getByRole("textbox", { name: "Title" }) as HTMLInputElement).value, "true");
      else assert.ok(slot.getByRole("textbox", { name: "Search tasks" }));
    } finally { closeLink(slot); }
  }
});

test("Escape and question mark close shortcut help from its Close button", async () => {
  const { slot } = await mount();
  try {
    const board = (await slot.findByText("Review bins")).closest(".pulse")!;
    for (const key of ["Escape", "?"]) {
      fireEvent.keyDown(board, { key: "?" });
      const help = await slot.findByRole("dialog", { name: "Keyboard shortcuts" });
      const close = within(help).getByRole("button", { name: "Close" });
      close.focus();
      fireEvent.keyDown(close, { key });
      await waitFor(() => assert.equal(slot.queryByRole("dialog", { name: "Keyboard shortcuts" }) === null, true));
    }
  } finally { slot.lifecycle.unmount(); }
});

test("compact FYI expansion agrees across click and keyboard", async () => {
  const { slot } = await mount({ items: [{ ...baseItem, id: "slack:fyi", kind: "fyi", title: "A useful update" }] });
  try {
    const row = (await slot.findByText("A useful update")).closest("li")!;
    assert.equal(row.getAttribute("aria-expanded"), "false");
    fireEvent.click(slot.getByText("A useful update"));
    await waitFor(() => assert.equal(row.getAttribute("aria-expanded"), "true"));
    act(() => { row.focus(); fireEvent.keyDown(row, { key: "i" }); });
    await waitFor(() => assert.equal(row.getAttribute("aria-expanded"), "false"));
  } finally { slot.lifecycle.unmount(); }
});
