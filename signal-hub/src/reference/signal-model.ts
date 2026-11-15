import OpenAI from "openai";

import { type ExtractionResponse,ExtractionValidationError, parseExtractionResponse } from "./signal-schema.js";

export { ExtractionValidationError } from "./signal-schema.js";

export type SignalMessageInput = {
  messageId: string;
  routeName: string;
  signalTime: string;
  analyst: string;
  channelId: string;
  content: string;
};

export type ExtractLogEvent = {
  time: string;
  level: "info" | "warn" | "error";
  event: "signal_extract_retry" | "signal_extract_success" | "signal_extract_failed";
  messageId: string;
  attempt?: number;
  attempts?: number;
  maxAttempts: number;
  provider: string;
  model: string;
  kind?: "signal" | "irrelevant";
  signalCount?: number;
  errorType?: string;
  error?: string;
};

export type ExtractLogger = (event: ExtractLogEvent) => void;

type ChatCompletionClient = {
  chat: {
    completions: {
      create: (request: {
        model: string;
        messages: Array<{ role: "system" | "user"; content: string }>;
        response_format: { type: "json_object" };
        temperature: number;
        max_tokens: number;
      }) => Promise<{
        choices?: Array<{
          message?: {
            content?: string | null;
          };
        }>;
      }>;
    };
  };
};

export type ExtractMessageSignalOptions = {
  client: ChatCompletionClient;
  model: string;
  provider: string;
  message: SignalMessageInput;
  logger?: ExtractLogger;
  maxRetries?: number;
};

export type ExtractMessageSignalResult = {
  result: ExtractionResponse;
  attempts: number;
};

export type CreateOpenAICompatibleClientOptions = {
  apiKey: string;
  baseURL?: string;
  timeoutMs?: number;
};

const maxTokens = 1200;
const globalRules = [
  "Extract only new US option or equity entries from the current MAIN or EMBED sections.",
  "Closed, sold, trim, gain, recap, stop update, target update, DCA/add, existing position, watchlist, advertisement, and hype are irrelevant.",
  "Percentage gains such as +36%, GAINER labels, price-to-price arrows, trims, and double-up statements are performance exhibitions, not new entries.",
  "A performance update that quotes or replies to an earlier entry remains irrelevant; never revive the quoted entry.",
  "REPLY CONTEXT is context only and can never create a signal by itself.",
  "Never join this message with a previous or later Discord message.",
  "For options require ticker, expiration, strike, and side; optionPrice may be null.",
  "Only on route Enrich, default a missing option side to call; preserve an explicit put.",
  "Resolve 0DTE from signalTime and normalize an unambiguous weekly expiration to YYYY-MM-DD.",
  "Respond with one JSON object and no prose."
];
const routeGuidance: Record<string, string> = {
  "qqq-spy-mike": "Labeled multiline ticker, strike CALLS/PUTS, EXPIRATION, and Entry denotes a new entry.",
  "abi-vip": "Compact $TICKER M/D STRIKEc|p PRICE forms denote entries when not presented as position updates.",
  "proph-vip": "Multiline ticker/date/strike/CALL|PUT/premium denotes entry; price arrows, percentage gains, and GAINER text are performance updates.",
  "morphine-free": "$SPY STRIKE Calls|Puts D/M PRICE Entry denotes entry; price ranges followed by a positive percentage or Current level / Targets are performance updates.",
  "Remz-swing": "Took a trim and percentage-return messages are position updates even when reply context contains the original entry.",
  "artisanwill-challenge": "Trimmed and double-up statements are performance updates unless the current message separately contains an explicit new entry.",
  "rowdy-vip": "Lotto shorthand may use the existing SPY same-day route default.",
  "Cblast-swing": "Opened denotes entry; Closed never denotes entry.",
  "Jtradezz": "Compact 0dte contract may be entry; a separate fill-only message is irrelevant.",
  "Enrich": "If an otherwise complete option entry omits side, use call; explicit put remains put."
};

export function createOpenAICompatibleClient(options: CreateOpenAICompatibleClientOptions): OpenAI {
  return new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    timeout: options.timeoutMs,
    maxRetries: 0
  });
}

export async function extractMessageSignal(options: ExtractMessageSignalOptions): Promise<ExtractionResponse> {
  return (await extractMessageSignalWithAttempts(options)).result;
}

