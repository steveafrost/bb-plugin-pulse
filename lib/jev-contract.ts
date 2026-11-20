// The jev plugin's public RPC contract. Other plugins import this file for the
// schemas and the typed client:
//
//   import { jevClient } from "bb-plugin-jev";           // or a relative/workspace path
//   const jev = jevClient(bb);
//   const r = await jev.judge({
//     tag: "example.drift",
//     state: { diff_summary: "…" },
//     questions: { needs_prototype: { type: "noul", instructions: "Is this change complex enough to need prototypes?" } },
//   });
//   if (!r.ok) handle(r.error);                       // fail closed: decide what to do on error
//   else r.answers.needs_prototype                     // { type: "noul", noul: 0.12 }
//   // later, when the human decides:
//   await jev.recordOutcome({ callId: r.callId, outcomes: { needs_prototype: false } });
//
// Changes here are API changes: add optional fields, never repurpose one.
//
// Fail-closed rules callers can rely on: a judgment that did not happen is
// `ok: false` with a typed error; there is no fallback to another model; the
// `model` in an ok result is what jev reported answering, and `requestedModel`
// is what was asked for.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const PLUGIN_ID = "jev";
export const DEFAULT_MODEL = "";
export const KNOWN_MODELS: readonly string[] = [];

// ── primitives ───────────────────────────────────────────────────────────
/** The API accepts any string id; the id is never sent to the model. */
export const questionIdSchema = z.string().min(1).max(200);
export const modelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "invalid model name");
/** A decision-point id such as `example.drift`. Calibration is grouped by it. */
export const tagSchema = z.string().regex(/^[A-Za-z0-9_.:/-]{1,80}$/, "tags are 1-80 chars of A-Z a-z 0-9 _ . : / -");

/** What jev reads: free text, a JSON object or a JSON array. Large states are refused (`input-too-large`). */
export const stateSchema = z.union([z.string().min(1), z.array(z.json()), z.record(z.string(), z.json())]);
export type State = z.infer<typeof stateSchema>;

// ── questions ────────────────────────────────────────────────────────────
// Shapes follow TypeSafe's documented request format: instructions, choice option descriptions,
// score levels and noul criteria are each a string, an object, an array or null ("structure"; see
// https://docs.typesafe.ai/primitives/advanced). Only the API's own limits are enforced here
// (score: at most 10 levels; choice: at most 255 options); the rest is its call.

/** A string, object, array or null: what the API calls an `EntryType`. */
export const entrySchema = z.union([z.string(), z.array(z.json()), z.record(z.string(), z.json()), z.null()]);
export type Entry = z.infer<typeof entrySchema>;

export const choiceQuestionSchema = z
  .object({
    type: z.literal("choice"),
    instructions: entrySchema,
    /** option name -> description (any entry, including null). Answers and outcomes are option names. */
    criteria: z
      .record(z.string().min(1), entrySchema)
      .refine((c) => Object.keys(c).length >= 1 && Object.keys(c).length <= 255, "choice takes 1-255 options"),
  })
  .strict();
export const scoreQuestionSchema = z
  .object({
    type: z.literal("score"),
    instructions: entrySchema,
    /**
     * Ordered level descriptions, lowest first (1-10). A level is named by its description when that is a unique
     * non-empty string that is not itself shaped like `#<number>`, otherwise `#<index>`; outcomes may also be given as the level index.
     */
    criteria: z.array(entrySchema).min(1).max(10),
  })
  .strict();
/** Yes/no. The wire type is `noul`; the answer is P(yes) in [0, 1]. */
export const noulQuestionSchema = z
  .object({
    type: z.literal("noul"),
    instructions: entrySchema.optional(),
    /** Optional descriptions of what yes and no mean. */
    criteria: z.object({ true: entrySchema.optional(), false: entrySchema.optional() }).strict().optional(),
  })
  .strict()
  .refine((q) => (q.instructions !== undefined && q.instructions !== null) || q.criteria !== undefined, "a yes/no question needs instructions or criteria");
/**
 * Find where something is in an image: the answer is one bounding box. Needs an image in the call (`assets`), the
 * `allowImages` setting, and a model that supports it (jev 1.14 or later). An experimental TypeSafe feature.
 */
