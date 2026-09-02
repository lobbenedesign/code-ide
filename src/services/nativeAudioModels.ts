// Modelli con SUPPORTO AUDIO NATIVO reale (parlano/ascoltano direttamente,
// niente pipeline STT->testo->TTS separata come faceva il vecchio Moshi/LiveKit,
// rimosso perché non capiva l'italiano). Selezionati dal menu modelli con
// prefisso 'realtime:' — lo stesso pattern già usato per 'openrouter:'/'together:'.
//
// Al momento è implementato solo il provider OpenAI Realtime (WebRTC, il
// protocollo con la latenza più bassa e che non richiede parsing manuale di
// chunk PCM: WebRTC gestisce l'encode/decode audio da solo). Gemini Live
// (WebSocket, framing PCM16 manuale) NON è ancora implementato: se selezionato
// il pannello mostra un messaggio chiaro invece di fingere che funzioni.
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
  'gemini-2.0-flash-live': { provider: 'gemini-live', label: 'Gemini Live', implemented: false }
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
