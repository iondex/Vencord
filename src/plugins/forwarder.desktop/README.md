# forwarder

Forwards Discord messages that pass Discord's notification rules to an HTTP endpoint.

The default endpoint is:

```text
http://127.0.0.1:49321/forward
```

Run the receiver from the repository root with:

```sh
cd signal-hub
cp config.example.toml config.toml
go run ./cmd/forwarder-server --config config.toml
```

Its health check is available at:

```text
http://127.0.0.1:49321/healthz
```

## Delivery resilience

The plugin retries each configured endpoint at most five times total. After failed attempts it waits 1, 2, 4, and 5 seconds before the next attempt. HTTP error responses and network failures are retried; invalid URLs and unsupported protocols are reported immediately without redundant attempts.

The default fallback endpoint is:

```text
https://forwarder.yufeng.run/forward
```

Fallback delivery starts only after the primary endpoint is exhausted and uses the same five-attempt policy. A successful request stops the sequence immediately. With both endpoints enabled, one notification can produce at most ten forwarding requests.

Failure reports include the endpoint, attempt number, duration, HTTP status, response length, selected safe headers, or the nested network cause exposed by Node.js/Undici. Error response bodies are intentionally excluded because an endpoint could echo private Discord content. Common details such as `ENOTFOUND`, `EAI_AGAIN`, `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, TLS errors, syscall, hostname, address, and port are retained instead of reporting only `fetch failed`. Each network request has a 30-second timeout so a stalled endpoint cannot permanently block retries or fallback.

## DingTalk failure alerts

DingTalk alerts are enabled by default and can be disabled or pointed at a different robot webhook in plugin settings. The webhook input is visually masked, although Vencord still stores its value in the local settings file.

One text alert is sent only when every configured forwarding endpoint has failed. It begins with the required `Discord` keyword and contains bounded attempt diagnostics plus message, channel, and guild identifiers. It does not include Discord message content, the forwarded payload, attachment URLs, or webhook credentials. Sensitive URL query values such as `access_token`, `token`, `key`, and `secret` are redacted.

An alert-delivery failure is logged locally and never triggers another alert or replaces the original forwarding result.

## Plugin controls

The settings page provides independent health checks for the primary and fallback endpoints. Each performs one GET request against that endpoint's `/healthz` URL; health checks do not retry, switch endpoints, send alerts, or affect forwarding statistics.

`Refresh stats` reads the current plugin-session counters. `Clear stats` resets forwarded, failed, and all skipped counters. The previous test-payload action has been removed so health verification cannot insert synthetic messages downstream.

## Attachment handling

The plugin does not inline images or other attachments into the forwarded JSON. For each Discord attachment it sends:

```json
{
  "id": "attachment id",
  "filename": "image.png",
  "size": 12345,
  "contentType": "image/png",
  "url": "original Discord CDN URL",
  "proxyUrl": "Discord media proxy URL",
  "download": {
    "strategy": "server-fetch",
    "url": "preferred URL for the server to download",
    "sourceField": "proxy_url"
  },
  "raw": {}
}
```

The server downloads attachments itself, preferring `download.url`, then `proxyUrl`, then `url`. The SQLite sink is always enabled and stores the full payload plus attachment bytes in the database.

The plugin settings page includes separate health checks for the primary and fallback endpoints and runtime-only counters for forwarded, failed, and skipped notifications.

## Server configuration

All server configuration is TOML. See `signal-hub/config.example.toml`.

```toml
[server]
address = "127.0.0.1:49321"
max_body_bytes = 2097152

[database]
path = "forwarder.sqlite3"

[attachments]
timeout = "30s"
max_bytes = 52428800

[[filters.channels]]
channel_id = "TARGET_SOURCE_CHANNEL_ID"
sender_ids = ["ALLOWED_SENDER_ID"]

[discord]
enabled = false
bot_token = ""
channel_id = ""
api_base_url = "https://discord.com/api/v10"
timeout = "30s"
max_retries = 3
request_interval = "1s"
```

## Message filters

Filters are optional. DM, group DM, DM SDK, friend request, and other non-guild notification payloads are ignored before persistence or sink delivery. If no `[[filters.channels]]` entries are configured, all guild notification messages enter the sink flow.

Once any channel filter is configured, only messages from enabled source channels are accepted. If `sender_ids` is non-empty for that channel, the message author must also match one of those sender ids. Filtered messages return `202` with `status: "filtered"`, write a `[FORWARDER_FILTERED]` log line, and do not enter SQLite or Discord sinks.

Example:

```toml
[[filters.channels]]
channel_id = "1508349750590701611"
sender_ids = ["123456789012345678"]
```

## SQLite storage

The receiver writes all accepted messages into SQLite:

- `messages`: message metadata plus complete pretty-printed forwarded JSON.
- `attachments`: one row per attachment, including status and the downloaded attachment blob.
- `sink_deliveries`: optional downstream sink delivery results, currently Discord bot forwarding.

`/forward` returns success after SQLite persistence. Discord delivery is optional and a Discord failure is recorded in `sink_deliveries` without discarding the stored message.

## Discord bot sink

To enable bot forwarding, invite your bot to the target server, then set:

```toml
[discord]
enabled = true
bot_token = "YOUR_BOT_TOKEN"
channel_id = "TARGET_CHANNEL_ID"
```

The sink sends messages with `POST /channels/{channel_id}/messages` using the bot token. Attachments are uploaded as Discord multipart files with `payload_json` plus `files[n]`. Image attachments are referenced from the embed as `attachment://filename` so they render inline in Discord.

Rate limiting is handled by retrying `429` responses using Discord's `Retry-After` header or JSON `retry_after` value. `max_retries` and `request_interval` provide local backoff control.

Run the server tests with:

```sh
cd signal-hub
go test ./...
```

Run the optional Discord API connectivity test with:

```sh
go test -tags=integration ./tests -run TestDiscordAPIConnectivity -v
```