export const boxQuestionSchema = z.object({ type: z.literal("box"), instructions: entrySchema }).strict();
export const questionSchema = z.discriminatedUnion("type", [choiceQuestionSchema, scoreQuestionSchema, noulQuestionSchema, boxQuestionSchema]);
// ── images (experimental in the TypeSafe API; off unless the `allowImages` setting is on) ──
/**
 * One image, referenced from the state, a question's instructions or its criteria by the map key (a string that
 * cannot occur in your text by accident, such as a UUID). PNG or JPEG, 280 to 1568 px per side, at most 16 MiB.
 * Every asset must be referenced somewhere in the call. Images are sent, never stored: the ledger keeps a hash.
 */
export const assetSchema = z
  .object({
    type: z.literal("image").optional(),
    format: z.enum(["png", "jpg", "jpeg"]),
    /** Standard base64 with padding, no line breaks, no `data:` prefix. */
    data_base64: z.string().min(4).regex(/^[A-Za-z0-9+/]+={0,2}$/, "standard base64 with no whitespace or data: prefix"),
  })
  .strict();
export const assetsSchema = z.record(z.string().min(1).max(1024), assetSchema);
export type Assets = z.infer<typeof assetsSchema>;

/** At least one question; the API has no count limit (the request size is limited, see `maxQuestionBytes`). */
export const questionsSchema = z.record(questionIdSchema, questionSchema).refine((q) => Object.keys(q).length >= 1, "at least one question");
export type Question = z.infer<typeof questionSchema>;
export type Questions = z.infer<typeof questionsSchema>;

// ── answers (normalised from jev's wire shape) ───────────────────────────
export const choiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  /**
   * jev's own certainty statistic, not P(choice): 0 for an even spread over the options, 1 when all
   * probability sits on one. For n options it is (pmax - 1/n) / (1 - 1/n). P(choice) is `probabilities[choice]`.
   */
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number()),
});
export const scoreAnswerSchema = z.object({
  type: z.literal("score"),
  /** The level jev put most probability on: the description when it is a unique non-empty string that is not itself shaped like `#<number>`, else `#<index>`. */
  level: z.string(),
  levelIndex: z.number().int().min(0),
  /** jev's raw expected level index (fractional): 0.37 sits between levels 0 and 1. */
  score: z.number(),
  /** jev's own certainty statistic (1 = all probability on one level), not P(level). Neighbouring levels cost less than distant ones. */
  confidence: z.number().min(0).max(1),
  /** Keyed by level name (see `level`). `probabilities[level]` is P(level). */
  probabilities: z.record(z.string(), z.number()),
});
export const noulAnswerSchema = z.object({
  type: z.literal("noul"),
  /** P(yes). */
  noul: z.number().min(0).max(1),
});
/** Edges as fractions of the image's width (left, right) and height (top, bottom) from the top-left corner. */
export const boxSchema = z
  .object({ top: z.number().min(0).max(1), bottom: z.number().min(0).max(1), left: z.number().min(0).max(1), right: z.number().min(0).max(1) })
  .refine((b) => b.left < b.right && b.top < b.bottom, "left < right and top < bottom");
export type Box = z.infer<typeof boxSchema>;
export const boxAnswerSchema = z.object({
  type: z.literal("box"),
  box: boxSchema,
  /** jev's certainty, or null when the model gives none. A box answer always has a box, even for something that is absent: ask a yes/no beside it. */
  confidence: z.number().min(0).max(1).nullable(),
});
export const answerSchema = z.discriminatedUnion("type", [choiceAnswerSchema, scoreAnswerSchema, noulAnswerSchema, boxAnswerSchema]);
export type BoxAnswer = z.infer<typeof boxAnswerSchema>;
export type Answer = z.infer<typeof answerSchema>;
export type ChoiceAnswer = z.infer<typeof choiceAnswerSchema>;
export type ScoreAnswer = z.infer<typeof scoreAnswerSchema>;
export type NoulAnswer = z.infer<typeof noulAnswerSchema>;
export const answersSchema = z.record(z.string(), answerSchema);

// ── errors ───────────────────────────────────────────────────────────────
export const ERROR_CODES = ["not-configured", "http", "timeout", "network", "bad-response", "rate-limited", "input-too-large", "invalid-request"] as const;
export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export const jevErrorSchema = z.object({
  code: errorCodeSchema,
  /** Never contains the API key. */
  message: z.string(),
  /** HTTP status when the proxy answered. */
  status: z.number().int().optional(),
  /** `local` = a guard in this plugin refused (rate limit, concurrency, size, a request that cannot be sent as asked); `upstream` = the proxy did. */
  source: z.enum(["local", "upstream"]).optional(),
  retryAfterMs: z.number().int().optional(),
  /** Whether trying again later could succeed. The plugin already spent its bounded retries. */
  retryable: z.boolean(),
});
export type JevErrorInfo = z.infer<typeof jevErrorSchema>;

