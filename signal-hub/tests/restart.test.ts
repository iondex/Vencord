import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openStore } from "../src/storage.js";

test("sender identity and unresolved send survive closing, consistent backup and restoring", context => {
    const directory = mkdtempSync(join(tmpdir(), "hub-restart-"));
    let store = openStore(join(directory, "live.sqlite3"));
    context.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
    store.db.prepare("INSERT INTO sender_history VALUES('bot:8','5','','2',?)").run(Date.now());
    store.db.prepare("INSERT INTO sink_deliveries VALUES('key','job','bot:8','5','nonce','uncertain','',?,?)").run(Date.now(), Date.now());
    const backup = join(directory, "backup.sqlite3");
    store.db.prepare("VACUUM INTO ?").run(backup);
    store.close();
    store = openStore(backup);
    assert.equal((store.db.prepare("PRAGMA integrity_check").get() as any).integrity_check, "ok");
    assert.equal(store.ownOutput({
        schemaVersion: 2, eventId: "replay", eventType: "RECOVERY", accountId: "1", serverId: "2", channelId: "5", excludedServerIds: [],
        capturedAt: new Date().toISOString(), message: { id: "9", author: { id: "8" }, nonce: "nonce" },
    }), "self_generated");
    assert.equal((store.db.prepare("SELECT state FROM sink_deliveries").get() as any).state, "uncertain");
});

test("delivery audit migration preserves existing jobs and repair counters across restart", context => {
    const directory = mkdtempSync(join(tmpdir(), "hub-migration-"));
    const path = join(directory, "hub.sqlite3");
    let store = openStore(path);
    context.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
    const event = { schemaVersion: 2 as const, eventId: "before-audit", eventType: "MESSAGE_CREATE" as const,
        capturedAt: new Date().toISOString(), accountId: "1", serverId: "2", channelId: "3", excludedServerIds: [], message: { id: "4" } };
    store.ingest(event, JSON.stringify(event));
    const id = store.enqueue("discord:2:3:4", "deliver", "route", "5", 0, { content: "saved" }, "snapshot");
    store.db.prepare("UPDATE jobs SET state='retry_wait',retry_count=6,recovery_cycles=2,due_at=0 WHERE id=?").run(id);
    store.db.prepare("DELETE FROM schema_version WHERE version=2").run();
    store.close();
    store = openStore(path);
    assert.equal((store.db.prepare("SELECT count(*) AS total FROM route_receipts").get() as any).total, 1);
    assert.equal((store.db.prepare("SELECT retry_count FROM jobs WHERE id=?").get(id) as any).retry_count, 6);
    assert.equal(store.recoverDeliveries(), 1);
    assert.equal((store.db.prepare("SELECT recovery_cycles FROM jobs WHERE id=?").get(id) as any).recovery_cycles, 3);
    store.close();
    store = openStore(path);
    assert.equal((store.db.prepare("SELECT count(*) AS total FROM route_receipts").get() as any).total, 1);
});
