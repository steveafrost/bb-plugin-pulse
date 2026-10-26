// bb-plugin-pulse — panel frontend. Compiled by `bb plugin build`.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  definePluginApp,
  experimental_Icon as Icon,
  UrlLink,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  experimental_copyToClipboard,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { Automation, ItemAction, MissedRun, PulseHistoryEntry, PulseItem, PulseRun, PulseSnapshot, QuickAction, Source } from "./types";
import { horizonOf, horizonReason, type Horizon } from "./lib/horizon";
import { boardSummary, effectiveItem, fixedLater, isActive, isNew, isNewer, logRows, nextRun, runProblem, snoozeOptions, withOverlay, type RunProblem } from "./lib/panel";
import "./app.css";

const SOURCE_LABEL: Record<Source, string> = { slack: "Slack", gmail: "Email", calendar: "Calendar", github: "GitHub", docs: "Docs", other: "Other" };
const KIND_LABEL: Record<string, string> = {
  reply: "Reply", decision: "Decision", rsvp: "RSVP", conflict: "Conflict", deadline: "Deadline", review: "Review", followup: "Follow-up", fyi: "FYI",
};
const FILTERS: ("all" | Source)[] = ["all", "slack", "gmail", "calendar", "docs", "github", "other"];
type RunName = "hourly" | "daily" | "weekly";

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });

function startOfDay(d: Date): number {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c.getTime();
}

/** "now", "5m ago", "3h ago", "Thu" */
function ago(stamp: string | null | undefined): string {
  if (!stamp) return "";
  const t = Date.parse(stamp);
  if (!Number.isFinite(t)) return "";
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return dayFmt.format(new Date(t));
}

/** "Today 4:00 PM", "Tomorrow 9:00 AM", "Mon, Oct 19 12:00 PM", "overdue" */
function when(stamp: string | null | undefined): { text: string; overdue: boolean; soon: boolean } | null {
  if (!stamp) return null;
  const t = Date.parse(stamp);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const days = Math.round((startOfDay(d) - startOfDay(new Date())) / 86_400_000);
  const time = timeFmt.format(d);
  const text = days === 0 ? `Today ${time}` : days === 1 ? `Tomorrow ${time}` : days === -1 ? `Yesterday ${time}` : `${dayFmt.format(d)} ${time}`;
  return { text, overdue: t < Date.now(), soon: t - Date.now() < 4 * 3_600_000 };
}

/** Only web links reach an href; items written before 0.1.11 were not checked. */
function webUrl(url: string | null | undefined): string | undefined {
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : undefined;
}

const isPaused = (a: Automation) => a.paused ?? a.enabled === false;