export async function extractMessageSignalWithAttempts(options: ExtractMessageSignalOptions): Promise<ExtractMessageSignalResult> {
  const deterministic = deterministicExtraction(options.message);
  if (deterministic) {
    options.logger?.({
      time: new Date().toISOString(),
      level: "info",
      event: "signal_extract_success",
      messageId: options.message.messageId,
      attempt: 1,
      attempts: 1,
      maxAttempts: 1,
      provider: options.provider,
      model: options.model,
      kind: deterministic.kind,
      signalCount: deterministic.signals.length
    });
    return { result: deterministic, attempts: 1 };
  }

  const maxAttempts = 1 + (options.maxRetries ?? 3);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await options.client.chat.completions.create({
        model: options.model,
        messages: buildMessages(options.message),
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: maxTokens
      });
      const content = response.choices?.[0]?.message?.content ?? "";
      const result = parseExtractionResponse(content, { routeName: options.message.routeName });
      options.logger?.({
        time: new Date().toISOString(),
        level: "info",
        event: "signal_extract_success",
        messageId: options.message.messageId,
        attempt,
        attempts: attempt,
        maxAttempts,
        provider: options.provider,
        model: options.model,
        kind: result.kind,
        signalCount: result.signals.length
      });
      return { result, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        options.logger?.({
          time: new Date().toISOString(),
          level: "warn",
          event: "signal_extract_retry",
          messageId: options.message.messageId,
          attempt,
          maxAttempts,
          provider: options.provider,
          model: options.model,
          errorType: errorType(error),
          error: errorMessage(error)
        });
      }
    }
  }

  options.logger?.({
    time: new Date().toISOString(),
    level: "error",
    event: "signal_extract_failed",
    messageId: options.message.messageId,
    attempts: maxAttempts,
    maxAttempts,
    provider: options.provider,
    model: options.model,
    errorType: errorType(lastError),
    error: errorMessage(lastError)
  });

  const error = lastError instanceof Error ? lastError : new ExtractionValidationError("LLM extraction failed");
  throw Object.assign(error, { attempts: maxAttempts });
}

function buildMessages(message: SignalMessageInput): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content: [
        "You extract US stock option and equity entry signals from Discord trading messages.",
        "Respond only with one JSON object.",
        "The top-level kind must be either signal or irrelevant.",
        "Only extract new entry signals. Do not extract exits, trims, sells, runners, stop-loss updates, scale-out instructions, profit updates, gains, return screenshots, watchlists, ads, hype, or recaps.",
        "Classify anything that is not a new option or equity entry as irrelevant.",
        "Only classify signal when the message contains at least one new entry. Set kind to option_entry or equity_entry for every signal.",
        "For option entries, require ticker, expiration, strike, and call/put side. Normalize ticker without $, normalize side to call or put, and normalize expiration to YYYY-MM-DD when possible.",
        "For option entries output only kind, ticker, expiration, expirationRaw, strike, side, optionPrice, and positionSize. Do not generate contractTicker, underlyingTicker, or tickerResolution; they are derived after validation.",
        "If an option expiration cannot be determined, return irrelevant.",
        "For equity entries require ticker and long/short side, and output only kind, ticker, side, entryPrice, and positionSize.",
        "Use null for absent optionPrice, entryPrice, or positionSize. positionSize may be a short string.",
        "Do not output action or confidence fields.",
        "Return {\"kind\":\"signal\",\"reason\":\"...\",\"signals\":[{\"kind\":\"option_entry\",\"ticker\":\"APPN\",\"expiration\":\"2026-06-18\",\"expirationRaw\":\"6/18\",\"strike\":30,\"side\":\"call\",\"optionPrice\":0.65,\"positionSize\":null}]} or {\"kind\":\"irrelevant\",\"reason\":\"...\",\"signals\":[]} and no prose.",
        ...globalRules,
        routeGuidance[message.routeName] ?? "Use only the global rules; do not invent route defaults."
      ].join(" ")
    },
    {
      role: "user",
      content: JSON.stringify({
        messageId: message.messageId,
        routeName: message.routeName,
        signalTime: message.signalTime,
        analyst: message.analyst,
        channelId: message.channelId,
        content: message.content
      })
    }
  ];
}

function deterministicExtraction(message: SignalMessageInput): ExtractionResponse | null {
  if (isPerformanceOnly(message.content)) {
    return {
      kind: "irrelevant",
      reason: "Current message is a performance exhibition or position update, not a new entry.",
      signals: []
    };
  }

  const signal = parseRowdyLottoSignal(message);
  if (!signal) {
    return null;
  }

  return {
    kind: "signal",
    reason: "Rowdy lotto shorthand with strike, side, and entry price; route defaults to SPY same-day options.",
    signals: [signal]
  };
}