// ── judge ────────────────────────────────────────────────────────────────
export const questionSetRefSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9_.:/-]{1,80}$/),
    /** Registered version number. Omit for the latest at call time (the result says which). */
    version: z.number().int().min(1).optional(),
    /** Alternative to `version`: the content hash. */
    hash: z.string().regex(/^[0-9a-f]{8,64}$/).optional(),
  })
  .strict();

const judgeBase = {
  /** Inline questions, or ... */
  questions: questionsSchema.optional(),
  /** ... a registered set (exactly one of the two). */
  questionSet: questionSetRefSchema.optional(),
  /** Exact model string to request. Default: the plugin's `defaultModel` setting. */
  model: modelSchema.optional(),
  /** Whole-call deadline: key lookup, the wait for a concurrency slot and every attempt, retries included. Default: the `timeoutMs` setting. */
  timeoutMs: z.number().int().min(200).max(120_000).optional(),
  /** Decision-point id; the unit calibration is reported by. */
  tag: tagSchema.optional(),
  /** `false` skips the shadow model for this call. */
  shadow: z.boolean().optional(),
  /** Retries for transient failures on this call; overrides the `maxRetries` setting (0 = never retry, e.g. for interactive callers). */
  maxRetries: z.number().int().min(0).max(3).optional(),
};
const exactlyOneQuestionSource = (v: { questions?: unknown; questionSet?: unknown }) => (v.questions === undefined) !== (v.questionSet === undefined);
const QUESTION_SOURCE_MESSAGE = "pass exactly one of `questions` or `questionSet`";

export const judgeInputSchema = z.object({ state: stateSchema, ...judgeBase, assets: assetsSchema.optional() }).strict().refine(exactlyOneQuestionSource, QUESTION_SOURCE_MESSAGE);
export const judgeBatchInputSchema = z
  .object({
    states: z.array(stateSchema).min(1).max(200),
    ...judgeBase,
    /** Parallel requests for this batch; clamped to the plugin's limits. */
    concurrency: z.number().int().min(1).max(32).optional(),
  })
  .strict()
  .refine(exactlyOneQuestionSource, QUESTION_SOURCE_MESSAGE);

export const usageSchema = z.object({ inputTokens: z.number().int(), outputTokens: z.number().int() });
export const retryNoteSchema = z.object({ code: errorCodeSchema, status: z.number().int().optional(), waitedMs: z.number().int() });
const questionSetUsedSchema = z.object({
  /** sha256 prefix of the canonical questions. Calibration never mixes different hashes. */
  hash: z.string(),
  name: z.string().nullable(),
  version: z.number().int().nullable(),
});

const judgeCommon = {
  callId: z.string(),
  tag: z.string().nullable(),
  /** The exact model string sent. */
  requestedModel: z.string(),
  latencyMs: z.number().int(),
  /** HTTP attempts made (1 = no retry). Local refusals report 0. */
  attempts: z.number().int(),
  /** Why earlier attempts were retried; empty when none were. */
  retries: z.array(retryNoteSchema),
  questionSet: questionSetUsedSchema.nullable(),
  /** sha256 of the canonical state (the state itself is stored only if `storeStates` is on). */
  inputHash: z.string().nullable(),
};
export const judgeOkSchema = z.object({
  ok: z.literal(true),
  ...judgeCommon,
  /** The model string jev reported answering. Compare with `requestedModel`. */
  model: z.string(),
  answers: answersSchema,
  usage: usageSchema,
  /** A shadow model was started for this call; its answers are stored on the call, never returned here. */
  shadowModel: z.string().nullable(),
});
export const judgeErrSchema = z.object({
  ok: z.literal(false),
  ...judgeCommon,
  error: jevErrorSchema,
});
export const judgeResultSchema = z.discriminatedUnion("ok", [judgeOkSchema, judgeErrSchema]);
export type JudgeResult = z.infer<typeof judgeResultSchema>;
export type JudgeOk = z.infer<typeof judgeOkSchema>;
export type JudgeErr = z.infer<typeof judgeErrSchema>;
export type JudgeRequest = z.input<typeof judgeInputSchema>;
export type JudgeBatchRequest = z.input<typeof judgeBatchInputSchema>;

