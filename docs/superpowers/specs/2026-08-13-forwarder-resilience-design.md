# Forwarder Resilience Design

## Goal

Improve the desktop forwarder plugin's reliability and diagnostics without changing which Discord notifications qualify for forwarding.

The plugin will:

- report useful root causes instead of only `fetch failed`;
- retry a primary endpoint with bounded exponential backoff;
- fall back to a separately configurable endpoint;
- optionally send one detailed DingTalk alert after both endpoints fail;
- expose independent health checks for the primary and fallback endpoints;
- allow session statistics to be refreshed or cleared.

## Scope

This change is limited to `src/plugins/forwarder.desktop` and its documentation and tests. It does not change the signal-hub server, Discord notification eligibility rules, payload schema, or persistent server-side data.

The existing test-payload action will be removed. Health checks do not forward data.

## Configuration

The plugin keeps the existing settings and adds:

- `fallbackUrl`: defaults to `https://forwarder.yufeng.run/forward`. An empty value disables fallback.
- `enableDingTalkAlerts`: defaults to `true`.
- `dingTalkWebhookUrl`: defaults to the supplied DingTalk robot URL and is shown as a normal text field in settings.

The DingTalk webhook remains present in Vencord's locally persisted settings because the current settings system has no separate secret store for plugin options. Logs, results, health displays, and DingTalk messages must redact sensitive query values such as `access_token`, `token`, and `key`.

## Architecture

The renderer continues to decide whether a Discord message qualifies and to construct its payload. The native Electron side owns all network behavior:

- URL validation;
- JSON serialization;
- HTTP execution;
- retry delays;
- fallback selection;
- attempt diagnostics;
- DingTalk alert delivery.

This keeps the retry state in one process and avoids repeated renderer-to-native IPC calls. The renderer passes the primary URL, fallback URL, DingTalk configuration, and payload in one call.

The native result preserves the existing `ok`, `status`, and `body` fields and adds structured attempt data, whether fallback was used, and a final diagnostic summary. Existing health-check callers remain compatible.

## Forwarding Flow

For each eligible Discord notification:

1. Validate and serialize the payload before starting network requests.
2. Attempt the primary endpoint at most five times total.
3. After failed attempts 1 through 4, wait 1, 2, 4, and 5 seconds respectively.
4. Stop immediately when an attempt succeeds.
5. If the primary exhausts its attempts and fallback is configured, repeat the same five-attempt policy for fallback.
6. If fallback succeeds, return success and mark that fallback was used.
7. If all configured endpoints fail, return one final failure and optionally send one DingTalk alert.

HTTP non-2xx responses and network exceptions are failures. An invalid URL or unsupported protocol is a permanent configuration error and is recorded once without performing redundant retries for that endpoint. If primary and fallback resolve to the same normalized URL, the fallback phase is skipped to avoid duplicate attempts.

Each Discord message increments runtime statistics once: success after either endpoint increments `forwarded`; total failure increments `failed`. Individual attempts do not affect the counters.

At the configured defaults, a single failed forward can make at most ten forwarding requests: five to primary and five to fallback. DingTalk delivery is a separate, single request.

## Error Diagnostics

Every attempt records:

- endpoint role and redacted URL;
- attempt number and maximum attempts;
- elapsed time;
- failure category;
- HTTP status and status text when available;
- the response length, without retaining error response bodies that could echo private payload data;
- selected diagnostic response headers such as `Retry-After`;
- serialized error and nested `cause` information.

Error serialization recursively extracts safe diagnostic fields including `name`, `message`, `code`, `errno`, `syscall`, `hostname`, `address`, `port`, and `stack`. It recognizes common categories:

- DNS resolution, including `ENOTFOUND` and `EAI_AGAIN`;
- connection failures, including `ECONNREFUSED`, `ECONNRESET`, and `ETIMEDOUT`;
- TLS and certificate validation failures;
- invalid URLs and unsupported protocols;
- payload serialization failures;
- HTTP response failures;
- unknown exceptions.

Response bodies and stack traces have size limits. Diagnostics do not include the forwarded Discord message content or the full payload.

## DingTalk Alerting

An alert is sent only after primary and fallback have both failed or all configured endpoints have otherwise been exhausted. Transient failures that recover do not alert.

The alert uses DingTalk's text message format and begins with the required keyword `Discord`, for example `Discord forwarder failure`. It contains:

- timestamp;
- Discord message, channel, and guild identifiers when available;
- one concise `rootCause` derived from the final attempt;
- an aggregated reason list that combines identical failures across primary and fallback attempts and displays each reason once with its occurrence count.

The DingTalk alert does not identify primary or fallback URLs and does not list every retry separately. For example, five identical primary failures and five identical fallback failures appear as one reason with `× 10`. The local console result retains per-attempt structured diagnostics.

It does not contain Discord message text, attachment URLs, payload bodies, or webhook credentials.

DingTalk delivery is never recursive. If the alert request fails, the plugin logs a detailed local error and returns the original forwarding failure unchanged.

## Health Checks and Settings UI

The existing test-payload action and implementation are removed.

The settings panel provides:

- `Check primary health`;
- `Check fallback health`;
- `Refresh stats`;
- `Clear stats`.

Primary and fallback health checks are independent. Each converts its own configured forward URL to `/healthz`, performs one GET request, and displays its own status, response excerpt, elapsed time, or detailed network error. Health checks do not retry, switch endpoints, send DingTalk alerts, or affect forwarding statistics.

The fallback health button is disabled and reports `Not configured` when the fallback URL is empty.

`Refresh stats` reads the current in-memory counters. `Clear stats` resets forwarded, failed, and all filtered counters to zero and immediately refreshes the display. It does not alter plugin settings or server-side data.

## Testing Strategy

Tests use injected `fetch` and `sleep` functions so they never contact the configured endpoints and do not wait in real time.

Coverage includes:

- success on the first primary attempt;
- recovery during primary retries;
- exact 1, 2, 4, and 5 second delay sequence;
- no more than five attempts per endpoint;
- primary exhaustion followed by fallback success;
- primary and fallback exhaustion;
- no fallback when it is empty or duplicates primary;
- permanent URL validation failures without redundant retries;
- HTTP and nested network-cause diagnostics;
- bounded response bodies and stacks;
- sensitive query-parameter redaction;
- one DingTalk alert only after total failure;
- DingTalk reason aggregation across primary and fallback attempts;
- concise final-attempt root cause without endpoint URLs or per-attempt repetition;
- no alert after recovery or when alerting is disabled;
- DingTalk failure leaving the forwarding result intact;
- independent primary and fallback health URL handling;
- statistics counted once per notification;
- complete statistics reset;
- preservation of existing notification-filter behavior.

Implementation follows red-green-refactor: each new behavior receives a failing test before production code changes.

## Acceptance Criteria

- A refused local connection reports `ECONNREFUSED` details rather than only `fetch failed` when the runtime exposes that cause.
- Each valid endpoint receives no more than five forwarding attempts.
- Retry waits are capped at five seconds.
- Fallback begins only after primary failure and stops immediately on success.
- One total failure produces at most one DingTalk alert containing the keyword `Discord`.
- No sensitive webhook query values or Discord message content appear in diagnostics.
- Health checks independently identify the endpoint tested and do not trigger forwarding side effects.
- The test-payload action no longer exists.
- Runtime counters can be refreshed and cleared.
- Focused tests, TypeScript checks, lint checks, and the relevant build complete successfully.
