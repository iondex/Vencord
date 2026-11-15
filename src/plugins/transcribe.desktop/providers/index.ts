import { whisperLiveKit } from "@plugins/transcribe.desktop/providers/whisperLiveKit";
import type { TranscriptionProvider } from "@plugins/transcribe.desktop/types";

export const transcriptionProviders: Record<string, TranscriptionProvider> = {
    [whisperLiveKit.id]: whisperLiveKit
};