export const judgeBatchOutputSchema = z.object({
  batchId: z.string(),
  /** Same order as `states`. */
  results: z.array(judgeResultSchema),
  summary: z.object({ ok: z.number().int(), failed: z.number().int(), latencyMs: z.number().int(), concurrency: z.number().int() }),
});

// ── status / models ──────────────────────────────────────────────────────
const retentionSchema = z.object({
  /** Calls with no recorded outcome are deleted after this many days. */
  callDays: z.number(),
  /** Calls with a recorded outcome (and the outcomes) are deleted after this many days. */
  outcomeCallDays: z.number(),
  /** A stored state text is erased after this many days; the call row stays. */
  stateDays: z.number(),
});
const limitsSchema = z.object({
  timeoutMs: z.number(),
  maxRetries: z.number(),
  maxStateBytes: z.number(),
  maxQuestionBytes: z.number(),
  maxAssetBytes: z.number(),
  maxConcurrency: z.number(),
  perCallerConcurrency: z.number(),
  ratePerMinute: z.number(),
  perCallerRatePerMinute: z.number(),
  batchConcurrency: z.number(),
});
export const statusOutputSchema = z.object({
  configured: z.boolean(),
  keySource: z.enum(["setting", "env", "devx", "shell"]).nullable(),
  keyError: z.string().nullable(),
  baseUrl: z.string(),
  defaultModel: z.string(),
  shadowModel: z.string().nullable(),
  storeStates: z.boolean(),
  /** Images and box questions may be sent (the `allowImages` setting). */
  allowImages: z.boolean(),
  limits: limitsSchema,
  /** Days; 0 = keep. See the retention settings. */
  retention: retentionSchema,
  /** null = not probed (no key, or `probe: false`). */
  reachable: z.boolean().nullable(),
  reachableError: jevErrorSchema.nullable(),
  /** Models GET /v1/models lists (jev-1.14.0 answers but is not listed). */
  listedModels: z.array(z.string()).nullable(),
  checkedAt: z.number().int(),
});
export const modelsOutputSchema = z.object({
  defaultModel: z.string(),
  shadowModel: z.string().nullable(),
  /** Known to answer requests: the pinned release plus the moving aliases. */
  known: z.array(z.string()),
  listed: z.array(z.string()).nullable(),
  error: jevErrorSchema.nullable(),
});

// ── question-set registry ────────────────────────────────────────────────
export const questionSetInfoSchema = z.object({
  name: z.string(),
  version: z.number().int(),
  hash: z.string(),
  owner: z.string(),
  description: z.string().nullable(),
  createdAt: z.number().int(),
  questionIds: z.array(z.string()),
  latest: z.boolean(),
});
export const questionSetDetailSchema = questionSetInfoSchema.extend({ questions: questionsSchema });

// ── ledger ───────────────────────────────────────────────────────────────
/** choice: option; score: level name or index; yes/no: boolean; box: the true box. */
export const outcomeValueSchema = z.union([z.string().min(1).max(500), z.number(), z.boolean(), boxSchema]);
export const outcomeSourceSchema = z.enum(["human", "ground-truth", "auto"]);
export const outcomeRowSchema = z.object({
  questionId: z.string(),
  /** choice: label; score: level name; noul: boolean; box: the true box. */
  value: z.union([z.string(), z.boolean(), boxSchema]),
  source: outcomeSourceSchema,
  note: z.string().nullable(),
  recordedBy: z.string(),
  recordedAt: z.number().int(),
});
export const callSummarySchema = z.object({
  callId: z.string(),
  seq: z.number().int(),
  createdAt: z.number().int(),
  /** Calling plugin id, or `client` for the CLI/app. */
  caller: z.string(),
  tag: z.string().nullable(),
  batchId: z.string().nullable(),
  ok: z.boolean(),
  error: jevErrorSchema.nullable(),
  requestedModel: z.string(),
  model: z.string().nullable(),
  shadowModel: z.string().nullable(),
  shadowOk: z.boolean().nullable(),
  questionSetHash: z.string().nullable(),
  questionSetName: z.string().nullable(),
  questionSetVersion: z.number().int().nullable(),
  inputHash: z.string().nullable(),
  /** Images sent with the call (count and bytes); never their content. */
  assets: z.object({ count: z.number().int(), bytes: z.number().int() }).nullable(),
  answers: answersSchema.nullable(),
  latencyMs: z.number().int(),
  attempts: z.number().int(),
  usage: usageSchema.nullable(),
  outcomeCount: z.number().int(),
});
export const callDetailSchema = callSummarySchema.extend({
  questions: questionsSchema.nullable(),
  /** Present only when `storeStates` was on at call time. */
  state: stateSchema.nullable(),
  retries: z.array(retryNoteSchema),
  shadow: z
    .object({
      model: z.string(),
      returnedModel: z.string().nullable(),
      ok: z.boolean().nullable(),
      error: jevErrorSchema.nullable(),
      answers: answersSchema.nullable(),
      latencyMs: z.number().int().nullable(),
      usage: usageSchema.nullable(),
    })
    .nullable(),
  outcomes: z.array(outcomeRowSchema),
});
export type CallSummary = z.infer<typeof callSummarySchema>;
export type CallDetail = z.infer<typeof callDetailSchema>;