/** `code` spans; tolerates a non-string (records written before 0.1.15 could hold `true`). */
function inlineCode(text: unknown): React.ReactNode[] {
  return String(text ?? "").split(/(`[^`]+`)/g).map((part, i) =>
    part.length > 2 && part.startsWith("`") && part.endsWith("`") ? <code key={i} className="pulse-code">{part.slice(1, -1)}</code> : part,
  );
}

// ---- One snapshot for the title bar and the board ----
// Both components render from this store, so a store write costs one pulse_snapshot, errors from
// either surface show in one place, and an out-of-order response never replaces a newer one.

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Shared = { snapshot: PulseSnapshot | null; error: string; overlay: Record<string, Partial<PulseItem>> };
let shared: Shared = { snapshot: null, error: "", overlay: {} };
const listeners = new Set<() => void>();
const setShared = (patch: Partial<Shared>) => { shared = { ...shared, ...patch }; listeners.forEach((f) => f()); };
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
const accept = (next: unknown) => {
  const snap = next as PulseSnapshot | null;
  if (snap && Array.isArray(snap.items) && isNewer(shared.snapshot, snap)) setShared({ snapshot: snap });
};
let rpcRef: Rpc | null = null;
let fetchTimer: ReturnType<typeof setTimeout> | undefined;
let inflight = false;
let again = false;
let failures = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
/** Coalesce refetch requests (both components hear every signal) into one call. */
function requestRefetch(delay = 30) {
  if (fetchTimer) return;
  fetchTimer = setTimeout(() => { fetchTimer = undefined; void fetchNow(); }, delay);
}
async function fetchNow() {
  if (!rpcRef) return;
  if (inflight) { again = true; return; }
  inflight = true;
  try {
    accept(await rpcRef.call("pulse_snapshot", null));
    failures = 0;
    if (shared.error && !shared.snapshot) setShared({ error: "" });
  } catch (cause) {
    failures++;
    setShared({ error: errorText(cause) });
    // Until a first snapshot arrives the board has nothing to show: keep trying, backing off.
    if (!shared.snapshot) {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => requestRefetch(0), Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5)));
    }
  } finally {
    inflight = false;
    if (again) { again = false; requestRefetch(0); }
  }
}

/** bb's realtime connection state; "connected" where the runtime predates the hook (and in the demo). */
const useConnection: () => string = typeof useRealtimeConnectionState === "function" ? useRealtimeConnectionState : () => "connected";

function usePulse() {
  const rpc = useRpc<typeof rpcContract>();
  rpcRef = rpc;
  const state = useSyncExternalStore(subscribe, () => shared);
  useEffect(() => { requestRefetch(0); }, []);
  useRealtime("pulse-changed", () => requestRefetch());
  // Signals sent while the socket was down are lost: reconcile when it comes back.
  const connection = useConnection();
  const wasDown = useRef(false);
  useEffect(() => {
    if (connection === "reconnecting") wasDown.current = true;
    else if (connection === "connected" && wasDown.current) { wasDown.current = false; requestRefetch(0); }
  }, [connection]);
  useEffect(() => {
    const wake = () => { if (document.visibilityState !== "hidden") requestRefetch(0); };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    return () => { document.removeEventListener("visibilitychange", wake); window.removeEventListener("focus", wake); };
  }, []);
  // Re-render relative times and expired snoozes every minute.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  const call = useCallback(async <T,>(promise: Promise<T>): Promise<T | null> => {
    try {
      const result = await promise;
      if (shared.error) setShared({ error: "" });
      return result;
    } catch (cause) {
      setShared({ error: errorText(cause) });
      return null;
    }
  }, []);
  const mutate = useCallback(async (promise: Promise<unknown>) => {
    const next = await call(promise);
    accept(next);
    return next !== null;
  }, [call]);
  const setError = useCallback((error: string) => setShared({ error }), []);
  const setOverlay = useCallback((id: string, patch: Partial<PulseItem> | null) => {
    const overlay = { ...shared.overlay };
    if (patch) overlay[id] = patch; else delete overlay[id];
    setShared({ overlay });
  }, []);
  return { rpc, snapshot: state.snapshot, error: state.error, overlay: state.overlay, setError, setOverlay, mutate, call, retry: () => requestRefetch(0) };
}

// ---- Menus ----

/**
 * Shared menu behaviour: outside click and Escape close it, focus moves to the first item on
 * open, ArrowUp/ArrowDown/Home/End move between items, and focus returns to the trigger on close.
 */
function useMenu() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback((refocus = true) => { setOpen(false); if (refocus) trigger.current?.focus(); }, []);
  useEffect(() => {
    if (!open) return;
    const items = () => Array.from(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
    items()[0]?.focus();
    const outside = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
      const list = items();
      const i = list.indexOf(document.activeElement as HTMLElement);
      if (i < 0) return; // e.g. typing in the custom snooze time
      const go = (n: number) => { e.preventDefault(); e.stopPropagation(); list[(n + list.length) % list.length]?.focus(); };
      if (e.key === "ArrowDown") go(i + 1);
      else if (e.key === "ArrowUp") go(i - 1);
      else if (e.key === "Home") go(0);
      else if (e.key === "End") go(list.length - 1);
      else if (e.key === "Tab") setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", key, true); };
  }, [open, close]);
  return { open, setOpen, close, root, trigger, toggle: () => setOpen((v) => !v) };
}

function IconButton({ icon, label, title, primary = false, disabled = false, busy = false, onClick, btnRef, ...aria }: {
  icon: string; label: string; title?: string; primary?: boolean; disabled?: boolean; busy?: boolean; onClick: () => void;
  btnRef?: React.Ref<HTMLButtonElement>;
  "aria-haspopup"?: "menu"; "aria-expanded"?: boolean;
}) {
  return (
    <button ref={btnRef} type="button" className={`pulse-icon-btn${primary ? " pulse-icon-btn--primary" : ""}`} onClick={onClick} disabled={disabled || busy}
      aria-label={label} aria-busy={busy || undefined} data-tip={aria["aria-expanded"] ? undefined : (title ?? label)} {...aria}>
      {busy ? <span className="pulse-spinner" aria-hidden /> : <Icon name={icon} fallback="Circle" className="pulse-icon" aria-hidden />}
    </button>
  );
}

/** datetime-local value for a Date, in local time. */
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

function SnoozeMenu({ onPick }: { onPick: (until: string) => void }) {
  const m = useMenu();
  const [custom, setCustom] = useState<string | null>(null);
  const pick = (until: string) => { m.close(); setCustom(null); onPick(until); };
  const customOk = custom !== null && Number.isFinite(Date.parse(custom)) && Date.parse(custom) > Date.now();
  return (
    <div className="pulse-menu" ref={m.root}>
      <IconButton btnRef={m.trigger} icon="Clock" label="Snooze" onClick={() => { setCustom(null); m.toggle(); }} aria-haspopup="menu" aria-expanded={m.open} />
      {m.open ? (
        <div className="pulse-menu__list" role="menu" aria-label="Snooze until">
          {snoozeOptions().map((o) => (
            <button key={o.label} type="button" role="menuitem" className="pulse-menu__item" onClick={() => pick(o.until)}>{o.label}</button>
          ))}
          {custom === null ? (
            <button type="button" role="menuitem" className="pulse-menu__item" onClick={() => setCustom(localInput(new Date(Date.now() + 86_400_000)))}>Pick a time…</button>
          ) : (
            <form className="pulse-snooze-custom" onSubmit={(e) => { e.preventDefault(); if (customOk) pick(new Date(custom).toISOString()); }}>
              <input type="datetime-local" className="pulse-input" value={custom} min={localInput(new Date())} autoFocus
                onChange={(e) => setCustom(e.target.value)} aria-label="Snooze until" />
              <button type="submit" className="pulse-btn pulse-btn--small pulse-btn--primary" disabled={!customOk}>Snooze</button>
            </form>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Running / ready / failed chip for an item handed to an agent thread. Clicking opens the thread. */
function ActionChip({ item, onOpen }: { item: PulseItem; onOpen: () => void }) {
  const a = item.action;
  if (!a) return null;
  const unread = a.status !== "running" && !a.seenAt;
  const label = a.status === "running" ? "Working" : a.status === "ready" ? "Ready" : "Action failed";
  const tip = a.status === "running" ? `Agent is working since ${ago(a.startedAt)}. Open thread`
    : `${label}${a.summary ? `: ${a.summary}` : ""}. Open thread`;
  return (
    <button type="button" className={`pulse-chip pulse-chip--${a.status}${unread ? " pulse-chip--unread" : ""}`} onClick={onOpen} title={tip}
      aria-label={`${label}${unread ? " (unread)" : ""}, open action thread`}>
      {a.status === "running" ? <span className="pulse-spinner" aria-hidden /> : <Icon name={a.status === "ready" ? "pulse-sparkles" : "pulse-alert"} fallback="Circle" className="pulse-chip__icon" aria-hidden />}
      {label}
      {a.status === "ready" && a.summary ? <span className="pulse-chip__sum">{a.summary}</span> : null}
    </button>
  );
}

function destination(url: string): string {
  if (/slack\.com/.test(url)) return "Slack";
  if (/calendar|google\.com\/calendar/.test(url)) return "Calendar";
  if (/mail\.google/.test(url)) return "Gmail";
  if (/docs\.google/.test(url)) return "Docs";
  return "the link";
}

/** Sparkle menu: copy prepared text and/or open the source. Never sends: the user pastes and sends. */
function QuickMenu({ item }: { item: PulseItem }) {
  const m = useMenu();
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 2500);
    return () => clearTimeout(t);
  }, [copied]);
  const actions = item.quickActions ?? [];
  if (!actions.length) {
    return <button type="button" className="pulse-icon-btn" disabled aria-label="No quick actions" data-tip="No quick actions for this item"><Icon name="pulse-sparkles" fallback="Circle" className="pulse-icon" aria-hidden /></button>;
  }
  const run = (a: QuickAction) => {
    m.close();
    if (a.text) void experimental_copyToClipboard({ text: a.text }).then((ok) => { if (ok) setCopied(a.label); });
  };
  return (
    <div className="pulse-menu" ref={m.root}>
      <button ref={m.trigger} type="button" className={`pulse-icon-btn${copied ? " pulse-icon-btn--done" : ""}`} onClick={m.toggle}
        aria-label="Quick actions" aria-haspopup="menu" aria-expanded={m.open}
        data-tip={m.open ? undefined : copied ? `Copied for \u201c${copied}\u201d. Paste and send` : "Quick actions"}>
        <Icon name={copied ? "Check" : "pulse-sparkles"} fallback="Circle" className="pulse-icon" aria-hidden />
      </button>
      {m.open ? (
        <div className="pulse-menu__list pulse-quick" role="menu" aria-label="Quick actions">
          {actions.map((a, i) => {
            const url = webUrl(a.url ?? item.url);
            const hint = [a.text ? "Copy text" : null, url ? `open ${destination(url)}` : null].filter(Boolean).join(", ");
            const body = (
              <>
                <span className="pulse-quick__label">{a.label}</span>
                <span className="pulse-quick__hint">{hint.charAt(0).toUpperCase() + hint.slice(1)}</span>
                {a.text ? <span className="pulse-quick__text">{a.text}</span> : null}
              </>
            );
            return url
              ? <UrlLink key={i} href={url} role="menuitem" className="pulse-menu__item pulse-quick__item" onClick={() => run(a)}>{body}</UrlLink>
              : <button key={i} type="button" role="menuitem" className="pulse-menu__item pulse-quick__item" onClick={() => run(a)}>{body}</button>;
          })}
        </div>
      ) : null}
    </div>
  );
}

function HistoryList({ history }: { history: PulseHistoryEntry[] }) {
  if (!history.length) return null;
  return (
    <div className="pulse-pop__block">
      <div className="pulse-pop__label">History</div>
      <ul className="pulse-pop__hist">
        {[...history].reverse().map((h, n) => (
          <li key={n}>
            <span className="pulse-faint">{fullTime(h.at)}</span>
            <span><b>{h.change}</b> by {h.by}{h.until ? ` until ${fullTime(h.until)}` : ""}{h.reason ? ` · ${h.reason}` : ""}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The open item's detail: why it is where it is, who is involved, full quick-action text, history. */
function ItemDetail({ item }: { item: PulseItem }) {
  return (
    <div className="pulse-item__more">
      <div className="pulse-pop__block"><div className="pulse-pop__label">Why it's here</div><span>{horizonReason(item)}</span></div>
      {item.people?.length ? <div className="pulse-pop__block"><div className="pulse-pop__label">People</div><span>{item.people.join(", ")}</span></div> : null}
      {item.quickActions?.some((a) => a.text) ? (
        <div className="pulse-pop__block">
          <div className="pulse-pop__label">Prepared replies</div>
          <ul className="pulse-pop__bullets">{item.quickActions.filter((a) => a.text).map((a, i) => <li key={i}><b>{a.label}:</b> {a.text}</li>)}</ul>
        </div>
      ) : null}
      <div className="pulse-faint">First seen {fullTime(item.firstSeenAt)} · last checked by a run {ago(item.lastSeenAt)}</div>
      <HistoryList history={item.history ?? []} />
    </div>
  );
}

function ItemRow({ item, fresh, compact = false, focused, expanded, starting, flash, onFocus, onToggle, onAction, onStartAction, onOpenAction }: {
  item: PulseItem; fresh: boolean; compact?: boolean; focused: boolean; expanded: boolean; starting: boolean; flash: boolean;
  onFocus: () => void;
  onToggle: () => void;
  onAction: (action: ItemAction, until?: string) => void;
  onStartAction: () => void;
  onOpenAction: () => void;
}) {
  const due = when(item.due);
  const running = item.action?.status === "running";
  const closed = item.status === "done" || item.status === "dismissed" || item.status === "resolved";
  const readyUnread = item.action?.status === "ready" && !item.action.seenAt;
  return (
    <li className={`pulse-item pulse-item--${item.status}${item.priority === "high" ? " pulse-item--high" : ""}${fresh ? " pulse-item--fresh" : ""}${flash ? " pulse-item--flash" : ""}`}
      aria-label={fresh ? `New: ${item.title}` : item.title} tabIndex={focused ? 0 : -1} data-item-id={item.id} data-ready={readyUnread || undefined}
      aria-expanded={compact ? undefined : expanded} onFocus={(e) => { if (e.target === e.currentTarget) onFocus(); }}>
      <div className="pulse-item__body" onClick={(e) => { if (!compact && !(e.target as HTMLElement).closest("a, button, input")) onToggle(); }}>
        <div className="pulse-item__title">
          {webUrl(item.url) ? <UrlLink href={webUrl(item.url)!} className="pulse-link">{inlineCode(item.title)}</UrlLink> : <span>{inlineCode(item.title)}</span>}
        </div>
        {item.detail ? <div className="pulse-item__detail">{inlineCode(item.detail)}</div> : null}
        <div className="pulse-item__meta">
          <span className={`pulse-tag pulse-tag--${item.source}`}>{SOURCE_LABEL[item.source] ?? item.source}</span>
          {compact ? null : <span className="pulse-tag">{KIND_LABEL[item.kind] ?? item.kind}</span>}
          {item.priority === "high" ? <span className="pulse-tag pulse-tag--high">High</span> : null}
          {item.priority === "low" ? <span className="pulse-tag pulse-tag--low">Low</span> : null}
          {item.status === "waiting" ? <span className="pulse-tag">Waiting on others</span> : null}
          {due && !closed ? <span className={`pulse-due${due.overdue ? " pulse-due--overdue" : due.soon ? " pulse-due--soon" : ""}`}>{due.overdue ? `Was due ${due.text}` : due.text}</span> : null}
          {item.status === "snoozed" && item.snoozedUntil ? <span className="pulse-faint">until {when(item.snoozedUntil)?.text}</span> : null}
          <ActionChip item={item} onOpen={onOpenAction} />
          {closed ? <span className="pulse-faint">{item.status === "resolved" ? "Resolved" : item.status === "done" ? "Done" : "Dismissed"} {ago(item.resolvedAt ?? item.updatedAt)}{item.resolution ? ` · ${item.resolution}` : ""}</span> : <span className="pulse-faint">seen {ago(item.firstSeenAt)}</span>}
        </div>
        {expanded && !compact ? <ItemDetail item={item} /> : null}
      </div>
      <div className="pulse-item__actions">
        {compact && item.status === "open" ? (
          <IconButton icon="Check" label="Got it" title="Got it: dismiss this FYI" primary onClick={() => onAction("dismiss")} />
        ) : item.status === "open" || item.status === "waiting" ? (
          <>
            <QuickMenu item={item} />
            {running
              ? <IconButton icon="ExternalLink" label="Open thread" title="Open thread: an agent is working on this" onClick={onOpenAction} />
              : <IconButton icon="pulse-bot" label="Start agent thread" busy={starting}
                  title={starting ? "Starting…" : `${item.action ? "Start a new agent thread" : "Start agent thread"}${item.agentSkills?.length ? ` \u00b7 skills: ${item.agentSkills.join(", ")}` : ""}`}
                  onClick={onStartAction} />}
            <IconButton icon="Check" label="Done" primary onClick={() => onAction("done")} />
            <SnoozeMenu onPick={(until) => onAction("snooze", until)} />
            <IconButton icon="X" label="Dismiss" title="Dismiss: not mine / not relevant" onClick={() => onAction("dismiss")} />
          </>
        ) : item.status === "snoozed" ? (
          <IconButton icon="RotateCcw" label="Wake now" title="Wake now: bring it back" onClick={() => onAction("reopen")} />
        ) : (
          <IconButton icon="RotateCcw" label="Reopen" onClick={() => onAction("reopen")} />
        )}
      </div>
    </li>
  );
}

function Section({ title, count, children, hint, empty, variant, action }: {
  title: string; count: number; children: React.ReactNode; hint?: string; empty: string; variant?: "info"; action?: React.ReactNode;
}) {
  if (!count) {
    // Empty: one faint line, so empty sections don't push the rest down the screen.
    return (
      <section className={`pulse-section pulse-section--empty${variant ? ` pulse-section--${variant}` : ""}`}>
        <header className="pulse-section__head"><h2>{title}</h2><span className="pulse-faint">· {empty}</span></header>
      </section>
    );
  }
  return (
    <section className={`pulse-section${variant ? ` pulse-section--${variant}` : ""}`}>
      <header className="pulse-section__head">
        <h2>{title}</h2>
        <span className="pulse-count">{count}</span>
        {hint ? <span className="pulse-faint pulse-section__hint">{hint}</span> : null}
        {action}
      </header>
      {children}
    </section>
  );
}

const HORIZONS: { key: Horizon; title: string; hint: string; empty: string }[] = [
  { key: "now", title: "Now", hint: "High priority or due today", empty: "nothing urgent" },
  { key: "next", title: "Next", hint: "Due tomorrow, open with no date, or parked a few days", empty: "nothing queued" },
  { key: "later", title: "Later", hint: "Low priority, further out, waiting on others or snoozed", empty: "nothing parked" },
  { key: "info", title: "Nice to Know", hint: "FYIs, no action needed", empty: "no FYIs" },
];

function latestRun(snapshot: PulseSnapshot): PulseRun | undefined {
  return Object.values(snapshot.lastRuns).sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : -1))[0];
}

/** "Daily run had 2 errors · 17h ago", "Hourly run failed 2h ago: …", for the title bar and Run Log. */
function problemText(p: RunProblem): string {
  switch (p.kind) {
    case "schedule": return `${p.label} schedule was refused by bb: ${p.error}`;
    case "failed": return `${p.label} run failed ${ago(p.at)}: ${p.error}${p.retryAt ? ` · retry ${when(p.retryAt)?.text ?? "soon"}` : ""}`;
    case "overdue": return `${p.label} run sent ${ago(p.at)} hasn't logged yet`;
    case "errors": return `${p.label} run had ${p.count} error${p.count > 1 ? "s" : ""} · ${ago(p.at)}`;
  }
}

