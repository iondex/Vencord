import { checkCapture, createCaptureManager } from "@plugins/transcribe.desktop/capture";
import type { CaptureOptions } from "@plugins/transcribe.desktop/types";

const capture = createCaptureManager();

export async function prepareCapture(_: Electron.IpcMainInvokeEvent, options: CaptureOptions) {
    await checkCapture(options);
}

export async function startCapture(_: Electron.IpcMainInvokeEvent, id: string, options: CaptureOptions) {
    const paths = await checkCapture(options);
    return capture.start(id, paths.binary, paths.resolver);
}

export function readCapture(_: Electron.IpcMainInvokeEvent, id: string) {
    return capture.read(id);
}

export function stopCapture(_: Electron.IpcMainInvokeEvent, id: string) {
    return capture.stop(id);
}
