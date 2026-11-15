export type SourceMeta = {
  plugin: string;
  client: string;
  kind: string;
};

export type NotificationPayload = {
  title: string;
  body: string;
};

export type Channel = {
  id: string;
  name: string;
  type?: number;
  serverId?: string;
  guildId?: string;
  guild_id?: string;
};

export type Server = {
  id: string;
  name: string;
};

export type User = {
  id: string;
  username: string;
  globalName: string;
  bot: boolean;
};

export type Attachment = {
  id: string;
  filename: string;
  url: string;
  proxy_url?: string;
  proxyUrl?: string;
  content_type?: string;
  contentType?: string;
  size: number;
  width: number;
  height: number;
  download?: {
    strategy: string;
    url: string;
  };
};

export type MessageEmbed = Record<string, unknown>;

export type Message = {
  id: string;
  channelId?: string;
  channel_id?: string;
  serverId?: string;
  guildId?: string;
  guild_id?: string;
  content: string;
  timestamp: string;
  author: User | null;
  attachments: Attachment[];
  embeds?: MessageEmbed[];
  components?: unknown[];
  referencedMessage?: Message | null;
  referenced_message?: Message | null;
};

export type Payload = {
  source: SourceMeta;
  notification: NotificationPayload;
  metadata: {
    channel?: Channel;
    server?: Server;
    guild?: Server;
  };
  message: Message | null;
};

export type SafetyDecision = {
  allowed: boolean;
  reason?: string;
};

export type RouteRule = {
  routeId: string;
  name: string;
  enabled: boolean;
  serverId: string;
  channelId: string;
  senderId: string;
  targetChannelId: string;
  filters: string[];
  replacements: ReplacementRule[];
  filterChinese: boolean;
  forwardImages: boolean;
  note: string;
  createdAt: string;
  updatedAt: string;
};

export type RouteRuleInput = {
  routeId?: string;
  name: string;
  enabled?: boolean;
  serverId: string;
  channelId?: string;
  senderId?: string;
  targetChannelId: string;
  filters?: string[];
  replacements?: ReplacementRule[];
  filterChinese?: boolean;
  forwardImages?: boolean;
  note?: string;
};

export type RouteRulePage = {
  routes: RouteRule[];
  total: number;
};

export type RouteTarget = {
  sink: "discord";
  routeId: string;
  routeName: string;
  targetChannelId: string;
};

export type ReplacementRule = {
  find: string;
  replaceWith: string;
  caseSensitive: boolean;
};

export type TargetChannelProfile = {
  targetChannelId: string;
  displayName: string;
  avatarUrl: string;
  webhookId: string;
  webhookToken: string;
  createdAt: string;
  updatedAt: string;
};

export type TargetChannelProfileInput = {
  targetChannelId: string;
  displayName?: string;
  avatarUrl?: string;
};

export type TargetChannelProfilePublic = Omit<TargetChannelProfile, "webhookId" | "webhookToken">;

export type MessageRecord = {
  id: number;
  messageId: string;
  content: string;
};

export type SinkResult = {
  status: "delivered" | "failed" | "skipped" | "disabled";
  attempts: number;
  providerMessageId?: string;
  error?: string;
  responseStatusCode?: number;
};

export type SinkDeliveryRecord = {
  messageRowId: number;
  sink: string;
  routeId?: string;
  routeName: string;
  targetChannelId: string;
  status: string;
  attempts: number;
  providerMessageId: string;
  error: string;
  responseStatusCode: number;
};

export type SinkDeliveryView = SinkDeliveryRecord & {
  id: number;
  createdAt: string;
};

export type AttachmentDownloadRecord = {
  messageRowId: number;
  attachmentId: string;
  filename: string;
  url: string;
  contentType: string;
  declaredSize: number;
  downloadedSize: number;
  status: "saved" | "failed" | "skipped";
  error: string;
};

export type AttachmentDownloadView = AttachmentDownloadRecord & {
  id: number;
  createdAt: string;
};

export type SignalExtractionStatus = "processing" | "success" | "failed";
export type SignalExtractionKind = "" | "signal" | "irrelevant";

export type SignalExtractionFilters = {
  status?: SignalExtractionStatus;
  kind?: Exclude<SignalExtractionKind, "">;
  routeId?: string;
};

export type SignalExtractionRecord = {
  messageRowId: number;
  sourceRouteId: string;
  sourceRouteName: string;
  provider: string;
  model: string;
  status: SignalExtractionStatus;
  kind: string;
  reason: string;
  signalsJson: string;
  attempts: number;
  error: string;
};

export type SignalExtractionView = {
  id: number;
  messageRowId: number;
  messageId: string;
  sourceRouteId: string;
  sourceRouteName: string;
  provider: string;
  model: string;
  status: SignalExtractionStatus;
  kind: SignalExtractionKind;
  reason: string;
  signalsJson: string;
  attempts: number;
  error: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type SignalRouteConfig = {
  routeId: string;
  enabled: boolean;
  tickerWhitelistEnabled: boolean;
  tickerWhitelist: string[];
};

export type SignalConfig = {
  enabled: boolean;
  providerBaseUrl: string;
  model: string;
  targetChannelId: string;
  indexTargetChannelId: string;
  timeoutMs: number;
  routeIds: string[];
  routes: SignalRouteConfig[];
  updatedAt: string;
};

export type SignalConfigInput = Omit<SignalConfig, "updatedAt" | "routes"> & { routes?: SignalRouteConfig[] };
