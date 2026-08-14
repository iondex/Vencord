# Forwarder Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded retries, fallback delivery, detailed failure diagnostics, optional DingTalk alerts, independent endpoint health checks, and resettable runtime statistics to the desktop forwarder plugin.

**Architecture:** Keep notification selection and payload construction in `index.tsx`, while `native.ts` owns network execution and returns structured attempt diagnostics. Pure retry entry points accept injected `fetch`, `sleep`, and clock dependencies so regression tests remain deterministic and offline.

**Tech Stack:** TypeScript, Electron native plugin helpers, browser-compatible Fetch API, React/Vencord settings components, Node `assert` tests executed with `tsx`.

---

## File Map

- Modify `src/plugins/forwarder.desktop/native.ts`: define request/result diagnostics, serialize nested errors, redact secrets, execute retries and fallback, and send a single DingTalk alert.
- Modify `src/plugins/forwarder.desktop/logic.ts`: add runtime-statistics reset behavior while retaining notification filtering and health URL construction.
- Modify `src/plugins/forwarder.desktop/index.tsx`: add settings, call the resilient native API, replace the test-payload action with two health controls, and add clear-stats behavior.
- Modify `src/plugins/forwarder.desktop/logic.test.ts`: cover complete statistics reset alongside existing logic.
- Create `src/plugins/forwarder.desktop/native.test.ts`: cover retry timing, fallback selection, detailed causes, redaction, and alert behavior using injected dependencies.
- Modify `src/plugins/forwarder.desktop/README.md`: document settings, retry limits, diagnostics, alert privacy, health controls, and request limits.

### Task 1: Native retry and diagnostics engine

**Files:**
- Modify: `src/plugins/forwarder.desktop/native.ts`

- [ ] **Step 1: Define the resilient request contract**

Add exported `ForwardRequest`, `ForwardContext`, `AttemptDiagnostic`, and extended `ForwardResult` interfaces. `ForwardRequest` contains `primaryUrl`, `fallbackUrl`, `dingTalk` (`enabled` and `webhookUrl`), `payload`, and safe Discord identifiers. Keep `ok`, `status`, and `body` on `ForwardResult` for compatibility.

- [ ] **Step 2: Add bounded diagnostic helpers**

Implement `redactUrl()`, `serializeError()`, `classifyFailure()`, and bounded diagnostic helpers. Recursively walk `cause` with cycle/depth limits; retain `name`, `message`, `code`, `errno`, `syscall`, `hostname`, `address`, `port`, and bounded stack text. Replace sensitive query values (`access_token`, `token`, `key`, `secret`) with `[REDACTED]`. Do not retain failed response bodies because an endpoint can echo private payload data.

- [ ] **Step 3: Implement endpoint attempts**

Add `sendWithResilience(request, dependencies)` with injectable `fetch`, `sleep`, and `now`. Serialize the payload once, validate HTTP(S) endpoints, and execute at most five attempts with delays `[1000, 2000, 4000, 5000]`. Record role, redacted URL, attempt, duration, status/status text, response excerpt, retry header, category, and nested error details.

- [ ] **Step 4: Implement fallback selection**

Attempt fallback only after primary exhaustion. Skip an empty fallback and skip a fallback whose normalized URL equals the primary. Return immediately on the first success and set `usedFallback` only when fallback succeeds.

- [ ] **Step 5: Implement one-shot DingTalk alerting**

After total failure, post a single `{ msgtype: "text", text: { content } }` request when enabled and the webhook is a valid HTTP(S) URL. Begin content with `Discord forwarder failure`, include safe context, one concise final-attempt root cause, and identical failure reasons aggregated across primary and fallback with occurrence counts. Exclude endpoint URLs, per-attempt repetition, message content, and payload data. Capture and locally log alert failures without changing the original result or sending another alert.

- [ ] **Step 6: Keep native IPC exports thin**

Have exported `send(event, request)` delegate to `sendWithResilience()` using real dependencies. Enhance `get(event, url)` to return one detailed health result with elapsed time but no retry, fallback, statistics, or alert behavior.

