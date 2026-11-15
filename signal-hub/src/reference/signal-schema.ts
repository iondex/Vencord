import { z } from "zod";

export class ExtractionValidationError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
    readonly diagnostic = message
  ) {
    super(message);
    this.name = "ExtractionValidationError";
  }
}

export type ExtractionContext = {
  routeName?: string;
};

const optionSignalSchema = z.object({
  kind: z.literal("option_entry").default("option_entry"),
  ticker: z.string().trim().min(1).transform(value => value.replace(/^\$/, "").toUpperCase()),
  underlyingTicker: z.preprocess(
    value => typeof value === "string" ? value.replace(/^\$/, "").toUpperCase() : value,
    z.string().trim().min(1).optional()
  ),
  contractTicker: z.preprocess(
    value => typeof value === "string" ? value.toUpperCase() : value,
    z.string().trim().min(1).optional()
  ),
  tickerResolution: z.object({
    method: z.enum(["encoded", "massive_reference", "manual", "unresolved"]),
    confidence: z.number().min(0).max(1),
    notes: z.array(z.string()).default([])
  }).optional(),
  expiration: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
  expirationRaw: z.string().nullable().optional().transform(value => value ?? ""),
  strike: z.preprocess(finiteNumber, z.number().positive()),
  side: z.preprocess(optionSide, z.enum(["call", "put"])),
  optionPrice: z.preprocess(
    value => value === undefined || value === "" ? null : finiteNumber(value),
    z.number().nonnegative().nullable()
  ),
  positionSize: z.preprocess(
    normalizePositionSize,
    z.string().nullable().optional().transform(value => value ?? null)
  ),
  riskNotes: z.array(z.string()).default([]),
  extra: z.record(z.string(), z.unknown()).default({})
});

const equitySignalSchema = z.object({
  kind: z.literal("equity_entry"),
  ticker: z.string().trim().min(1).transform(value => value.replace(/^\$/, "").toUpperCase()),
  side: z.enum(["long", "short"]),
  entryPrice: z.preprocess(
    value => value === undefined || value === "" ? null : finiteNumber(value),
    z.number().positive().nullable()
  ),
  positionSize: z.preprocess(
    normalizePositionSize,
    z.string().nullable().optional().transform(value => value ?? null)
  ),
  riskNotes: z.array(z.string()).default([]),
  extra: z.record(z.string(), z.unknown()).default({})
});

const entrySignalSchema = z.preprocess(value => {
  if (value && typeof value === "object" && !Array.isArray(value) && !("kind" in value)) {
    return { ...value, kind: "option_entry" };
  }
  return value;
}, z.discriminatedUnion("kind", [optionSignalSchema, equitySignalSchema]));

const baseExtractionSchema = z.object({
  kind: z.enum(["signal", "irrelevant"]),
  reason: z.string().trim().min(1),
  signals: z.array(entrySignalSchema)
});

export const extractionResponseSchema = baseExtractionSchema.superRefine((value, context) => {
  if (value.kind === "signal" && value.signals.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["signals"],
      message: "signal output must include at least one option signal"
    });
  }

  if (value.kind === "irrelevant" && value.signals.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["signals"],
      message: "irrelevant output must not include signals"
    });
  }
});

export type ExtractedOptionSignal = z.infer<typeof optionSignalSchema>;
export type ExtractedEquitySignal = z.infer<typeof equitySignalSchema>;
export type ExtractedEntrySignal = z.infer<typeof entrySignalSchema>;
export type ExtractionResponse = z.infer<typeof extractionResponseSchema>;

export function parseExtractionResponse(content: string, context: ExtractionContext = {}): ExtractionResponse {
  if (!content.trim()) {
    throw new ExtractionValidationError("LLM returned empty content");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new ExtractionValidationError("LLM returned invalid JSON", error);
  }

  const result = extractionResponseSchema.safeParse(normalizeShape(parsed, context));
  if (!result.success) {
    const detail = validationDiagnostic(result.error);
    throw new ExtractionValidationError(
      "LLM JSON did not match extraction schema",
      result.error,
      `schema_validation: ${detail}`.slice(0, 1000)
    );
  }
  return completeDerivedFields(result.data);
}

function finiteNumber(value: unknown): unknown {
  if (typeof value !== "string" || value.trim() === "") {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}

function optionSide(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if (["c", "call", "calls"].includes(normalized)) {
    return "call";
  }
  if (["p", "put", "puts"].includes(normalized)) {
    return "put";
  }
  return value;
}

function normalizePositionSize(value: unknown): unknown {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : value;
}

function normalizeShape(value: unknown, context: ExtractionContext): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const extraction = value as Record<string, unknown>;
  if (extraction.kind === "option_entry" || extraction.kind === "equity_entry") {
    return normalizeShape({ kind: "signal", signals: [extraction] }, context);
  }
  const signals = extraction.signals
    && typeof extraction.signals === "object"
    && !Array.isArray(extraction.signals)
    ? [extraction.signals]
    : extraction.signals;
  const normalized = {
    ...extraction,
    signals,
    reason: normalizedReason(extraction)
  };
  if (!Array.isArray(signals)) {
    return normalized;
  }
  return {
    ...normalized,
    signals: signals.map(item => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return item;
      }
      const signal = { ...(item as Record<string, unknown>) };
      signal.kind ??= "option_entry";
      if (signal.kind === "option_entry") {
        if (signal.side === undefined && context.routeName === "Enrich") {
          signal.side = "call";
        }
      }
      return signal;
    })
  };
}

function normalizedReason(extraction: Record<string, unknown>): unknown {
  if (typeof extraction.reason === "string" && extraction.reason.trim()) {
    return extraction.reason;
  }
  if (extraction.kind === "signal") {
    return "New entry extracted.";
  }
  if (extraction.kind === "irrelevant") {
    return "No new entry signal.";
  }
  return extraction.reason;
}

function validationDiagnostic(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map(issue => `${issue.path.map(String).join(".") || "root"} ${issue.code}`)
    .join("; ")
    .slice(0, 1000);
}

function completeDerivedFields(result: ExtractionResponse): ExtractionResponse {
  return {
    ...result,
    signals: result.signals.map(signal => {
      if (signal.kind !== "option_entry") {
        return signal;
      }
      const underlyingTicker = signal.underlyingTicker ?? signal.ticker;
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(signal.expiration);
      if (!match) {
        return { ...signal, underlyingTicker };
      }
      const [, year, month, day] = match;
      const side = signal.side === "call" ? "C" : "P";
      const strike = String(Math.round(signal.strike * 1000)).padStart(8, "0");
      return {
        ...signal,
        underlyingTicker,
        contractTicker: signal.contractTicker ?? `O:${underlyingTicker}${year.slice(2)}${month}${day}${side}${strike}`,
        tickerResolution: signal.tickerResolution ?? {
          method: "encoded" as const,
          confidence: 1,
          notes: []
        }
      };
    })
  };
}
