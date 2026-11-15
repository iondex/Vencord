import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function createLogger(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    let part = 0;
    return (event: string, fields: Record<string, string | number | boolean | null> = {}) => {
        const record = { time: new Date().toISOString(), event, ...fields };
        const body = `${JSON.stringify(record)}\n`;
        let path = join(directory, `hub-${record.time.slice(0, 10)}-${part}.jsonl`);
        try {
            try { if (statSync(path).size >= 10 * 1024 * 1024) path = join(directory, `hub-${record.time.slice(0, 10)}-${++part}.jsonl`); } catch {}
            appendFileSync(path, body, { mode: 0o600 });
        } catch { process.stderr.write("signal-hub log write failed\n"); }
        process.stdout.write(body);
    };
}