const rangeFilters = {
  tag: tagSchema.optional(),
  /** Plugin callers are always scoped to their own calls; passing another id is `forbidden`. */
  caller: z.string().max(80).optional(),
  /** Epoch ms, inclusive. */
  since: z.number().int().optional(),
  until: z.number().int().optional(),
};

export const callsListInputSchema = z
  .object({
    ...rangeFilters,
    model: modelSchema.optional(),
    ok: z.boolean().optional(),
    questionSetHash: z.string().optional(),
    hasOutcome: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).optional(),
    /** Page back: pass the previous `nextCursor` (a call `seq`). */
    before: z.number().int().optional(),
  })
  .strict();

export const outcomeRecordInputSchema = z
  .object({
    callId: z.string().min(1).max(60),
    /** questionId -> what actually happened. Unknown question ids and labels outside the rubric are refused. */
    outcomes: z.record(questionIdSchema, outcomeValueSchema).refine((o) => Object.keys(o).length >= 1, "record at least one outcome"),
    source: outcomeSourceSchema.optional(),
    note: z.string().max(500).optional(),
    /**
     * Accept a choice outcome that is not among the call's options, for "the user did something that was never offered".
     * It scores as a miss and shows up as support for its own label. Without this, such a label is refused.
     */
    allowOutside: z.boolean().optional(),
  })
  .strict();

// ── stats / calibration ──────────────────────────────────────────────────
export const statsInputSchema = z.object({ ...rangeFilters }).strict();
const latencySchema = z.object({ n: z.number().int(), mean: z.number().nullable(), p50: z.number().nullable(), p95: z.number().nullable(), max: z.number().nullable() });
export const statsOutputSchema = z.object({
  total: z.number().int(),
  /** When the oldest matching call was made (epoch ms): how far back these numbers reach. */
  oldestAt: z.number().int().nullable(),
  ok: z.number().int(),
  failed: z.number().int(),
  errorRate: z.number().nullable(),
  errorsByCode: z.record(z.string(), z.number().int()),
  latencyMs: latencySchema,
  tokens: z.object({ input: z.number().int(), output: z.number().int() }),
  withOutcome: z.number().int(),
  shadow: z.object({ calls: z.number().int(), failed: z.number().int() }),
  byModel: z.array(z.object({ requestedModel: z.string(), model: z.string().nullable(), calls: z.number().int(), failed: z.number().int() })),
  byTag: z.array(z.object({ tag: z.string().nullable(), calls: z.number().int(), failed: z.number().int(), withOutcome: z.number().int() })),
});

export const calibrationInputSchema = z
  .object({
    ...rangeFilters,
    questionId: questionIdSchema.optional(),
    questionSetHash: z.string().optional(),
    model: modelSchema.optional(),
    /** Which answers to score: the decision (`primary`) or the shadow model's. */
    which: z.enum(["primary", "shadow"]).optional(),
    /** Default 0.9. */
    targetPrecision: z.number().min(0).max(1).optional(),
    /** Fewest accepted samples a threshold needs. Default 20. */
    minSamples: z.number().int().min(1).optional(),
    /** Reliability bins, default 10. */
    bins: z.number().int().min(2).max(20).optional(),
    /** Pick thresholds on the Wilson 95% lower bound of precision, not the point estimate. */
    conservative: z.boolean().optional(),
  })
  .strict();
