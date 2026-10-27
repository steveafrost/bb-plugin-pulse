// bb-plugin-pulse — panel frontend. Compiled by `bb plugin build`.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_Icon as Icon,
  UrlLink,
  useBbNavigate,
  useRealtime,
  useRpc,
  experimental_copyToClipboard,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { Automation, ItemAction, PulseHistoryEntry, PulseItem, PulseRun, PulseSnapshot, QuickAction, Source } from "./types";
import { horizonOf, type Horizon } from "./lib/horizon";
import { runEffects } from "./lib/run-effects";
import "./app.css";

const SOURCE_LABEL: Record<Source, string> = { slack: "Slack", gmail: "Email", calendar: "Calendar", github: "GitHub", docs: "Docs", other: "Other" };
const KIND_LABEL: Record<string, string> = {
  reply: "Reply", decision: "Decision", rsvp: "RSVP", conflict: "Conflict", deadline: "Deadline", review: "Review", followup: "Follow-up", fyi: "FYI",
};
const FILTERS: ("all" | Source)[] = ["all", "slack", "gmail", "calendar", "docs", "github", "other"];

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

function snoozeOptions(): { label: string; until: string }[] {
  const now = new Date();
  const inHours = (h: number) => new Date(now.getTime() + h * 3_600_000);
  const at = (dayOffset: number, hour: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(hour, 0, 0, 0);
    return d;
  };
  const nextMonday = (() => {
    const d = at(1, 9);
    while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
    return d;
  })();
  const opts = [
    { label: "1 hour", until: inHours(1) },
    { label: "3 hours", until: inHours(3) },
    { label: "Tomorrow 9 AM", until: at(1, 9) },
    { label: "Monday 9 AM", until: nextMonday },
  ];
  return opts.map((o) => ({ label: o.label, until: o.until.toISOString() }));
}

/** Only web links reach an href; items written before 0.1.11 were not checked. */
function webUrl(url: string | null | undefined): string | undefined {
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : undefined;
}

const isPaused = (a: Automation) => a.paused ?? a.enabled === false;

