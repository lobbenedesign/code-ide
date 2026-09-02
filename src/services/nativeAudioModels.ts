// Modelli con SUPPORTO AUDIO NATIVO reale (parlano/ascoltano direttamente,
// niente pipeline STT->testo->TTS separata come faceva il vecchio Moshi/LiveKit,
// rimosso perché non capiva l'italiano). Selezionati dal menu modelli con
// prefisso 'realtime:' — lo stesso pattern già usato per 'openrouter:'/'together:'.
//
// OpenAI Realtime usa WebRTC (il browser gestisce da solo encode/decode
// audio). Gemini Live usa invece un WebSocket con framing PCM16 manuale
// (16kHz in ingresso, 24kHz in uscita, base64 dentro buste JSON) — più lavoro
// da fare a mano nel renderer, implementato in NativeAudioPanel.tsx.
export type NativeAudioProvider = 'openai-realtime' | 'gemini-live'

export interface NativeAudioModelInfo {
  provider: NativeAudioProvider
  label: string
  implemented: boolean
}

const REALTIME_PREFIX = 'realtime:'

const NATIVE_AUDIO_CATALOG: Record<string, NativeAudioModelInfo> = {
  'gpt-4o-realtime-preview': { provider: 'openai-realtime', label: 'GPT-4o Realtime', implemented: true },
  'gpt-4o-mini-realtime-preview': { provider: 'openai-realtime', label: 'GPT-4o mini Realtime', implemented: true },
  'gemini-2.0-flash-live-001': { provider: 'gemini-live', label: 'Gemini Live', implemented: true }
}

export function isNativeAudioModel(model: string): boolean {
  return model.startsWith(REALTIME_PREFIX)
}

export function getNativeAudioModelInfo(model: string): NativeAudioModelInfo | null {
  if (!model.startsWith(REALTIME_PREFIX)) return null
  const id = model.slice(REALTIME_PREFIX.length)
  return NATIVE_AUDIO_CATALOG[id] || null
}

export function stripRealtimePrefix(model: string): string {
  return model.startsWith(REALTIME_PREFIX) ? model.slice(REALTIME_PREFIX.length) : model
}