const labelStatSchema = z.object({
  label: z.string(),
  /** Calls where the outcome was this label. */
  support: z.number().int(),
  /** Calls where jev predicted this label. */
  predicted: z.number().int(),
  truePositive: z.number().int(),
  precision: z.number().nullable(),
  recall: z.number().nullable(),
});
const reliabilityBinSchema = z.object({
  lo: z.number(),
  hi: z.number(),
  n: z.number().int(),
  /** Mean probability jev gave its top label in this bin. */
  meanProbability: z.number().nullable(),
  accuracy: z.number().nullable(),
});
const sweepPointSchema = z.object({
  /** Accept when the statistic (confidence, or probability, per the sweep) is >= threshold. */
  threshold: z.number(),
  accepted: z.number().int(),
  correct: z.number().int(),
  precision: z.number().nullable(),
  /** Wilson 95% lower bound on precision. */
  precisionLower95: z.number().nullable(),
  /** accepted / n */
  coverage: z.number(),
});
const sweepSchema = z.object({
  targetPrecision: z.number(),
  minSamples: z.number().int(),
  conservative: z.boolean(),
  /** Lowest threshold meeting the target with >= minSamples accepted; null when none does. */
  recommended: sweepPointSchema.nullable(),
  /** A fixed grid (0.05 steps plus 0.99) for plotting. */
  points: z.array(sweepPointSchema),
});
export const calibrationGroupSchema = z.object({
  tag: z.string().nullable(),
  questionSetHash: z.string(),
  questionId: z.string(),
  type: z.enum(["choice", "score", "noul"]),
  model: z.string(),
  which: z.enum(["primary", "shadow"]),
  /** Calls with both an answer and a recorded outcome. */
  n: z.number().int(),
  accuracy: z.number().nullable(),
  labels: z.array(labelStatSchema),
  reliability: z.array(reliabilityBinSchema),
  /** Expected calibration error: weighted mean |P(top label) - accuracy| over the reliability bins. */
  ece: z.number().nullable(),
  /**
   * Threshold on jev's `confidence` (choice/score: its own statistic; yes/no: |2p - 1|, the same
   * scale). Accept the top label when confidence >= t. This is the number TypeSafe's docs gate on.
   */
  sweepByConfidence: sweepSchema,
  /** Threshold on P(top label): accept when it is >= t. Reads directly as "how likely is this answer". */
  sweepByProbability: sweepSchema,
  /** Per-label sweep on P(label): accept that label when its probability >= t. yes/no labels are `yes`/`no`. */
  sweepByLabel: z.record(z.string(), sweepSchema),
  /**
   * score only. Uses the raw fractional `score`: mean |score - actual level|, the share within one
   * level, and the accuracy of the "round the score to the nearest level" rule (the other labels in
   * this group are scored by most-probable level).
   */
  ordinal: z.object({ meanAbsLevelError: z.number(), withinOne: z.number(), roundedAccuracy: z.number() }).nullable(),
});
export const shadowComparisonSchema = z.object({
  tag: z.string().nullable(),
  questionSetHash: z.string(),
  questionId: z.string(),
  primaryModel: z.string(),
  shadowModel: z.string(),
  /** Calls where both models answered. */
  nCompared: z.number().int(),
  /** Same top label. */
  agreement: z.number().nullable(),
  /** Of those, calls with an outcome. */
  nWithOutcome: z.number().int(),
  primaryAccuracy: z.number().nullable(),
  shadowAccuracy: z.number().nullable(),
});
/** Box answers have no labels or probabilities, so they are scored by overlap (intersection over union) with the true box. */
export const boxGroupSchema = z.object({
  tag: z.string().nullable(),
  questionSetHash: z.string(),
  questionId: z.string(),
  model: z.string(),
  which: z.enum(["primary", "shadow"]),
  n: z.number().int(),
  meanIou: z.number().nullable(),
  /** Share of answers whose box overlaps the true box with IoU of at least 0.5 and 0.75. */
  iouAtLeast50: z.number().nullable(),
  iouAtLeast75: z.number().nullable(),
  /** Mean jev confidence over the answers that gave one. */
  meanConfidence: z.number().nullable(),
});
export const calibrationOutputSchema = z.object({
  generatedAt: z.number().int(),
  groups: z.array(calibrationGroupSchema),
  boxGroups: z.array(boxGroupSchema),
  shadowComparison: z.array(shadowComparisonSchema),
});
export type CalibrationGroup = z.infer<typeof calibrationGroupSchema>;
export type CalibrationReport = z.infer<typeof calibrationOutputSchema>;
export type Stats = z.infer<typeof statsOutputSchema>;

// ── evidence the caller brings (stateless calibration) ────────────────────
/**
 * A truth the caller supplies. A label, a level name or index, a boolean, or a box, as in `outcome.record`; or, for a
 * choice or score, an array of acceptable answers ("any of these counts"). Unlike `outcome.record`, a label that was
 * never offered is allowed: it just counts as a miss.
 */
