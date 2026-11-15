import { z } from "zod";

import type { Message, Payload } from "./types.js";

const optionalString = z.string().optional();
const requiredString = z.string().default("");
const recordSchema = z.object({}).catchall(z.unknown());

const userSchema = z.object({
  id: requiredString,
  username: requiredString,
  globalName: requiredString,
  bot: z.boolean().default(false)
}).passthrough();

const attachmentSchema = z.object({
  id: requiredString,
  filename: requiredString,
  url: requiredString,
  proxy_url: optionalString,
  proxyUrl: optionalString,
  content_type: optionalString,
  contentType: optionalString,
  size: z.number().nonnegative().default(0),
  width: z.number().nullable().optional().transform(value => value ?? 0),
  height: z.number().nullable().optional().transform(value => value ?? 0),
  download: z.object({
    strategy: requiredString,
    url: requiredString
  }).passthrough().optional()
}).passthrough();

const messageSchema: z.ZodType<Message> = z.lazy(() => z.object({
  id: requiredString,
  channelId: optionalString,
  channel_id: optionalString,
  serverId: optionalString,
  guildId: optionalString,
  guild_id: optionalString,
  content: requiredString,
  timestamp: requiredString,
  author: userSchema.nullable().default(null),
  attachments: z.array(attachmentSchema).default([]),
  embeds: z.array(recordSchema).default([]),
  referencedMessage: messageSchema.nullable().optional(),
  referenced_message: messageSchema.nullable().optional()
}).passthrough()) as z.ZodType<Message>;

const channelSchema = z.object({
  id: requiredString,
  name: requiredString,
  type: z.number().optional(),
  serverId: optionalString,
  guildId: optionalString,
  guild_id: optionalString
}).passthrough();

const guildSchema = z.object({
  id: requiredString,
  name: requiredString
}).passthrough();

export const forwarderPayloadSchema = z.object({
  source: z.object({
    plugin: requiredString,
    client: requiredString,
    kind: requiredString
  }).passthrough().default({ plugin: "", client: "", kind: "" }),
  forwardedAt: optionalString,
  notification: z.object({
    title: requiredString,
    body: requiredString
  }).passthrough(),
  metadata: z.object({
    channel: channelSchema.optional(),
    server: guildSchema.optional(),
    guild: guildSchema.nullable().optional()
  }).passthrough().default({}),
  message: messageSchema.nullable()
}).passthrough();

export function parseForwarderPayload(value: unknown): Payload {
  const parsed = forwarderPayloadSchema.parse(value);
  return {
    source: parsed.source,
    notification: parsed.notification,
    metadata: {
      channel: parsed.metadata.channel,
      server: parsed.metadata.server,
      guild: parsed.metadata.guild ?? undefined
    },
    message: parsed.message
  };
}

export type ForwarderPayload = z.infer<typeof forwarderPayloadSchema>;
