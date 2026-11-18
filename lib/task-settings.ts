/**
 * Pulse's Task configuration.
 *
 * These three options live in one plugin kv row, not in bb plugin settings: Pulse
 * needs a master switch that hides the other two, and the native settings page
 * renders every descriptor it is given. The two settings the Task work used to
 * read (`taskAiRecommendations`, `closeOnTasksDone`) are retired keys; nothing
 * here reads them, so an orphaned native row can never come back to life.
 *
 * The store owns the row and nothing else. Whether the Tasks plugin is installed
 * and enabled, the registry metadata, and gating Task RPCs on `enabled` belong to
 * the server; it calls this store and adds `tasksPluginEnabled` to the reply.
 */
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** The single kv row that holds every Task option. */
export const TASK_SETTINGS_KEY = "taskIntegration";

export const taskConfigSchema = z
  .object({
    /** Master switch. Off means Pulse does no Task work at all, whatever the options below say. */
    enabled: z.boolean(),
    /** Send redacted item text and task summaries to the Jev plugin. */
    taskAiRecommendations: z.boolean(),
    /** Close an item once every linked task is done. */
    closeOnTasksDone: z.boolean(),
  })
  .strict();
export type TaskConfig = z.infer<typeof taskConfigSchema>;

/** A fresh install starts with the integration off; the options below are off too. */
export const TASK_CONFIG_DEFAULTS: TaskConfig = { enabled: false, taskAiRecommendations: false, closeOnTasksDone: false };

/**
 * What a write may carry: any subset of the options, nothing else. Strict, so a
 * retired or invented key is refused instead of quietly stored.
 */
export const taskConfigPatchSchema = taskConfigSchema.partial().strict();
export type TaskConfigPatch = z.infer<typeof taskConfigPatchSchema>;

/** Settings plus Tasks registry membership and enablement, independent of operational RPC health. */
export const taskSettingsStateSchema = taskConfigSchema.extend({ tasksPluginEnabled: z.boolean() }).strict();
export type TaskSettingsState = z.infer<typeof taskSettingsStateSchema>;

export const taskSettingsContract = defineRpcContract({
  pulse_task_settings: {
    input: z.null(),
    output: taskSettingsStateSchema,
    experimental_description:
      "Read Pulse's Task integration options (enabled, taskAiRecommendations, closeOnTasksDone) and whether the Tasks plugin is installed and enabled.",
  },
  pulse_task_settings_update: {
    input: taskConfigPatchSchema,
    output: taskSettingsStateSchema,
    experimental_description:
      "Change one or more Pulse Task integration options. Omitted options keep their stored value, so turning the integration off never unsets the others.",
  },
});

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Task settings for one Pulse plugin lifetime: a cached view over one kv row.
 *
 * Async because it loads the row before it returns. Gating reads `get()` from the
 * first snapshot on, so a stored `enabled: true` must be live at load, not after
 * the first write or recommendation. Loading fires no listener: nothing has
 * changed, and the caller's listener may not exist yet.
 */
export async function createTaskSettings({ bb, onChange }: { bb: BbPluginApi; onChange: (next: TaskConfig, prev: TaskConfig) => void }) {
  let cached: TaskConfig = { ...TASK_CONFIG_DEFAULTS };
  // Reads and writes queue behind one tail. A patch therefore merges over the newest
  // committed row, and a read that starts while a write is pending returns that write's
  // value instead of the row the write is about to replace.
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  const clone = (config: TaskConfig): TaskConfig => ({ ...config });
  /** A missing, hand-edited or half-written row reads as the defaults, never as a throw. */
  const parse = (raw: unknown): TaskConfig => {
    const parsed = taskConfigSchema.safeParse(raw ?? TASK_CONFIG_DEFAULTS);
    return parsed.success ? parsed.data : { ...TASK_CONFIG_DEFAULTS };
  };

  const settings = {
    /** The last known value, without touching the kv row. Safe in a hot path. */
    get(): TaskConfig {
      return clone(cached);
    },
    /**
     * Read committed configuration. On storage failure, retain the last known
     * value so optional Task settings do not break capture.
     */
    read(): Promise<TaskConfig> {
      return serialize(async () => {
        let raw: unknown;
        try {
          raw = await bb.storage.kv.get(TASK_SETTINGS_KEY);
        } catch (error) {
          bb.log.warn(`Task settings could not be read; keeping the last known configuration: ${message(error)}`);
          return clone(cached);
        }
        cached = parse(raw);
        return clone(cached);
      });
    },
    /**
     * Merge a patch over the committed row, store it, then publish it. The cache
     * changes after the kv write resolves, so a failed write leaves the old value
     * readable and reaches no listener.
     */
    async update(patch: TaskConfigPatch): Promise<TaskConfig> {
      // Refuse bad input before queueing: a rejected patch must not wait behind a slow write.
      const clean = taskConfigPatchSchema.parse(patch);
      return serialize(async () => {
        const prev = clone(cached);
        const base = parse(await bb.storage.kv.get(TASK_SETTINGS_KEY));
        const next = taskConfigSchema.parse({ ...base, ...clean });
        await bb.storage.kv.set(TASK_SETTINGS_KEY, next);
        cached = clone(next);
        if ((Object.keys(next) as (keyof TaskConfig)[]).some((key) => next[key] !== prev[key])) {
          try {
            onChange(clone(next), prev);
          } catch (error) {
            // The row is already committed; a listener that throws must not fail the write.
            bb.log.warn(`Task settings changed but the listener failed: ${message(error)}`);
          }
        }
        return clone(next);
      });
    },
  };
  await settings.read();
  return settings;
}

export type TaskSettingsStore = Awaited<ReturnType<typeof createTaskSettings>>;