export const evidenceOutcomeSchema = z.union([outcomeValueSchema, z.array(z.union([z.string().min(1).max(500), z.number().int()])).min(1).max(50)]);
const evidenceGroupName = z.string().min(1).max(200);
/** An answer from this plugin's ledger, scored against an outcome the caller keeps. */
export const referencedEvidenceSchema = z
  .object({ callId: z.string().min(1).max(60), questionId: questionIdSchema, outcome: evidenceOutcomeSchema, group: evidenceGroupName.optional() })
  .strict();
/** An answer the caller holds itself (for example, one jev gave before this plugin existed). */
export const inlineEvidenceSchema = z.object({ answer: answerSchema, outcome: evidenceOutcomeSchema, model: modelSchema.optional(), group: evidenceGroupName.optional() }).strict();
export const calibrateInputSchema = z
  .object({
    items: z.array(z.union([referencedEvidenceSchema, inlineEvidenceSchema])).min(1).max(20_000),
    /** Which answers of a referenced call to score. */
    which: z.enum(["primary", "shadow"]).optional(),
    targetPrecision: z.number().min(0).max(1).optional(),
    minSamples: z.number().int().min(1).optional(),
    bins: z.number().int().min(2).max(20).optional(),
    conservative: z.boolean().optional(),
  })
  .strict();
const topKSchema = z.array(z.object({ k: z.number().int(), rate: z.number().nullable() }));
/** A calibration group the caller defined, rather than the ledger: the `group` name, the model and the answer type. */
export const evidenceGroupSchema = calibrationGroupSchema
  .omit({ tag: true, questionSetHash: true, questionId: true })
  .extend({ group: z.string(), hitAtK: topKSchema });
export const evidenceBoxGroupSchema = boxGroupSchema.omit({ tag: true, questionSetHash: true, questionId: true }).extend({ group: z.string() });
export const calibrateOutputSchema = z.object({
  generatedAt: z.number().int(),
  groups: z.array(evidenceGroupSchema),
  boxGroups: z.array(evidenceBoxGroupSchema),
});
export type EvidenceGroup = z.infer<typeof evidenceGroupSchema>;
export type CalibrateReport = z.infer<typeof calibrateOutputSchema>;

// ── the contract ─────────────────────────────────────────────────────────
export const jevContract = defineRpcContract({
  status: { input: z.object({ probe: z.boolean().optional() }).strict(), output: statusOutputSchema },
  models: { input: z.object({}).strict(), output: modelsOutputSchema },
  judge: { input: judgeInputSchema, output: judgeResultSchema },
  judgeBatch: { input: judgeBatchInputSchema, output: judgeBatchOutputSchema },
  "questionSets.register": {
    input: z.object({ name: questionSetRefSchema.shape.name, questions: questionsSchema, description: z.string().max(500).optional() }).strict(),
    output: z.object({ name: z.string(), version: z.number().int(), hash: z.string(), /** false when identical content was already the latest version */ created: z.boolean() }),
  },
  "questionSets.list": { input: z.object({ name: z.string().optional() }).strict(), output: z.object({ sets: z.array(questionSetInfoSchema) }) },
  "questionSets.get": { input: questionSetRefSchema, output: questionSetDetailSchema },
  "calls.list": { input: callsListInputSchema, output: z.object({ calls: z.array(callSummarySchema), nextCursor: z.number().int().nullable() }) },
  "calls.get": { input: z.object({ callId: z.string().min(1).max(60) }).strict(), output: callDetailSchema },
  "outcome.record": {
    input: outcomeRecordInputSchema,
    output: z.object({ callId: z.string(), recorded: z.array(z.string()) }),
  },
  stats: { input: statsInputSchema, output: statsOutputSchema },
  calibration: { input: calibrationInputSchema, output: calibrationOutputSchema },
  /** Calibration over evidence the caller passes in, grouped the way the caller says. Looks up referenced calls; writes nothing. */
  calibrate: { input: calibrateInputSchema, output: calibrateOutputSchema },
});

export const RPC_DESCRIPTION =
  "Typed classification over TypeSafe jev (System One). `judge`/`judgeBatch` answer choice, score and yes/no questions about a state with a pinned model and log every call; " +
  "`outcome.record` attaches the eventual human/ground-truth result; `calibration` and `stats` report precision/recall, reliability and confidence thresholds per decision tag. " +
  "Errors are typed results (never a silent fallback model). Contract and typed client: contract.ts.";

