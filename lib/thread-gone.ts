/**
 * Whether a bb thread call failed because the thread itself is gone: deleted, archived, or an
 * unknown id. Retrying such a thread can only fail again, so callers drop or settle it instead.
 */
export const threadGone = (cause: unknown): boolean =>
  /not found|archived/i.test(cause instanceof Error ? cause.message : String(cause));
