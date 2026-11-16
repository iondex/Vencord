export interface LocalRoute {
    routeId: string;
    name: string;
    enabled: boolean;
    serverId: string;
    targetChannelId: string;
    excluded: boolean;
}

export interface LocalServiceStatus {
    service: "signal-hub";
    protocol: 2;
    paused: boolean;
    testMode?: boolean;
    configSyncedAt: string | null;
    routes: LocalRoute[];
    jobs: { state: string; total: number; }[];
    statistics?: LocalServiceStatistics;
    dashboardPort?: number;
}

export interface LocalServiceStatistics {
    messages: number;
    receipts: number;
    delivered: number;
    capturedLastHour: number;
    deliveredLastHour: number;
    queued: number;
    oldestPendingAt: number | null;
    lastCapturedAt: number | null;
    lastDeliveredAt: number | null;
    successRate24h: number | null;
}

export interface LocalRouteTest {
    requestId: string;
    jobId: string;
    routeId: string;
    targetChannelId: string;
    state: string;
    attempts: number;
    error: string;
    dueAt: number;
}