function inlineCode(text: string): React.ReactNode[] {
  return text.split(/(`[^`]+`)/g).map((part, i) =>
    part.length > 2 && part.startsWith("`") && part.endsWith("`") ? <code key={i} className="pulse-code">{part.slice(1, -1)}</code> : part,
  );
}

function isNew(item: PulseItem, lastViewedAt: string | null): boolean {
  if (!lastViewedAt) return true;
  return item.lastChangedBy !== "user" && item.updatedAt > lastViewedAt;
}

function usePulse() {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<PulseSnapshot | null>(null);
  const [error, setError] = useState("");
  const call = useCallback(async <T,>(promise: Promise<T>): Promise<T | null> => {
    try {
      const result = await promise;
      setError("");
      return result;
    } catch (cause) {
      setError(errorText(cause));
      return null;
    }
  }, []);
  const refetch = useCallback(() => {
    void call(rpc.call("pulse_snapshot", null) as Promise<PulseSnapshot>).then((next) => next && setSnapshot(next));
  }, [rpc, call]);
  useEffect(refetch, [refetch]);
  useRealtime("pulse-changed", refetch);
  // Re-render relative times and expired snoozes every minute.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  const mutate = useCallback(async (promise: Promise<unknown>) => {
    const next = (await call(promise)) as PulseSnapshot | null;
    if (next && Array.isArray(next.items)) setSnapshot(next);
  }, [call]);
  return { rpc, snapshot, setSnapshot, error, setError, mutate, call };
}

function IconButton({ icon, label, title, primary = false, onClick, ...aria }: {
  icon: string; label: string; title?: string; primary?: boolean; onClick: () => void;
  "aria-haspopup"?: "menu"; "aria-expanded"?: boolean;
}) {
  return (
    <button type="button" className={`pulse-icon-btn${primary ? " pulse-icon-btn--primary" : ""}`} onClick={onClick} aria-label={label} data-tip={aria["aria-expanded"] ? undefined : (title ?? label)} {...aria}>
      <Icon name={icon} fallback="Circle" className="pulse-icon" aria-hidden />
    </button>
  );
}

function SnoozeMenu({ onPick }: { onPick: (until: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className="pulse-menu" ref={ref}>
      <IconButton icon="Clock" label="Snooze" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} />
      {open ? (
        <div className="pulse-menu__list" role="menu">
          {snoozeOptions().map((o) => (
            <button key={o.label} type="button" role="menuitem" className="pulse-menu__item" onClick={() => { setOpen(false); onPick(o.until); }}>
              {o.label}
            </button>
          ))}
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
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
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
    setOpen(false);
    if (a.text) void experimental_copyToClipboard({ text: a.text }).then((ok) => { if (ok) setCopied(a.label); });
  };
  return (
    <div className="pulse-menu" ref={ref}>
      <button type="button" className={`pulse-icon-btn${copied ? " pulse-icon-btn--done" : ""}`} onClick={() => setOpen((v) => !v)}
        aria-label="Quick actions" aria-haspopup="menu" aria-expanded={open}
        data-tip={open ? undefined : copied ? `Copied for \u201c${copied}\u201d. Paste and send` : "Quick actions"}>
        <Icon name={copied ? "Check" : "pulse-sparkles"} fallback="Circle" className="pulse-icon" aria-hidden />
      </button>
      {open ? (
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

function ItemRow({ item, fresh, compact = false, onAction, onStartAction, onOpenAction }: {
  item: PulseItem; fresh: boolean; compact?: boolean;
  onAction: (action: ItemAction, until?: string) => void;
  onStartAction: () => void;
  onOpenAction: () => void;
}) {
  const due = when(item.due);
  const running = item.action?.status === "running";
  const closed = item.status === "done" || item.status === "dismissed" || item.status === "resolved";
  return (
    <li className={`pulse-item pulse-item--${item.status}${item.priority === "high" ? " pulse-item--high" : ""}${fresh ? " pulse-item--fresh" : ""}`}
      aria-label={fresh ? `New: ${item.title}` : undefined}>
      <div className="pulse-item__body">
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
          {item.pending?.length ? <span className="pulse-tag pulse-tag--pending" data-tip="Queued for Pulse on the iPhone">Sent to iPhone</span> : null}
          <ActionChip item={item} onOpen={onOpenAction} />
          {closed ? <span className="pulse-faint">{item.status === "resolved" ? "Resolved" : item.status === "done" ? "Done" : "Dismissed"} {ago(item.resolvedAt ?? item.updatedAt)}{item.resolution ? ` · ${item.resolution}` : ""}</span> : <span className="pulse-faint">seen {ago(item.firstSeenAt)}</span>}
        </div>
      </div>
      <div className="pulse-item__actions">
        {item.status === "open" || item.status === "waiting" ? (
          <>
            <QuickMenu item={item} />
            {running
              ? <IconButton icon="ExternalLink" label="Open thread" title="Open thread: an agent is working on this" onClick={onOpenAction} />
              : <IconButton icon="pulse-bot" label="Start agent thread"
                  title={`${item.action ? "Start a new agent thread" : "Start agent thread"}${item.agentSkills?.length ? ` \u00b7 skills: ${item.agentSkills.join(", ")}` : ""}`}
                  onClick={onStartAction} />}
            <IconButton icon="Check" label="Done" primary onClick={() => onAction("done")} />
            <SnoozeMenu onPick={(until) => onAction("snooze", until)} />
            <IconButton icon="X" label="Dismiss" title="Dismiss: not mine / not relevant" onClick={() => onAction("dismiss")} />
          </>
        ) : (
          <IconButton icon="RotateCcw" label="Reopen" onClick={() => onAction("reopen")} />
        )}
      </div>
    </li>
  );
}

function Section({ title, count, children, collapsible = false, defaultOpen = true, hint, variant }: {
  title: string; count?: number; children: React.ReactNode; collapsible?: boolean; defaultOpen?: boolean; hint?: string; variant?: "info";
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`pulse-section${collapsible ? " pulse-section--minor" : ""}${variant ? ` pulse-section--${variant}` : ""}`}>
      <header className="pulse-section__head">
        {collapsible ? (
          <button type="button" className="pulse-section__toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            <span className={`pulse-caret${open ? " pulse-caret--open" : ""}`}>›</span>
            <h2>{title}</h2>
          </button>
        ) : (
          <h2>{title}</h2>
        )}
        {count !== undefined ? <span className="pulse-count">{count}</span> : null}
        {hint ? <span className="pulse-faint pulse-section__hint">{hint}</span> : null}
      </header>
      {open ? children : null}
    </section>
  );
}

const HORIZONS: { key: Horizon; title: string; hint: string; empty: string }[] = [
  { key: "now", title: "Now", hint: "High priority or due today", empty: "Nothing urgent." },
  { key: "next", title: "Next", hint: "Due in the next three days", empty: "Nothing queued." },
  { key: "later", title: "Later", hint: "Further out, waiting on others or snoozed", empty: "Nothing parked." },
  { key: "info", title: "Nice to Know", hint: "FYIs, no action needed", empty: "No FYIs." },
];

function latestRun(snapshot: PulseSnapshot): PulseRun | undefined {
  return Object.values(snapshot.lastRuns).sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : -1))[0];
}

/** Last updated + Run now + a menu holding the individual runs (Pulse's own schedules). */
function CaptureControl({ snapshot, capturing, onCapture, onRun, onToggle, onOpenThread }: {
  snapshot: PulseSnapshot;
  capturing: boolean;
  onCapture: () => void;
  onRun: (a: Automation) => void;
  onToggle: (a: Automation) => void;
  onOpenThread: (threadId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  const last = latestRun(snapshot);
  const warn = Object.values(snapshot.lastRuns).some((r) => r.errors.length > 0);
  // With capture on the iPhone there are no Mac schedules to run, so the button
  // would only ever fail; the snapshot's timestamp says how fresh the board is.
  const onMac = snapshot.automations.some((a) => a.schedule);
  const synced = snapshot.mirror.generatedAt;
  return (
    <div className="pulse-capture" ref={ref}>
      <span className={`pulse-faint pulse-capture__when${capturing ? " pulse-capture__when--busy" : ""}${warn ? " pulse-capture--warn" : ""}`} title={last ? `${last.run}: ${last.summary}` : undefined}>
        {capturing ? "Updating…" : synced ? `Synced ${ago(synced)}${snapshot.mirror.deviceName ? ` from ${snapshot.mirror.deviceName}` : ""}${onMac && last ? ` · ran ${ago(last.finishedAt)}` : ""}` : "Not synced yet"}
      </span>
      <div className="pulse-split">
        <button type="button" className="pulse-btn pulse-split__main" onClick={onCapture} disabled={capturing || !onMac}
          data-tip={onMac ? "Capture the latest from Slack, Email and Calendar" : "Pulse captures on the iPhone"}>
          {capturing ? "Running…" : "Run now"}
        </button>
        <button type="button" className="pulse-btn pulse-split__more" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} aria-label="Pulse runs" data-tip={open ? undefined : "All Pulse runs"}>
          ▾
        </button>
      </div>
      {open ? (
        <div className="pulse-menu__list pulse-runs-menu" role="menu">
          {snapshot.automations.map((a) => {
            const r = snapshot.lastRuns[a.run];
            const next = when(a.nextRunAt);
            return (
              <div key={a.run} className="pulse-runs-menu__row">
                <button type="button" role="menuitem" className="pulse-menu__item pulse-runs-menu__main" onClick={() => { setOpen(false); if (a.threadId) onOpenThread(a.threadId); }} disabled={!a.threadId} title={a.threadId ? "Open this run's thread" : "The thread is created on the first run"}>
                  <span className="pulse-runs-menu__name">{a.label}{r?.errors.length ? <span className="pulse-capture--warn"> · errors</span> : null}</span>
                  <span className="pulse-faint pulse-runs-menu__meta">
                    {r ? `ran ${ago(r.finishedAt)}` : "no runs yet"}
                    {a.pendingReload ? " · reload the plugin to apply the new schedule" : !a.schedule ? " · off" : isPaused(a) ? " · paused" : next ? ` · next ${next.text}` : ""}
                  </span>
                </button>
                {a.pendingReload || !a.schedule ? null : (
                  <button type="button" role="menuitem" className="pulse-btn pulse-btn--small pulse-btn--quiet" onClick={() => onToggle(a)}
                    data-tip={isPaused(a) ? `Resume the ${a.label.toLowerCase()} schedule` : `Pause the ${a.label.toLowerCase()} schedule`}>
                    {isPaused(a) ? "Resume" : "Pause"}
                  </button>
                )}
                <button type="button" role="menuitem" className="pulse-btn pulse-btn--small" onClick={() => { setOpen(false); onRun(a); }}>Run</button>
              </div>
            );
          })}
          {snapshot.parentThreadId ? (
            <>
              <div className="pulse-menu__sep" />
              <button type="button" role="menuitem" className="pulse-menu__item" onClick={() => { setOpen(false); onOpenThread(snapshot.parentThreadId!); }}>Open Pulse thread</button>
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

/** Toolbar icon button (tooltip on hover) that opens an anchored popover; Esc and outside click close it. */
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
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", esc, true); };
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

function PopHead({ title, count, onBack }: { title: string; count?: number; onBack?: () => void }) {
  return (
    <div className="pulse-pop__head">
      {onBack ? <button type="button" className="pulse-pop__back" onClick={onBack} aria-label="Back to list" data-tip="Back" data-tip-start="">‹</button> : null}
      <h3>{title}</h3>
      {count !== undefined ? <span className="pulse-count">{count}</span> : null}
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

/** Kebab "More actions" menu; secondary views (Closed) open in place with a back arrow to the menu. */
function MoreMenu({ closed, onReopen }: { closed: PulseItem[]; onReopen: (i: PulseItem) => void }) {
  const [view, setView] = useState<"menu" | "closed">("menu");
  if (view === "closed") return <ClosedPopover items={closed} onReopen={onReopen} onBack={() => setView("menu")} />;
  return (
    <div className="pulse-more-menu">
      <button type="button" className="pulse-menu__item pulse-more-menu__item" onClick={() => setView("closed")}>
        <Icon name="CircleCheck" fallback="Check" className="pulse-more-menu__icon" aria-hidden />
        <span>Closed</span>
        <span className="pulse-faint pulse-more-menu__n">{closed.length}</span>
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

function RunLogPopover({ snapshot, onOpenThread }: { snapshot: PulseSnapshot; onOpenThread: (id: string) => void }) {
  const [sel, setSel] = useState<string | null>(null);
  const runs = snapshot.recentRuns;
  const label = (r: PulseRun) => snapshot.automations.find((a) => a.run === r.run)?.label ?? r.run;
  const key = (r: PulseRun) => `${r.run}-${r.finishedAt}`;
  const run = sel ? runs.find((r) => key(r) === sel) : undefined;
  if (run) {
    const { added, resolved } = runEffects(run, runs, snapshot.items);
    const itemList = (title: string, rows: PulseItem[]) => rows.length ? (
      <div className="pulse-pop__block">
        <div className="pulse-pop__label">{title} <span className="pulse-faint">{rows.length}</span></div>
        <ul className="pulse-pop__bullets">{rows.map((i) => <li key={i.id}>{inlineCode(i.title)}</li>)}</ul>
      </div>
    ) : null;
    return (
      <>
        <PopHead title={label(run)} onBack={() => setSel(null)} />
        <div className="pulse-pop__detail">
          <div className="pulse-faint">{run.startedAt ? `${fullTime(run.startedAt)} → ` : ""}{fullTime(run.finishedAt)}</div>
          <p className="pulse-pop__text">{inlineCode(run.summary)}</p>
          {run.sources.length ? (
            <div className="pulse-item__meta">
              {run.sources.map((s) => <span key={s} className={`pulse-tag pulse-tag--${s}`}>{SOURCE_LABEL[s as Source] ?? s}</span>)}
            </div>
          ) : null}
          {run.errors.length ? (
            <div className="pulse-pop__block">
              <div className="pulse-pop__label pulse-capture--warn">Errors</div>
              <ul className="pulse-pop__bullets pulse-capture--warn">{run.errors.map((e, n) => <li key={n}>{e}</li>)}</ul>
            </div>
          ) : null}
          {itemList("Added", added)}
          {itemList("Resolved", resolved)}
          {run.thread ? (
            <div className="pulse-pop__actions">
              <button type="button" className="pulse-btn" onClick={() => onOpenThread(run.thread!)}>Open run thread</button>
            </div>
          ) : null}
        </div>
      </>
    );
  }
  return (
    <>
      <PopHead title="Run Log" count={runs.length} />
      {runs.length ? (
        <ul className="pulse-pop__list">
          {runs.map((r) => (
            <li key={key(r)}>
              <button type="button" className="pulse-pop__row" onClick={() => setSel(key(r))}>
                <span className="pulse-pop__row-meta">
                  <b>{label(r)}</b>
                  <span className="pulse-faint">{ago(r.finishedAt)}</span>
                  {r.errors.length ? <span className="pulse-capture--warn" title={r.errors.join("; ")}>⚠ {r.errors.length} error{r.errors.length > 1 ? "s" : ""}</span> : null}
                </span>
                <span className="pulse-pop__row-sum">{inlineCode(r.summary)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="pulse-pop__empty">No runs logged yet.</p>}
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

function boardSummary(items: PulseItem[], seenRef: string | null) {
  const counts: Record<string, number> = { all: 0 };
  for (const i of items) if (i.status === "open" || i.status === "waiting") { counts.all++; counts[i.source] = (counts[i.source] ?? 0) + 1; }
  return {
    counts,
    fresh: items.filter((i) => (i.status === "open" || i.status === "waiting") && isNew(i, seenRef)).length,
    // Closed items render no action chip, so their unread action could never be cleared.
    ready: items.filter((i) => (i.status === "open" || i.status === "waiting" || i.status === "snoozed") && i.action?.status === "ready" && !i.action.seenAt).length,
    working: items.filter((i) => i.action?.status === "running").length,
  };
}

/** Rendered by bb on the right of the title bar (navPanel headerContent): capture status and Run now. */
function PulseHeader() {
  const { rpc, snapshot, setSnapshot, call } = usePulse();
  const navigate = useBbNavigate();
  const [capturingSince, setCapturingSince] = useState<string | null>(null);
  // A capture is finished when a run logs after we started it (or after 15 minutes, as a fallback).
  const last = snapshot ? latestRun(snapshot) : undefined;
  const capturing = !!capturingSince && !(last && last.finishedAt > capturingSince) && Date.now() - Date.parse(capturingSince) < 15 * 60_000;
  useEffect(() => { if (capturingSince && !capturing) setCapturingSince(null); }, [capturingSince, capturing]);
  const startRun = useCallback(async (name: "hourly" | "daily" | "weekly") => {
    setCapturingSince(new Date().toISOString());
    const res = await call(rpc.call("pulse_run_now", { run: name }));
    if (!res) setCapturingSince(null);
  }, [rpc, call]);
  if (!snapshot) return null;
  const ready = boardSummary(snapshot.items, null).ready;
  return (
    <div className="pulse-hdr">
      {ready ? <span className="pulse-chip pulse-chip--ready pulse-chip--unread pulse-chip--static">{ready} ready to review</span> : null}
      <CaptureControl snapshot={snapshot} capturing={capturing}
        onCapture={() => void startRun("hourly")}
        onRun={(a) => void startRun(a.run as "hourly" | "daily" | "weekly")}
        onToggle={(a) => void call(rpc.call("pulse_set_run_enabled", { run: a.run as "hourly" | "daily" | "weekly", enabled: isPaused(a) }) as Promise<PulseSnapshot>).then((next) => next && setSnapshot(next))}
        onOpenThread={(id) => navigate.toThread(id)} />
    </div>
  );
}

function PulsePage() {
  const { rpc, snapshot, setSnapshot, error, setError, mutate, call } = usePulse();
  const navigate = useBbNavigate();
  const [filter, setFilter] = useState<"all" | Source>("all");

  // "New" markers compare against the last time the user looked; leaving the panel counts as looking.
  const lastViewedOnOpen = useRef<string | null | undefined>(undefined);
  if (snapshot && lastViewedOnOpen.current === undefined) lastViewedOnOpen.current = snapshot.lastViewedAt;
  useEffect(() => () => { void rpc.call("pulse_seen", null).catch(() => undefined); }, [rpc]);

  const act = useCallback((item: PulseItem, action: ItemAction, until?: string) => {
    void mutate(rpc.call("pulse_action", until ? { id: item.id, action, until } : { id: item.id, action }));
  }, [rpc, mutate]);

  const startAction = useCallback(async (item: PulseItem) => {
    const res = (await call(rpc.call("pulse_start_action", { id: item.id }))) as { threadId: string; snapshot: PulseSnapshot } | null;
    if (res?.snapshot && Array.isArray(res.snapshot.items)) setSnapshot(res.snapshot);
  }, [rpc, call, setSnapshot]);

  const openAction = useCallback((item: PulseItem) => {
    if (!item.action) return;
    navigate.toThread(item.action.threadId);
    if (item.action.status !== "running" && !item.action.seenAt) void mutate(rpc.call("pulse_action_seen", { id: item.id }));
  }, [rpc, mutate, navigate]);

  const items = snapshot?.items ?? [];
  const isActive = (i: PulseItem) => i.status === "open" || i.status === "waiting" || i.status === "snoozed";
  const seenRef = lastViewedOnOpen.current ?? null;
  const { counts } = useMemo(() => boardSummary(items, seenRef), [items, seenRef]);
  const visible = filter === "all" ? items : items.filter((i) => i.source === filter);
  // Buckets come from lib/horizon.ts, the port of PulseCore's HorizonDerivation,
  // so the Mac board and the iPhone board place an item in the same section.
  const buckets: Record<Horizon, PulseItem[]> = { now: [], next: [], later: [], info: [] };
  for (const i of visible) {
    if (!isActive(i)) continue;
    const bucket = horizonOf(i);
    if (bucket) buckets[bucket].push(i);
  }
  // Within Later, show actionable items first, then waiting, then snoozed.
  const laterRank = (i: PulseItem) => (i.status === "open" ? 0 : i.status === "waiting" ? 1 : 2);
  buckets.later.sort((a, b) => laterRank(a) - laterRank(b));
  const closed = items.filter((i) => CLOSED_STATUSES.has(i.status)).sort((a, b) => (closedAt(b) > closedAt(a) ? 1 : -1));
  const runErrors = snapshot ? Object.values(snapshot.lastRuns).some((r) => r.errors.length > 0) : false;

  const list = (rows: PulseItem[], compact = false) => (
    <ul className={`pulse-list${compact ? " pulse-list--compact" : ""}`}>
      {rows.map((i) => <ItemRow key={i.id} item={i} compact={compact} fresh={isNew(i, seenRef) && i.status !== "snoozed"} onAction={(a, u) => act(i, a, u)}
        onStartAction={() => void startAction(i)} onOpenAction={() => openAction(i)} />)}
    </ul>
  );

  return (
    <div className="pulse">
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
              <HeaderPopover icon="Clock" label={runErrors ? "Run Log (latest run had errors)" : "Run Log"} short="Run Log" warn={runErrors}>
                {(close) => <RunLogPopover snapshot={snapshot} onOpenThread={(id) => { close(); navigate.toThread(id); }} />}
              </HeaderPopover>
              <HeaderPopover icon="pulse-more" label="More actions" short="More">
                {() => <MoreMenu closed={closed} onReopen={(i) => act(i, "reopen")} />}
              </HeaderPopover>
            </div>
          ) : null}
        </header>

        {error ? (
          <div className="pulse-error" role="alert">
            {error} <button type="button" className="pulse-link" onClick={() => setError("")}>Dismiss</button>
          </div>
        ) : null}

        {snapshot && snapshot.mirror.state !== "connected" ? (
          <div className={`pulse-mirror pulse-mirror--${snapshot.mirror.state}`} role="status">
            <b>{snapshot.mirror.state === "not-connected" ? "Not connected to Pulse on the iPhone" : snapshot.mirror.state === "update" ? "Pulse needs a newer plugin" : "Can't read the Pulse snapshot"}</b>
            <span>{snapshot.mirror.message ?? snapshot.mirror.dir}</span>
          </div>
        ) : null}

        {snapshot && snapshot.mirror.pendingCount > 0 ? (
          <div className="pulse-mirror pulse-mirror--pending" role="status">
            {snapshot.mirror.pendingCount} change{snapshot.mirror.pendingCount === 1 ? "" : "s"} waiting for the iPhone
          </div>
        ) : null}

        {snapshot?.needsProject ? (
          <div className="pulse-setup" role="status">
            Pick a project in <b>Settings › Plugins › Pulse</b> (and say how agents reach Slack, Gmail and Calendar), then reload the plugin. Pulse creates agent threads there, and its run threads too while capture runs on this Mac.
          </div>
        ) : null}

        {!snapshot ? <p className="pulse-empty">Loading…</p> : null}

        {snapshot ? (
          <>
            {HORIZONS.map((h) => (
              <Section key={h.key} title={h.title} count={buckets[h.key].length} hint={h.hint} variant={h.key === "info" ? "info" : undefined}>
                {buckets[h.key].length ? list(buckets[h.key], h.key === "info") : <p className="pulse-empty">{h.empty}</p>}
              </Section>
            ))}
          </>
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
