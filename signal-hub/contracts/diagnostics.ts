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
