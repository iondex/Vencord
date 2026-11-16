import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

export function configureNetwork(environment = process.env) {
    const httpProxy = environment.http_proxy ?? environment.HTTP_PROXY ?? "";
    const httpsProxy = environment.https_proxy ?? environment.HTTPS_PROXY ?? "";
    if (!httpProxy && !httpsProxy) return;
    let agent: EnvHttpProxyAgent;
    try {
        agent = new EnvHttpProxyAgent({
            httpProxy, httpsProxy,
            noProxy: ["localhost", "127.0.0.1", "[::1]", environment.no_proxy ?? environment.NO_PROXY ?? ""].join(","),
        });
    } catch { throw new Error("Invalid HTTP_PROXY or HTTPS_PROXY configuration"); }
    setGlobalDispatcher(agent);
    return agent;
}

export function discordNetworkFailure(error: unknown) {
    const causes: unknown[] = [error, error instanceof Error ? error.cause : undefined];
    if (causes[1] instanceof AggregateError) causes.push(...causes[1].errors);
    const codes = causes.flatMap(cause => cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string" ? [cause.code] : []);
    if ((error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))
        || codes.some(code => ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(code))) return "discord_request_timeout";
    if (codes.some(code => code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_")
        || ["CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UND_ERR_PRX_TLS"].includes(code))) return "discord_tls_failed";
    if (codes.some(code => ["ENOTFOUND", "EAI_AGAIN"].includes(code))) return "discord_dns_failed";
    if (codes.some(code => ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_SOCKET"].includes(code))) return "discord_connection_failed";
}