### Task 2: Renderer settings and behavior

**Files:**
- Modify: `src/plugins/forwarder.desktop/index.tsx`
- Modify: `src/plugins/forwarder.desktop/logic.ts`

- [ ] **Step 1: Add settings defaults**

Add `fallbackUrl` with `https://forwarder.yufeng.run/forward`, `enableDingTalkAlerts` with `true`, and `dingTalkWebhookUrl` with the approved webhook. Render the webhook as a normal string input and disable it when alerts are off.

- [ ] **Step 2: Use the resilient send request**

Replace `Native.send(serverUrl, payload)` with one request containing the primary URL, fallback URL, alert options, payload, and only message/channel/guild identifiers. Record statistics once from the final result and log `errorSummary` plus structured attempts on failure.

- [ ] **Step 3: Add statistics reset**

Extend `ForwarderStats` with `reset(): void`, resetting every counter to zero in place. Wire a `Clear stats` button that resets and immediately updates the React snapshot; retain `Refresh stats`.

- [ ] **Step 4: Replace test sending with independent health checks**

Delete `sendTestPayload`, its state, handler, and button. Maintain separate primary and fallback health states and buttons. Each button derives `/healthz` from its own configured URL and calls `Native.get` once. Disable fallback health when no fallback is configured and display `Not configured`.

### Task 3: Regression coverage

**Files:**
- Modify: `src/plugins/forwarder.desktop/logic.test.ts`
- Create: `src/plugins/forwarder.desktop/native.test.ts`

- [ ] **Step 1: Cover statistics reset**

Populate every counter, call `reset()`, and assert the complete zero snapshot while retaining existing filtering and URL tests.

- [ ] **Step 2: Cover retry and fallback behavior**

Use a queued fake fetch plus captured sleep values to assert first-attempt success, primary recovery, exact `[1000, 2000, 4000, 5000]` delays, five-attempt limits, fallback success, total failure, empty fallback, duplicate fallback, and permanent invalid-URL handling.

- [ ] **Step 3: Cover detailed errors and privacy**

Reject fetch with `new TypeError("fetch failed", { cause })`, where the cause includes `ECONNREFUSED`, syscall, address, and port. Assert those fields appear in diagnostics while webhook tokens and Discord content do not. Assert long response bodies/stacks are bounded.

- [ ] **Step 4: Cover DingTalk behavior**

Assert exactly one DingTalk POST after total failure, no alert after recovery or when disabled, required `Discord` keyword, correct JSON shape, no primary/fallback URLs, concise final root cause, cross-endpoint reason aggregation with counts, no repeated attempt lines, and an unchanged forwarding failure when the alert request itself rejects.

- [ ] **Step 5: Run focused tests**

Run:

```sh
pnpm exec tsx src/plugins/forwarder.desktop/logic.test.ts
pnpm exec tsx src/plugins/forwarder.desktop/native.test.ts
```

Expected: both commands exit 0 with no assertion errors or network access.

### Task 4: Documentation and verification

**Files:**
- Modify: `src/plugins/forwarder.desktop/README.md`

- [ ] **Step 1: Update operator documentation**

Document the primary/fallback defaults, total five-attempt policy, 1/2/4/5 second waits, maximum ten forward requests, detailed error categories, redaction/privacy behavior, one-shot DingTalk alert, independent health checks, removal of test payloads, and stats reset.

- [ ] **Step 2: Run static verification**

Run:

```sh
pnpm exec eslint src/plugins/forwarder.desktop
pnpm testTsc
pnpm buildStandalone
```

Expected: each command exits 0. Any repository-wide pre-existing failure must be reported with its exact output and separated from failures introduced by this change.

- [ ] **Step 3: Inspect the final diff**

Run `git diff --check`, `git status --short`, and `git diff --stat`. Confirm only the plan, approved forwarder files, and their tests/documentation changed; preserve the user's existing untracked `data/` directory.
