import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { test } from "node:test";

import { getGlobalDispatcher, setGlobalDispatcher } from "undici";

import { configureNetwork, discordNetworkFailure } from "../src/network.js";

test("native fetch honors the configured HTTP proxy and always bypasses loopback", async context => {
    const previous = getGlobalDispatcher();
    const target = createServer((_request, response) => { response.end("connected"); });
    const proxy = createServer();
    const connections: string[] = [];
    const sockets = new Set<Duplex>();
    let network: ReturnType<typeof configureNetwork> = undefined;
    context.after(async () => {
        setGlobalDispatcher(previous);
        for (const socket of sockets) socket.destroy();
        await network?.close();
        await Promise.all([target, proxy].map(server => new Promise<void>(done => server.close(() => done()))));
    });
    target.listen(0, "127.0.0.1");
    proxy.listen(0, "127.0.0.1");
    await Promise.all([once(target, "listening"), once(proxy, "listening")]);
    const targetPort = (target.address() as any).port;
    const proxyPort = (proxy.address() as any).port;
    proxy.on("connect", (request, socket, head) => {
        connections.push(request.url ?? "");
        const upstream = connect(targetPort, "127.0.0.1", () => {
            socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length) upstream.write(head);
            socket.pipe(upstream);
            upstream.pipe(socket);
        });
        sockets.add(socket);
        sockets.add(upstream);
        socket.on("error", () => upstream.destroy());
        upstream.on("error", () => socket.destroy());
    });
    network = configureNetwork({ HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, HTTPS_PROXY: "", NO_PROXY: "" });
    const external = await fetch(`http://signal-hub-proxy.invalid:${targetPort}/`, { signal: AbortSignal.timeout(3000) });
    assert.equal(await external.text(), "connected");
    assert.deepEqual(connections, [`signal-hub-proxy.invalid:${targetPort}`]);
    const local = await fetch(`http://127.0.0.1:${targetPort}/`, { signal: AbortSignal.timeout(3000) });
    assert.equal(await local.text(), "connected");
    assert.equal(connections.length, 1, "Local API traffic must not go through the external proxy");
});

test("no proxy configuration preserves the current dispatcher and malformed proxy credentials are redacted", () => {
    const previous = getGlobalDispatcher();
    assert.equal(configureNetwork({}), undefined);
    assert.equal(getGlobalDispatcher(), previous);
    assert.throws(() => configureNetwork({ HTTPS_PROXY: "http://username:secret@" }), { message: "Invalid HTTP_PROXY or HTTPS_PROXY configuration" });
    assert.equal(getGlobalDispatcher(), previous);
});

test("network classification handles aggregate connection errors and keeps unknown failures private", () => {
    const failure = new TypeError("sensitive URL", { cause: new AggregateError([
        Object.assign(new Error("sensitive URL"), { code: "ECONNREFUSED" }),
        Object.assign(new Error("sensitive URL"), { code: "ENETUNREACH" }),
    ]) });
    assert.equal(discordNetworkFailure(failure), "discord_connection_failed");
    assert.equal(discordNetworkFailure(new Error("sensitive URL")), undefined);
});