/** The run menu line under each schedule: health first, then timing. */
function automationNote(a: Automation, r: PulseRun | undefined): { text: string; tone?: "warn" | "fail" } {
  if (a.scheduleError) return { text: `schedule refused by bb: ${a.scheduleError}`, tone: "fail" };
  if (a.pendingReload) return a.pendingError ? { text: `new schedule is not valid: ${a.pendingError}`, tone: "fail" } : { text: "reload the plugin to apply the new schedule" };
  if (a.failure) return { text: `last run failed ${ago(a.failure.at)}: ${a.failure.error}`, tone: "fail" };
  if (a.overdue) return { text: `sent ${ago(a.lastDispatchAt)}, no log yet`, tone: "warn" };
  if (a.pinState === "dead") return { text: "the thread setting points to an archived thread; clear it in settings", tone: "warn" };
  if (a.pinState === "skipped") return { text: "the thread setting can't take runs; using Pulse's own thread", tone: "warn" };
  const next = when(a.nextRunAt);
  const timing = !a.schedule ? "off" : isPaused(a) ? "paused" : next ? `next ${next.text}` : "";
  return { text: [r ? `ran ${ago(r.finishedAt)}` : "no runs yet", timing].filter(Boolean).join(" · ") };
}

/** Last updated + Run now + a menu holding the individual runs (Pulse's own schedules). */
function CaptureControl({ snapshot, capturing, runError, onCapture, onRun, onToggle, onOpenThread }: {
  snapshot: PulseSnapshot;
  capturing: boolean;
  runError: string;
  onCapture: () => void;
  onRun: (a: Automation) => void;
  onToggle: (a: Automation) => void;
  onOpenThread: (threadId: string) => void;
}) {
  const m = useMenu();
  const last = latestRun(snapshot);
  const problem = runProblem(snapshot);
  const tone = runError || problem?.kind === "schedule" || problem?.kind === "failed" ? " pulse-capture--fail" : problem ? " pulse-capture--warn" : "";
  const label = capturing ? "Updating…" : runError ? "Run failed" : last ? `Updated ${ago(last.finishedAt)}` : "Not captured yet";
  const tip = runError || (problem ? problemText(problem) : last ? `${last.run}: ${last.summary}` : undefined);
  return (
    <div className="pulse-capture" ref={m.root}>
      <span className={`pulse-faint pulse-capture__when${capturing ? " pulse-capture__when--busy" : ""}${tone}`} title={tip} role={runError ? "alert" : undefined}>
        {label}
      </span>
      <div className="pulse-split">
        <button type="button" className="pulse-btn pulse-split__main" onClick={onCapture} disabled={capturing}
          data-tip="Capture the latest from Slack, Email and Calendar">
          {capturing ? "Running…" : "Run now"}
        </button>
        <button ref={m.trigger} type="button" className="pulse-btn pulse-split__more" onClick={m.toggle} aria-haspopup="menu" aria-expanded={m.open} aria-label="Pulse runs" data-tip={m.open ? undefined : "All Pulse runs"}>
          ▾
          {problem && !m.open ? <span className="pulse-split__warn" aria-hidden /> : null}
        </button>
      </div>
      {m.open ? (
        <div className="pulse-menu__list pulse-runs-menu" role="menu">
          {snapshot.automations.map((a) => {
            const r = snapshot.lastRuns[a.run];
            const note = automationNote(a, r);
            return (
              <div key={a.run} className="pulse-runs-menu__row">
                <button type="button" role="menuitem" className="pulse-menu__item pulse-runs-menu__main" onClick={() => { m.close(false); if (a.threadId) onOpenThread(a.threadId); }} disabled={!a.threadId} title={a.threadId ? "Open this run's thread" : "The thread is created on the first run"}>
                  <span className="pulse-runs-menu__name">{a.label}{r?.errors.length && !fixedLater(r, snapshot.recentRuns) ? <span className="pulse-capture--warn"> · errors</span> : null}</span>
                  <span className={`pulse-faint pulse-runs-menu__meta${note.tone ? ` pulse-capture--${note.tone}` : ""}`}>{note.text}</span>
                </button>
                {a.pendingReload || !a.schedule || a.scheduleError ? null : (
                  <button type="button" role="menuitem" className="pulse-btn pulse-btn--small pulse-btn--quiet" onClick={() => onToggle(a)}
                    data-tip={isPaused(a) ? `Resume the ${a.label.toLowerCase()} schedule` : `Pause the ${a.label.toLowerCase()} schedule`}>
                    {isPaused(a) ? "Resume" : "Pause"}
                  </button>
                )}
                <button type="button" role="menuitem" className="pulse-btn pulse-btn--small" onClick={() => { m.close(false); onRun(a); }}>{a.failure || a.overdue ? "Retry" : "Run"}</button>
              </div>
            );
          })}
          {snapshot.parentThreadId ? (
            <>
              <div className="pulse-menu__sep" />
              <button type="button" role="menuitem" className="pulse-menu__item" onClick={() => { m.close(false); onOpenThread(snapshot.parentThreadId!); }}>Open Pulse thread</button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---- Title-bar popovers (rendered by bb in the navPanel title bar via headerContent) ----

const CLOSED_STATUSES = new Set(["resolved", "done", "dismissed"]);
const CLOSED_LABEL: Record<string, string> = { done: "Done", dismissed: "Dismissed", resolved: "Resolved" };
const fullFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function fullTime(stamp: string | null | undefined): string {
  const t = stamp ? Date.parse(stamp) : NaN;
  return Number.isFinite(t) ? fullFmt.format(new Date(t)) : "";
}

function closedAt(i: PulseItem): string {
  return i.resolvedAt ?? i.updatedAt;
}

/**
 * Toolbar icon button (tooltip on hover) that opens an anchored popover. Esc, an outside click, a
 * resize, or scrolling the board (which would leave a fixed popover behind its button) close it.
 */
function HeaderPopover({ icon, label, short, badge, warn, children }: {
  icon: string; label: string; short?: string; badge?: number; warn?: boolean;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const close = useCallback(() => { setOpen(false); btn.current?.focus(); }, []);
  const toggle = () => {
    if (open) return close();
    const r = btn.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    pop.current?.focus();
    const outside = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    const scrolled = (e: Event) => { if (!pop.current?.contains(e.target as Node)) setOpen(false); };
    const resized = () => setOpen(false);
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", esc, true);
    document.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", resized);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", esc, true);
      document.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", resized);
    };
  }, [open, close]);
  const tip = badge ? `${label} (${badge})` : label;
  return (
    <>
      <button ref={btn} type="button" className={`pulse-xbtn${open ? " pulse-xbtn--on" : ""}`} onClick={toggle}
        aria-label={tip} data-tip={open ? undefined : (short ?? label)} aria-haspopup="dialog" aria-expanded={open}>
        <Icon name={icon} fallback="ListTodo" className="pulse-xbtn__icon" aria-hidden />
        {badge ? <span className="pulse-xbtn__badge">{badge}</span> : null}
        {warn ? <span className="pulse-xbtn__warn" aria-hidden /> : null}
      </button>
      {open && pos ? (
        <div ref={pop} className="pulse-pop" role="dialog" aria-label={label} tabIndex={-1}
          style={{ top: pos.top, right: pos.right, maxHeight: `calc(100vh - ${pos.top + 16}px)` }}>
          {children(close)}
        </div>
      ) : null}
    </>
  );
}

function PopHead({ title, count, onBack, children }: { title: string; count?: number; onBack?: () => void; children?: React.ReactNode }) {
  return (
    <div className="pulse-pop__head">
      {onBack ? <button type="button" className="pulse-pop__back" onClick={onBack} aria-label="Back to list" data-tip="Back" data-tip-start="">‹</button> : null}
      <h3>{title}</h3>
      {count !== undefined ? <span className="pulse-count">{count}</span> : null}
      {children}
    </div>
  );
}

/** Kebab "More actions" menu; secondary views (Closed) open in place with a back arrow to the menu. */
function MoreMenu({ closed, onReopen, onShortcuts }: { closed: PulseItem[]; onReopen: (i: PulseItem) => void; onShortcuts: () => void }) {
  const [view, setView] = useState<"menu" | "closed">("menu");
  if (view === "closed") return <ClosedPopover items={closed} onReopen={onReopen} onBack={() => setView("menu")} />;
  return (
    <div className="pulse-more-menu">
      <button type="button" className="pulse-menu__item pulse-more-menu__item" onClick={() => setView("closed")}>
        <Icon name="CircleCheck" fallback="Check" className="pulse-more-menu__icon" aria-hidden />
        <span>Closed</span>
        <span className="pulse-faint pulse-more-menu__n">{closed.length}</span>
      </button>
      <button type="button" className="pulse-menu__item pulse-more-menu__item" onClick={onShortcuts}>
        <Icon name="Keyboard" fallback="Circle" className="pulse-more-menu__icon" aria-hidden />
        <span>Keyboard shortcuts</span>
        <span className="pulse-faint pulse-more-menu__n">?</span>
      </button>
    </div>
  );
}

function ClosedPopover({ items, onReopen, onBack }: { items: PulseItem[]; onReopen: (i: PulseItem) => void; onBack?: () => void }) {
  const [sel, setSel] = useState<string | null>(null);
  const item = sel ? items.find((i) => i.id === sel) : undefined;
  if (item) {
    return (
      <>
        <PopHead title="Closed Item" onBack={() => setSel(null)} />
        <div className="pulse-pop__detail">
          <div className="pulse-pop__title">{inlineCode(item.title)}</div>
          <div className="pulse-item__meta">
            <span className={`pulse-tag pulse-tag--${item.source}`}>{SOURCE_LABEL[item.source] ?? item.source}</span>
            <span className="pulse-tag">{KIND_LABEL[item.kind] ?? item.kind}</span>
            <span className="pulse-faint">{CLOSED_LABEL[item.status]} {fullTime(closedAt(item))}</span>
          </div>
          {item.detail ? <p className="pulse-pop__text">{inlineCode(item.detail)}</p> : null}
          {item.resolution ? (
            <div className="pulse-pop__block"><div className="pulse-pop__label">Reason</div><p className="pulse-pop__text">{inlineCode(item.resolution)}</p></div>
          ) : null}
          <HistoryList history={item.history ?? []} />
          <div className="pulse-pop__actions">
            {webUrl(item.url) ? <UrlLink href={webUrl(item.url)!} className="pulse-btn">Open source</UrlLink> : null}
            <button type="button" className="pulse-btn pulse-btn--primary" onClick={() => { onReopen(item); setSel(null); }}>Reopen</button>
          </div>
        </div>
      </>
    );
  }
  return (
    <>
      <PopHead title="Closed in the Last 3 Days" count={items.length} onBack={onBack} />
      {items.length ? (
        <ul className="pulse-pop__list">
          {items.map((i) => (
            <li key={i.id}>
              <button type="button" className="pulse-pop__row" onClick={() => setSel(i.id)}>
                <span className="pulse-pop__row-title">{inlineCode(i.title)}</span>
                <span className="pulse-pop__row-meta">
                  <span className={`pulse-pop__status pulse-pop__status--${i.status}`}>{CLOSED_LABEL[i.status]}</span>
                  <span className="pulse-faint">{ago(closedAt(i))}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="pulse-pop__empty">Nothing closed in the last 3 days.</p>}
    </>
  );
}

const RUN_LOG_PAGE = 12;

function RunLogPopover({ snapshot, onOpenThread }: { snapshot: PulseSnapshot; onOpenThread: (id: string) => void }) {
  const [sel, setSel] = useState<string | null>(null);
  const [limit, setLimit] = useState(RUN_LOG_PAGE);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const runs = snapshot.recentRuns;
  const label = (name: string) => snapshot.automations.find((a) => a.run === name)?.label ?? name;
  const rows = logRows(runs, snapshot.missedRuns ?? [], { errorsOnly });
  const row = sel ? rows.find((r) => r.key === sel) : undefined;
  const titleOf = (id: string) => snapshot.items.find((i) => i.id === id)?.title ?? snapshot.runItems?.[id]?.title ?? id;
  if (row?.kind === "missed") {
    const m: MissedRun = row.missed;
    return (
      <>
        <PopHead title={`${m.label} · didn't finish`} onBack={() => setSel(null)} />
        <div className="pulse-pop__detail">
          <div className="pulse-faint">Sent {fullTime(m.at)} ({m.trigger})</div>
          <p className="pulse-pop__text">Pulse sent this run, but it never logged: its turn failed or timed out, or a later run replaced it before it started. The next run covers its window.</p>
          <div className="pulse-pop__actions">
            <button type="button" className="pulse-btn" onClick={() => onOpenThread(m.threadId)}>Open run thread</button>
          </div>
        </div>
      </>
    );
  }
  if (row?.kind === "run") {
    const run = row.run;
    const itemList = (title: string, ids: string[]) => ids.length ? (
      <div className="pulse-pop__block">
        <div className="pulse-pop__label">{title} <span className="pulse-faint">{ids.length}</span></div>
        <ul className="pulse-pop__bullets">{ids.map((id) => <li key={id}>{inlineCode(titleOf(id))}</li>)}</ul>
      </div>
    ) : null;
    const fixed = run.errors.length ? fixedLater(run, runs) : undefined;
    return (
      <>
        <PopHead title={label(run.run)} onBack={() => setSel(null)} />
        <div className="pulse-pop__detail">
          <div className="pulse-faint">{run.startedAt ? `${fullTime(run.startedAt)} → ` : ""}{fullTime(run.finishedAt)}</div>
          <p className="pulse-pop__text">{inlineCode(run.summary)}</p>
          <div className="pulse-item__meta">
            {run.sources.length
              ? run.sources.map((s) => <span key={s} className={`pulse-tag pulse-tag--${s}`}>{SOURCE_LABEL[s as Source] ?? s}</span>)
              : <span className="pulse-tag pulse-capture--warn">No sources read</span>}
          </div>
          {run.errors.length ? (
            <div className="pulse-pop__block">
              <div className="pulse-pop__label pulse-capture--warn">Errors</div>
              <ul className="pulse-pop__bullets pulse-capture--warn">{run.errors.map((e, n) => <li key={n}>{e}</li>)}</ul>
              {fixed ? <div className="pulse-faint">A later {label(fixed.run)} run ({ago(fixed.finishedAt)}) read its sources cleanly.</div> : null}
            </div>
          ) : null}
          {itemList("Added", run.added ?? [])}
          {itemList("Resolved", run.resolved ?? [])}
          {run.thread ? (
            <div className="pulse-pop__actions">
              <button type="button" className="pulse-btn" onClick={() => onOpenThread(run.thread!)}>Open run thread</button>
            </div>
          ) : null}
        </div>
      </>
    );
  }
  const shown = rows.slice(0, limit);
  return (
    <>
      <PopHead title="Run Log" count={rows.length}>
        <label className="pulse-pop__toggle"><input type="checkbox" checked={errorsOnly} onChange={(e) => { setErrorsOnly(e.target.checked); setLimit(RUN_LOG_PAGE); }} /> Errors only</label>
      </PopHead>
      {shown.length ? (
        <ul className="pulse-pop__list">
          {shown.map((r) => (
            <li key={r.key}>
              <button type="button" className="pulse-pop__row" onClick={() => setSel(r.key)}>
                {r.kind === "missed" ? (
                  <>
                    <span className="pulse-pop__row-meta">
                      <b>{r.missed.label}</b>
                      <span className="pulse-faint">{ago(r.missed.at)}</span>
                      <span className="pulse-capture--warn">didn't finish</span>
                    </span>
                    <span className="pulse-pop__row-sum">Sent, never logged</span>
                  </>
                ) : (
                  <>
                    <span className="pulse-pop__row-meta">
                      <b>{label(r.run.run)}</b>
                      <span className="pulse-faint">{ago(r.run.finishedAt)}</span>
                      {r.run.errors.length ? (
                        <span className={fixedLater(r.run, runs) ? "pulse-faint" : "pulse-capture--warn"} title={r.run.errors.join("; ")}>
                          ⚠ {r.run.errors.length} error{r.run.errors.length > 1 ? "s" : ""}{fixedLater(r.run, runs) ? " · fixed by a later run" : ""}
                        </span>
                      ) : r.run.sources.length ? null : <span className="pulse-faint">no sources read</span>}
                    </span>
                    <span className="pulse-pop__row-sum">{inlineCode(r.run.summary)}</span>
                  </>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="pulse-pop__empty">{errorsOnly ? "No runs with errors." : "No runs logged yet."}</p>}
      {rows.length > limit ? (
        <button type="button" className="pulse-menu__item pulse-pop__more" onClick={() => setLimit((n) => n + RUN_LOG_PAGE)}>Show more ({rows.length - limit})</button>
      ) : null}
    </>
  );
}

/** Toolbar icon button with a hover/focus tooltip. */
function ExpandButton({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button type="button" className="pulse-xbtn" onClick={onClick} aria-label={label} data-tip={label}>
      <Icon name={icon} fallback="Check" className="pulse-xbtn__icon" aria-hidden />
    </button>
  );
}

/** Board items as the user should see them now: pending clicks applied, expired snoozes open. */
function useItems(snapshot: PulseSnapshot | null, overlay: Record<string, Partial<PulseItem>>): PulseItem[] {
  const now = Math.floor(Date.now() / 60_000);
  return useMemo(() => withOverlay(snapshot?.items ?? [], overlay).map((i) => effectiveItem(i)), [snapshot, overlay, now]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Rendered by bb on the right of the title bar (navPanel headerContent): capture status and Run now. */
function PulseHeader() {
  const { rpc, snapshot, overlay, mutate, call } = usePulse();
  const navigate = useBbNavigate();
  const [capturingSince, setCapturingSince] = useState<string | null>(null);
  const [runError, setRunError] = useState("");
  const items = useItems(snapshot, overlay);
  // A capture is finished when a run logs after we started it (or after 15 minutes, as a fallback).
  const last = snapshot ? latestRun(snapshot) : undefined;
  const capturing = !!capturingSince && !(last && last.finishedAt > capturingSince) && Date.now() - Date.parse(capturingSince) < 15 * 60_000;
  useEffect(() => { if (capturingSince && !capturing) setCapturingSince(null); }, [capturingSince, capturing]);
  useEffect(() => {
    if (!runError) return;
    const t = setTimeout(() => setRunError(""), 60_000);
    return () => clearTimeout(t);
  }, [runError]);
  const startRun = useCallback(async (name: RunName) => {
    setCapturingSince(new Date().toISOString());
    setRunError("");
    try {
      await rpc.call("pulse_run_now", { run: name });
    } catch (cause) {
      // Say why in the title bar (the page banner shows the same text).
      setCapturingSince(null);
      setRunError(errorText(cause));
      void call(Promise.reject(cause));
    }
  }, [rpc, call]);
  if (!snapshot) return null;
  const ready = boardSummary(items, null).ready;
  return (
    <div className="pulse-hdr">
      {ready ? (
        <button type="button" className="pulse-chip pulse-chip--ready pulse-chip--unread" onClick={() => window.dispatchEvent(new CustomEvent("pulse:show-ready"))}
          title="Show the first item an agent finished">
          {ready} ready to review
        </button>
      ) : null}
      <CaptureControl snapshot={snapshot} capturing={capturing} runError={runError}
        onCapture={() => void startRun("hourly")}
        onRun={(a) => void startRun(a.run as RunName)}
        onToggle={(a) => void mutate(rpc.call("pulse_set_run_enabled", { run: a.run as RunName, enabled: isPaused(a) }))}
        onOpenThread={(id) => navigate.toThread(id)} />
    </div>
  );
}

const ACTION_LABEL: Record<ItemAction, string> = { done: "Marked done", dismiss: "Dismissed", snooze: "Snoozed", reopen: "Reopened" };
type Undo = { label: string; items: { id: string; prev: "open" | "waiting" }[]; at: number };
const UNDO_MS = 6000;

const SHORTCUTS: [string, string][] = [
  ["j / k", "Next / previous item"], ["Enter", "Open the source"], ["i", "Show or hide details"], ["e", "Done"], ["s", "Snooze"],
  ["x", "Dismiss"], ["a", "Start or open the agent thread"], [".", "Quick actions"], ["z", "Undo"], ["?", "This list"],
];

function PulsePage() {
  const { rpc, snapshot, overlay, error, setError, setOverlay, mutate, call, retry } = usePulse();
  const navigate = useBbNavigate();
  const [filter, setFilter] = useState<"all" | Source>("all");
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [startingIds, setStartingIds] = useState<Set<string>>(new Set());
  const [undo, setUndo] = useState<Undo | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [shortcuts, setShortcuts] = useState(false);
  const board = useRef<HTMLDivElement>(null);

  // "New" markers compare against the last time the user looked; leaving the panel counts as looking.
  const lastViewedOnOpen = useRef<string | null | undefined>(undefined);
  if (snapshot && lastViewedOnOpen.current === undefined) lastViewedOnOpen.current = snapshot.lastViewedAt;
  useEffect(() => () => { void rpc.call("pulse_seen", null).catch(() => undefined); }, [rpc]);

  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), Math.max(0, undo.at + UNDO_MS - Date.now()));
    return () => clearTimeout(t);
  }, [undo]);

  const items = useItems(snapshot, overlay);

  /** Move the card at once; the server's snapshot replaces the guess, and a failure puts it back. */
  const act = useCallback(async (item: PulseItem, action: ItemAction, until?: string, { silent = false } = {}) => {
    const target = action === "reopen" ? "open" : action === "done" ? "done" : action === "dismiss" ? "dismissed" : "snoozed";
    setOverlay(item.id, { status: target as PulseItem["status"], snoozedUntil: action === "snooze" ? until ?? null : null });
    const ok = await mutate(rpc.call("pulse_action", until ? { id: item.id, action, until } : { id: item.id, action }));
    setOverlay(item.id, null);
    if (ok && !silent && action !== "reopen" && (item.status === "open" || item.status === "waiting")) {
      setUndo({ label: `${ACTION_LABEL[action]}: ${item.title}`, items: [{ id: item.id, prev: item.status }], at: Date.now() });
    }
    return ok;
  }, [rpc, mutate, setOverlay]);

  const doUndo = useCallback(async () => {
    if (!undo) return;
    setUndo(null);
    for (const { id, prev } of undo.items) {
      setOverlay(id, { status: prev, snoozedUntil: null });
      await mutate(rpc.call("pulse_action", { id, action: "reopen", restore: prev }));
      setOverlay(id, null);
    }
  }, [undo, rpc, mutate, setOverlay]);

  const startAction = useCallback(async (item: PulseItem) => {
    setStartingIds((s) => new Set(s).add(item.id));
    try {
      const res = (await call(rpc.call("pulse_start_action", { id: item.id }))) as { threadId: string; snapshot: PulseSnapshot } | null;
      if (res?.snapshot) accept(res.snapshot);
    } finally {
      setStartingIds((s) => { const n = new Set(s); n.delete(item.id); return n; });
    }
  }, [rpc, call]);

  const openAction = useCallback((item: PulseItem) => {
    if (!item.action) return;
    navigate.toThread(item.action.threadId);
    if (item.action.status !== "running" && !item.action.seenAt) void mutate(rpc.call("pulse_action_seen", { id: item.id }));
  }, [rpc, mutate, navigate]);

  const seenRef = lastViewedOnOpen.current ?? null;
  const { counts } = useMemo(() => boardSummary(items, seenRef), [items, seenRef]);
  const visible = filter === "all" ? items : items.filter((i) => i.source === filter);
  const buckets: Record<Horizon, PulseItem[]> = { now: [], next: [], later: [], info: [] };
  for (const i of visible) if (isActive(i)) buckets[horizonOf(i)].push(i);
  // Within Later, show actionable items first, then waiting, then snoozed.
  const laterRank = (i: PulseItem) => (i.status === "open" ? 0 : i.status === "waiting" ? 1 : 2);
  buckets.later.sort((a, b) => laterRank(a) - laterRank(b));
  const order = HORIZONS.flatMap((h) => buckets[h.key]);
  const closed = items.filter((i) => CLOSED_STATUSES.has(i.status)).sort((a, b) => (closedAt(b) > closedAt(a) ? 1 : -1));
  const problem = snapshot ? runProblem(snapshot) : null;
  const focusTarget = focusedId && order.some((i) => i.id === focusedId) ? focusedId : order[0]?.id ?? null;

  const focusRow = useCallback((id: string | null) => {
    setFocusedId(id);
    if (!id) return;
    requestAnimationFrame(() => board.current?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`)?.focus());
  }, []);

  // "N ready to review" in the title bar: bring the first finished item into view.
  useEffect(() => {
    const show = () => {
      const first = order.find((i) => i.action?.status === "ready" && !i.action.seenAt);
      if (!first) return;
      if (filter !== "all" && first.source !== filter) setFilter("all");
      focusRow(first.id);
      requestAnimationFrame(() => board.current?.querySelector(`[data-item-id="${CSS.escape(first.id)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
      setFlashId(first.id);
      setTimeout(() => setFlashId(null), 1600);
    };
    window.addEventListener("pulse:show-ready", show);
    return () => window.removeEventListener("pulse:show-ready", show);
  }, [order, filter, focusRow]);

  const clearFyis = useCallback(async (rows: PulseItem[]) => {
    const open = rows.filter((i) => i.status === "open");
    for (const i of open) setOverlay(i.id, { status: "dismissed" });
    await Promise.all(open.map((i) => mutate(rpc.call("pulse_action", { id: i.id, action: "dismiss" }))));
    for (const i of open) setOverlay(i.id, null);
    if (open.length) setUndo({ label: `Cleared ${open.length} FYI${open.length > 1 ? "s" : ""}`, items: open.map((i) => ({ id: i.id, prev: "open" as const })), at: Date.now() });
  }, [rpc, mutate, setOverlay]);

  /** Triage from the keyboard. Ignored while typing, inside a menu, or in a popover. */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, select, [contenteditable="true"], [role="menu"], .pulse-pop')) return;
    if (shortcuts && (e.key === "Escape" || e.key === "?")) { e.preventDefault(); setShortcuts(false); return; }
    const index = order.findIndex((i) => i.id === focusTarget);
    const cur = index >= 0 ? order[index] : undefined;
    const row = cur ? board.current?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(cur.id)}"]`) : null;
    const onRow = !!row && t === row;
    const neighbour = () => order[index + 1]?.id ?? order[index - 1]?.id ?? null;
    const actionable = cur && (cur.status === "open" || cur.status === "waiting");
    const press = (label: string) => row?.querySelector<HTMLElement>(`[aria-label="${label}"]`)?.click();
    let handled = true;
    switch (e.key) {
      case "j": case "ArrowDown": focusRow(order[Math.min(order.length - 1, index + 1)]?.id ?? null); break;
      case "k": case "ArrowUp": focusRow(order[Math.max(0, index - 1)]?.id ?? null); break;
      case "Enter": if (onRow) row?.querySelector<HTMLElement>(".pulse-item__title .pulse-link")?.click(); else handled = false; break;
      case "i": if (cur) setExpandedId((id) => (id === cur.id ? null : cur.id)); break;
      case "e": if (actionable) { const next = neighbour(); void act(cur, "done"); focusRow(next); } break;
      case "x": if (cur && cur.status !== "snoozed") { const next = neighbour(); void act(cur, "dismiss"); focusRow(next); } break;
      case "s": if (actionable) press("Snooze"); break;
      case ".": if (actionable) press("Quick actions"); break;
      case "a": if (actionable) { if (cur.action?.status === "running") openAction(cur); else void startAction(cur); } break;
      case "z": void doUndo(); break;
      case "?": setShortcuts(true); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  };

  const list = (rows: PulseItem[], compact = false) => (
    <ul className={`pulse-list${compact ? " pulse-list--compact" : ""}`}>
      {rows.map((i) => <ItemRow key={i.id} item={i} compact={compact} fresh={isNew(i, seenRef) && i.status !== "snoozed"}
        focused={focusTarget === i.id} expanded={expandedId === i.id} starting={startingIds.has(i.id)} flash={flashId === i.id}
        onFocus={() => setFocusedId(i.id)} onToggle={() => setExpandedId((id) => (id === i.id ? null : i.id))}
        onAction={(a, u) => void act(i, a, u)} onStartAction={() => void startAction(i)} onOpenAction={() => openAction(i)} />)}
    </ul>
  );

  // Nothing to do (and Pulse is set up): one line instead of four empty sections.
  const allClear = snapshot && !snapshot.needsProject && order.length === 0;
  const next = snapshot ? nextRun(snapshot.automations) : null;

  return (
    <div className="pulse" ref={board} onKeyDown={onKeyDown}>
      <div className="pulse__inner">
        <header className="pulse-top">
          <nav className="pulse-filters" aria-label="Filter by source">
            {FILTERS.filter((f) => f === "all" || counts[f] || filter === f).map((f) => (
              <button key={f} type="button" className={`pulse-filter${filter === f ? " pulse-filter--on" : ""}`} onClick={() => setFilter(f)} aria-pressed={filter === f}>
                {f === "all" ? "All" : SOURCE_LABEL[f]}
                {counts[f] ? <span className="pulse-filter__n">{counts[f]}</span> : null}
              </button>
            ))}
          </nav>
          {snapshot ? (
            <div className="pulse-top__actions">
              <ExpandButton icon="pulse-check-check" label="Mark all seen"
                onClick={() => { lastViewedOnOpen.current = new Date().toISOString(); void mutate(rpc.call("pulse_seen", null)); }} />
              <HeaderPopover icon="Clock" label={problem ? `Run Log (${problemText(problem)})` : "Run Log"} short="Run Log" warn={!!problem}>
                {(close) => <RunLogPopover snapshot={snapshot} onOpenThread={(id) => { close(); navigate.toThread(id); }} />}
              </HeaderPopover>
              <HeaderPopover icon="pulse-more" label="More actions" short="More">
                {(close) => <MoreMenu closed={closed} onReopen={(i) => void act(i, "reopen")} onShortcuts={() => { close(); setShortcuts(true); }} />}
              </HeaderPopover>
            </div>
          ) : null}
        </header>

        {undo ? (
          <div className="pulse-undo" role="status">
            <span className="pulse-undo__text">{undo.label}</span>
            <button type="button" className="pulse-link" onClick={() => void doUndo()}>Undo</button>
          </div>
        ) : null}

        {error ? (
          <div className="pulse-error" role="alert">
            {error}{" "}
            {snapshot
              ? <button type="button" className="pulse-link" onClick={() => setError("")}>Dismiss</button>
              : <button type="button" className="pulse-link" onClick={retry}>Retry</button>}
          </div>
        ) : null}

        {snapshot?.recovered ? (
          <div className="pulse-setup pulse-setup--warn" role="status">
            {snapshot.recovered.file.split("/").pop()} could not be read ({snapshot.recovered.error}), so Pulse is showing its last good copy. The next change repairs the file; <code className="pulse-code">pulse doctor</code> checks the store.
          </div>
        ) : null}

        {snapshot?.needsProject ? (
          <div className="pulse-setup" role="status">
            Pick a project in <b>Settings › Plugins › Pulse</b> (and say how agents reach Slack, Gmail and Calendar). Pulse creates its run threads there on the first run.
          </div>
        ) : snapshot?.projectSetLive ? (
          <div className="pulse-setup" role="status">
            Project set: runs work now. <b>bb plugin list</b> keeps showing "needs configuration" until the next <code className="pulse-code">bb plugin reload pulse</code>.
          </div>
        ) : null}

        {snapshot?.homePending ? (
          <div className="pulse-setup" role="status">
            The store directory setting changed. Pulse keeps using {snapshot.home} until you run <code className="pulse-code">bb plugin reload pulse</code>.
          </div>
        ) : null}

        {!snapshot ? <p className="pulse-empty">{error ? "Couldn't load the board yet; retrying…" : "Loading…"}</p> : null}

        {allClear ? (
          <div className="pulse-clear" role="status">
            <b>All clear</b>{next ? <span className="pulse-faint"> · next run {when(next)?.text}</span> : null}
          </div>
        ) : snapshot ? (
          <>
            {HORIZONS.map((h) => (
              <Section key={h.key} title={h.title} count={buckets[h.key].length} hint={h.hint} empty={h.empty} variant={h.key === "info" ? "info" : undefined}
                action={h.key === "info" && buckets.info.some((i) => i.status === "open")
                  ? <button type="button" className="pulse-link pulse-section__action" onClick={() => void clearFyis(buckets.info)}>Clear all</button>
                  : undefined}>
                {list(buckets[h.key], h.key === "info")}
              </Section>
            ))}
          </>
        ) : null}

        {shortcuts ? (
          <div className="pulse-shortcuts" role="dialog" aria-label="Keyboard shortcuts">
            <div className="pulse-pop__head"><h3>Keyboard shortcuts</h3><button type="button" className="pulse-link pulse-shortcuts__close" onClick={() => setShortcuts(false)}>Close</button></div>
            <dl>{SHORTCUTS.map(([k, v]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>)}</dl>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// Lucide "sparkles", "bot", "check-check", "triangle-alert" and "ellipsis-vertical" (ISC); bb's built-in set lacks them.
const svgIcon = (paths: string[]) => ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {paths.map((d) => <path key={d} d={d} />)}
  </svg>
);
const SparklesIcon = svgIcon([
  "M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z",
  "M20 3v4", "M22 5h-4", "M4 17v2", "M5 18H3",
]);
const BotIcon = svgIcon(["M12 8V4H8", "M2 14h2", "M20 14h2", "M15 13v2", "M9 13v2", "M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z"]);
const CheckCheckIcon = svgIcon(["M18 6 7 17l-5-5", "m22 10-7.5 7.5L13 16"]);
const MoreIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" />
  </svg>
);
const AlertIcon = svgIcon(["m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3", "M12 9v4", "M12 17h.01"]);

export default definePluginApp((app) => {
  app.experimental_icons.register({ name: "pulse-sparkles", component: SparklesIcon });
  app.experimental_icons.register({ name: "pulse-alert", component: AlertIcon });
  app.experimental_icons.register({ name: "pulse-bot", component: BotIcon });
  app.experimental_icons.register({ name: "pulse-check-check", component: CheckCheckIcon });
  app.experimental_icons.register({ name: "pulse-more", component: MoreIcon });
  app.slots.navPanel({
    id: "board",
    title: "Pulse",
    icon: "Activity",
    path: "board",
    component: PulsePage,
    headerContent: PulseHeader,
  });
});