// ── typed client for consumer plugins ────────────────────────────────────
type CallRpc = BbPluginApi["sdk"]["plugins"]["callRpc"];
export interface JevClientHost {
  sdk: { plugins: { callRpc: CallRpc } };
}
type Methods = typeof jevContract;
type Input<M extends keyof Methods> = z.input<Methods[M]["input"]>;
type Output<M extends keyof Methods> = z.output<Methods[M]["output"]>;

/** Thrown by `judgeOrThrow` when jev answered with a typed error. */
export class JevCallError extends Error {
  constructor(
    readonly error: JevErrorInfo,
    readonly callId: string,
  ) {
    super(`jev ${error.code}: ${error.message}`);
    this.name = "JevCallError";
  }
}

/**
 * Typed wrapper over `bb.sdk.plugins.callRpc`. Transport failures (jev plugin
 * not installed/disabled, a refused call) reject; judgment failures are
 * `{ ok: false }` results. Use `judgeOrThrow` to get a throw for those too.
 */
export function jevClient(host: JevClientHost, defaults: { signal?: AbortSignal } = {}): JevClient {
  const call = <M extends keyof Methods>(method: M, input: Input<M>, signal?: AbortSignal): Promise<Output<M>> =>
    host.sdk.plugins.callRpc({
      pluginId: PLUGIN_ID,
      method,
      input: input as never,
      signal: signal ?? defaults.signal,
      outputSchema: jevContract[method].output as never,
    }) as Promise<Output<M>>;
  return {
    status: (input: Input<"status"> = {}) => call("status", input),
    models: () => call("models", {}),
    judge: (input: JudgeRequest, signal?: AbortSignal) => call("judge", input, signal),
    judgeOrThrow: async (input: JudgeRequest, signal?: AbortSignal): Promise<JudgeOk> => {
      const r = await call("judge", input, signal);
      if (!r.ok) throw new JevCallError(r.error, r.callId);
      return r;
    },
    judgeBatch: (input: JudgeBatchRequest, signal?: AbortSignal) => call("judgeBatch", input, signal),
    registerQuestionSet: (input: Input<"questionSets.register">) => call("questionSets.register", input),
    listQuestionSets: (input: Input<"questionSets.list"> = {}) => call("questionSets.list", input),
    getQuestionSet: (input: Input<"questionSets.get">) => call("questionSets.get", input),
    listCalls: (input: Input<"calls.list"> = {}) => call("calls.list", input),
    getCall: (callId: string) => call("calls.get", { callId }),
    recordOutcome: (input: Input<"outcome.record">) => call("outcome.record", input),
    stats: (input: Input<"stats"> = {}) => call("stats", input),
    calibration: (input: Input<"calibration"> = {}) => call("calibration", input),
    calibrate: (input: Input<"calibrate">) => call("calibrate", input),
  };
}
export interface JevClient {
  status(input?: Input<"status">): Promise<Output<"status">>;
  models(): Promise<Output<"models">>;
  /** Typed result: check `ok`. Rejects only on transport/contract failures. */
  judge(input: JudgeRequest, signal?: AbortSignal): Promise<JudgeResult>;
  /** Like `judge`, but throws `JevCallError` for `ok: false`. */
  judgeOrThrow(input: JudgeRequest, signal?: AbortSignal): Promise<JudgeOk>;
  judgeBatch(input: JudgeBatchRequest, signal?: AbortSignal): Promise<Output<"judgeBatch">>;
  registerQuestionSet(input: Input<"questionSets.register">): Promise<Output<"questionSets.register">>;
  listQuestionSets(input?: Input<"questionSets.list">): Promise<Output<"questionSets.list">>;
  getQuestionSet(input: Input<"questionSets.get">): Promise<Output<"questionSets.get">>;
  listCalls(input?: Input<"calls.list">): Promise<Output<"calls.list">>;
  getCall(callId: string): Promise<Output<"calls.get">>;
  /** Attach what actually happened to a past call; this is what calibration is computed from. */
  recordOutcome(input: Input<"outcome.record">): Promise<Output<"outcome.record">>;
  stats(input?: Input<"stats">): Promise<Output<"stats">>;
  calibration(input?: Input<"calibration">): Promise<Output<"calibration">>;
  /** Calibration over answers and outcomes you pass in, grouped as you choose; nothing is read from or written to the ledger beyond looking up referenced calls. */
  calibrate(input: Input<"calibrate">): Promise<Output<"calibrate">>;
}
