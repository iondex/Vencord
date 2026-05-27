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

The plugin settings page includes a health check button for this endpoint and runtime-only counters for forwarded, failed, and skipped notifications.

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
