// @jsxRuntime automatic
// @jsxImportSource react
//
// Those two pragmas pin the automatic JSX runtime for this file. It lives in
// components/, which the plugin tsconfig's `include` does not list, so some tools
// that read tsconfig per file (tsx, bb plugin build) would otherwise fall back to
// the classic runtime and fail with "React is not defined". Adding "components" to
// that `include` makes them redundant.
// The Task integration section of Pulse settings.
//
// Pulse keeps these three options in its own kv row (lib/task-settings.ts), not in
// bb plugin settings: the native settings page shows every descriptor it is given,
// and this section hides two of the three until the master switch is on. The server
// adds `tasksPluginEnabled` to every reply, so the section can explain what to
// install without Pulse calling the Tasks plugin itself.
//
// Type-only import: the app bundle carries no server code.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { TaskConfig, TaskSettingsState, taskSettingsContract } from "../lib/task-settings";
import "../task-settings.css";

/** Refresh registry metadata while this section remains open. */
const REFRESH_MS = 30_000;

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

type RowProps = { label: string; description: string; checked: boolean; disabled: boolean; onChange: () => void };

/** A native-looking settings row: label and description on the left, the control on the right. */
function SwitchRow({ label, description, checked, disabled, onChange }: RowProps) {
  const id = useId();
  const descriptionId = `${id}-description`;
  return (
    <div className="task-settings__row">
      <div className="task-settings__text">
        <label className="task-settings__label" htmlFor={id}>{label}</label>
        <p className="task-settings__description" id={descriptionId}>{description}</p>
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={descriptionId}
        className={`task-settings__switch${checked ? " task-settings__switch--on" : ""}`}
        disabled={disabled}
        onClick={onChange}
      >
        <span className="task-settings__thumb" aria-hidden="true" />
      </button>
    </div>
  );
}

export function TaskIntegrationSettings() {
  const rpc = useRpc<typeof taskSettingsContract>();
  const [state, setState] = useState<TaskSettingsState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const mounted = useRef(true);
  /** Newest load wins: a slower earlier reply never replaces a newer one. */
  const loadSeq = useRef(0);
  /** Writes in flight. A load that started before a write must not put the old value back. */
  const writes = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const next = await rpc.call("pulse_task_settings", null);
      if (!mounted.current || seq !== loadSeq.current || writes.current > 0) return;
      setState(next);
      setLoadError("");
    } catch (cause) {
      if (!mounted.current || seq !== loadSeq.current) return;
      // Keep whatever is on screen; say the refresh failed.
      setLoadError(errorText(cause));
    }
  }, [rpc]);

  // First read, then every 30 seconds: the Tasks plugin can be installed or turned
  // off in another window while this section stays open.
  useEffect(() => {
    void load();
    const timer = setInterval(() => { void load(); }, REFRESH_MS);
    return () => { clearInterval(timer); };
  }, [load]);

  useRealtime("pulse-changed", () => { void load(); });

  const save = useCallback(async (patch: Partial<TaskConfig>) => {
    // The controls are disabled during a write; a stray click must not race one.
    if (writes.current > 0) return;
    writes.current += 1;
    loadSeq.current += 1; // any load already in flight is now stale
    setSaving(true);
    setSaveError("");
    try {
      const next = await rpc.call("pulse_task_settings_update", patch);
      if (mounted.current) setState(next);
    } catch (cause) {
      // The values on screen are the last ones the server confirmed: leave them alone.
      if (mounted.current) setSaveError(errorText(cause));
    } finally {
      writes.current -= 1;
      if (mounted.current) setSaving(false);
    }
  }, [rpc]);

  return (
    <div className="task-settings" aria-busy={saving}>
      {state === null ? (
        <p className="task-settings__status" role="status">
          {loadError ? `Task settings could not be loaded: ${loadError}` : "Loading Task settings…"}
        </p>
      ) : null}

      {state && !state.tasksPluginEnabled ? (
        <p className="task-settings__guide">
          Install and enable Tasks to use Task integration. The controls appear when Tasks is installed and enabled.
        </p>
      ) : null}

      {state && !state.tasksPluginEnabled && state.enabled ? (
        <button type="button" disabled={saving} onClick={() => { void save({ enabled: false }); }}>Disable Task integration</button>
      ) : null}

      {state && state.tasksPluginEnabled ? (
        <>
          <SwitchRow
            label="Enable Task integration"
            description="Work with Tasks from Pulse items. Turning it off keeps existing task links and the options below exactly as they are."
            checked={state.enabled}
            disabled={saving}
            onChange={() => { void save({ enabled: !state.enabled }); }}
          />
          {state.enabled ? (
            <>
              <SwitchRow
                label="Use AI for task recommendations"
                description="When you open Quick actions, send redacted item text and task summaries to the Jev plugin."
                checked={state.taskAiRecommendations}
                disabled={saving}
                onChange={() => { void save({ taskAiRecommendations: !state.taskAiRecommendations }); }}
              />
              <SwitchRow
                label="Close Pulse items when all linked tasks are done"
                description="Checks about every two minutes after the last check. Reopened items stay open until a linked task becomes incomplete and is done again."
                checked={state.closeOnTasksDone}
                disabled={saving}
                onChange={() => { void save({ closeOnTasksDone: !state.closeOnTasksDone }); }}
              />
            </>
          ) : null}
        </>
      ) : null}

      {saveError ? <p className="task-settings__error" role="alert">Settings were not saved: {saveError}</p> : null}
      {loadError && state ? (
        <p className="task-settings__error" role="status">Showing the last known settings: {loadError}</p>
      ) : null}
    </div>
  );
}