function isPerformanceOnly(content: string): boolean {
  const currentContent = content.split(/\n\n(?=\[REPLY CONTEXT(?: |\]))/)[0] ?? content;
  const performanceMarker = /(?:\+\s*\d+(?:\.\d+)?\s*%|\b\d+(?:\.\d+)?\s*%\s*(?:gainer|gain|up)\b|\bgainers?\b|\btook\s+(?:a\s+)?trim\b|\btrim(?:med|ming)?\b|\bdouble(?:d|\s+up)\b|\bofficially\s+(?:a\s+)?double\s+up\b|\$?\d+(?:\.\d+)?\s*(?:->|--?>|=>|\u27a1\ufe0f?)\s*\$?\d+(?:\.\d+)?)/i;
  const explicitEntry = /\b(?:bto|buying|bought|opening|opened|entering|entered|starter|starting|new\s+entry)\b|\b(?:buy|open|long|short)\s+\$?[A-Z][A-Z0-9.-]{0,14}\b|\bentry\s*(?:[:@-]|\$?\d)/i;
  return performanceMarker.test(currentContent) && !explicitEntry.test(currentContent);
}

function parseRowdyLottoSignal(message: SignalMessageInput): ExtractionResponse["signals"][number] | null {
  if (!isRowdyMessage(message)) {
    return null;
  }

  const currentContent = message.content.split(/\n\n(?=\[REPLY CONTEXT(?: |\]))/)[0] ?? message.content;
  const cleaned = currentContent
    .replace(/<@&\d+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const match = /\b(?:eod\s+)?(?:light\s+size\s+|small\s+size\s+)?(?:lotto\s+)?(\d{2,5})\s*([CP])\s*@\s*(\$?\d+(?:\.\d+)?)/i.exec(cleaned);
  if (!match || /%|trim|trimmed|took|closed|loss|bag|bagg|gain|gainer|runner|runners|sold|sell/i.test(cleaned)) {
    return null;
  }

  const [, rawStrike, rawSide, rawPrice] = match;
  const strike = Number(rawStrike);
  const optionPrice = normalizeRowdyPrice(rawPrice);
  if (!Number.isFinite(strike) || optionPrice === null) {
    return null;
  }

  const expiration = message.signalTime.slice(0, 10);
  const side = rawSide.toUpperCase() === "C" ? "call" : "put";
  const sideCode = side === "call" ? "C" : "P";
  return {
    kind: "option_entry",
    ticker: "SPY",
    underlyingTicker: "SPY",
    contractTicker: `O:SPY${optionExpirationCode(expiration)}${sideCode}${strikeCode(strike)}`,
    tickerResolution: {
      method: "manual",
      confidence: 0.88,
      notes: ["Rowdy lotto shorthand defaults to SPY same-day option."]
    },
    expiration,
    expirationRaw: "same-day",
    strike,
    side,
    optionPrice,
    positionSize: /\blight size\b|\bsmall size\b/i.test(cleaned) ? "small" : null,
    riskNotes: ["lotto"],
    extra: {
      parser: "rowdy_lotto_shorthand"
    }
  };
}

function isRowdyMessage(message: SignalMessageInput): boolean {
  return message.routeName === "rowdy-vip";
}

function normalizeRowdyPrice(rawPrice: string): number | null {
  const numeric = Number(rawPrice.replace(/^\$/, ""));
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  const price = numeric >= 10 ? numeric / 100 : numeric;
  return Math.round((price + Number.EPSILON) * 100) / 100;
}

function optionExpirationCode(expiration: string): string {
  const [year, month, day] = expiration.split("-");
  return `${year.slice(2)}${month}${day}`;
}

function strikeCode(strike: number): string {
  return String(Math.round(strike * 1000)).padStart(8, "0");
}

function errorType(error: unknown): string {
  if (error instanceof ExtractionValidationError) {
    return "schema_validation";
  }
  if (error instanceof SyntaxError) {
    return "json_parse";
  }
  if (error instanceof Error) {
    return error.name || "api_error";
  }
  return "unknown";
}

function errorMessage(error: unknown): string {
  if (error instanceof ExtractionValidationError) {
    return error.diagnostic;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
