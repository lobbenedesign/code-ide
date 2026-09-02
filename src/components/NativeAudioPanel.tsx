import { useEffect, useRef, useState } from 'react'
import { getNativeAudioModelInfo, stripRealtimePrefix } from '../services/nativeAudioModels'

interface NativeAudioPanelProps {
  model: string // es. 'realtime:gpt-4o-realtime-preview' oppure 'realtime:gemini-2.0-flash-live'
  onClose: () => void
  onTranscript: (role: 'user' | 'assistant', text: string) => void
}

type Status = 'connecting' | 'connected' | 'error' | 'closed'

// Sessione OpenAI Realtime via WebRTC: la chiave API vera resta solo nella
// richiesta di sessione (stesso pattern già usato altrove nell'app — es.
// transcribeAudio in services/llm.ts — dove le chiavi vivono nel localStorage
// del renderer e le chiamate ai provider partono da lì). La sessione HTTP
// restituisce una client_secret EFFIMERA che è quella usata per lo scambio
// SDP WebRTC vero e proprio, così la chiave permanente non gira sul filo
// della connessione peer-to-peer con OpenAI.
async function createEphemeralSession(apiKey: string, model: string): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/realtime/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model, voice: 'alloy' })
  })
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`Creazione sessione Realtime fallita (${res.status}): ${err.slice(0, 300)}`)
  }
  const data = await res.json()
  const secret = data.client_secret?.value
  if (!secret) throw new Error('Risposta sessione Realtime senza client_secret.value (formato inatteso).')
  return secret
}

// --- Gemini Live: helper di codifica audio -------------------------------
// Il protocollo è WebSocket con framing PCM16 manuale (a differenza di OpenAI
// Realtime che usa WebRTC e delega l'encoding audio al browser): input a
// 16kHz mono, output a 24kHz mono, entrambi PCM16 little-endian in base64
// dentro buste JSON. Nessuna libreria fa questo per noi in Electron: va scritto.

function float32ToPcm16Base64(input: Float32Array): string {
  const pcm16 = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]))
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  const bytes = new Uint8Array(pcm16.buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function base64Pcm16ToFloat32(base64: string): Float32Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const pcm16 = new Int16Array(bytes.buffer)
  const float32 = new Float32Array(pcm16.length) as Float32Array<ArrayBuffer>
  for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / (pcm16[i] < 0 ? 0x8000 : 0x7fff)
  return float32
}

const GEMINI_INPUT_SAMPLE_RATE = 16000
const GEMINI_OUTPUT_SAMPLE_RATE = 24000

export function NativeAudioPanel({ model, onClose, onTranscript }: NativeAudioPanelProps) {
  const [status, setStatus] = useState<Status>('connecting')
  const [error, setError] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const dcRef = useRef<RTCDataChannel | null>(null)
  // Accumula il testo in streaming (delta) fino all'evento '...done', per
  // scrivere in chat una riga per turno invece di una per ogni frammento.
  const partialTranscriptRef = useRef<Record<string, string>>({})

  // --- stato solo per Gemini Live (WebSocket + AudioContext manuale) ---
  const wsRef = useRef<WebSocket | null>(null)
  const inputCtxRef = useRef<AudioContext | null>(null)
  const outputCtxRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const nextPlaybackTimeRef = useRef<number>(0)
  const geminiInputTranscriptRef = useRef<string>('')
  const geminiOutputTranscriptRef = useRef<string>('')

  useEffect(() => {
    let cancelled = false

    async function connectOpenAIRealtime(modelId: string) {
      const apiKey = localStorage.getItem('OPENAI_API_KEY')
      if (!apiKey) {
        setError("Manca OPENAI_API_KEY nelle Impostazioni: serve per aprire una sessione Realtime.")
        setStatus('error')
        return
      }

      const ephemeralKey = await createEphemeralSession(apiKey, modelId)
      if (cancelled) return

      const pc = new RTCPeerConnection()
      pcRef.current = pc

      pc.ontrack = (event) => {
        if (audioRef.current) audioRef.current.srcObject = event.streams[0]
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
      streamRef.current = stream
      stream.getTracks().forEach(track => pc.addTrack(track, stream))

      const dc = pc.createDataChannel('oai-events')
      dcRef.current = dc
      dc.addEventListener('message', (e) => {
        try {
          const evt = JSON.parse(e.data)
          // Trascrizione utente (Whisper lato server della sessione Realtime)
          if (evt.type === 'conversation.item.input_audio_transcription.completed' && evt.transcript) {
            onTranscript('user', evt.transcript)
          }
          // Trascrizione risposta vocale dell'assistente, in streaming a delta
          if (evt.type === 'response.audio_transcript.delta' && evt.item_id) {
            partialTranscriptRef.current[evt.item_id] = (partialTranscriptRef.current[evt.item_id] || '') + (evt.delta || '')
          }
          if (evt.type === 'response.audio_transcript.done' && evt.item_id) {
            const full = partialTranscriptRef.current[evt.item_id] || evt.transcript || ''
            if (full) onTranscript('assistant', full)
            delete partialTranscriptRef.current[evt.item_id]
          }
        } catch {
          // evento non-JSON o non riconosciuto: ignorato, non è un errore fatale
        }
      })

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)

      const sdpRes = await fetch(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(modelId)}`, {
        method: 'POST',
        body: offer.sdp,
        headers: {
          'Authorization': `Bearer ${ephemeralKey}`,
          'Content-Type': 'application/sdp'
        }
      })
      if (!sdpRes.ok) {
        const errText = await sdpRes.text().catch(() => '')
        throw new Error(`Scambio SDP con OpenAI Realtime fallito (${sdpRes.status}): ${errText.slice(0, 300)}`)
      }
      const answerSdp = await sdpRes.text()
      if (cancelled) return
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })

      pc.onconnectionstatechange = () => {
        if (cancelled) return
        if (pc.connectionState === 'connected') setStatus('connected')
        else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          setStatus('error')
          setError(`Connessione WebRTC persa (stato: ${pc.connectionState}).`)
        }
      }
    }

    // Gemini Live (BidiGenerateContent su WebSocket): niente SDP/WebRTC, il
    // client apre un socket, manda un messaggio 'setup' iniziale, poi invia
    // chunk PCM16@16kHz in continuo e riceve chunk PCM16@24kHz + trascrizioni
    // in streaming — va incapsulato/decapsulato tutto a mano qui.
    async function connectGeminiLive(modelId: string) {
      const apiKey = localStorage.getItem('GEMINI_API_KEY')
      if (!apiKey) {
        setError("Manca GEMINI_API_KEY nelle Impostazioni: serve per aprire una sessione Gemini Live.")
        setStatus('error')
        return
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
      streamRef.current = stream

      const outputCtx = new AudioContext({ sampleRate: GEMINI_OUTPUT_SAMPLE_RATE })
      outputCtxRef.current = outputCtx
      nextPlaybackTimeRef.current = outputCtx.currentTime

      const ws = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`)
      wsRef.current = ws

      ws.onopen = () => {
        if (cancelled) return
        ws.send(JSON.stringify({
          setup: {
            model: `models/${modelId}`,
            generationConfig: { responseModalities: ['AUDIO'] },
            inputAudioTranscription: {},
            outputAudioTranscription: {}
          }
        }))
      }

      ws.onmessage = async (event) => {
        if (cancelled) return
        try {
          // I frame di Gemini Live possono arrivare come Blob (binario) anche
          // se il contenuto è JSON testuale — va normalizzato prima del parse.
          const raw = event.data instanceof Blob ? await event.data.text() : event.data
          const msg = JSON.parse(raw)

          if (msg.setupComplete) {
            setStatus('connected')

            // Solo ORA, con la sessione pronta, iniziamo a catturare e
            // inviare il microfono — mandare audio prima del setupComplete
            // verrebbe scartato dal server.
            const inputCtx = new AudioContext({ sampleRate: GEMINI_INPUT_SAMPLE_RATE })
            inputCtxRef.current = inputCtx
            const source = inputCtx.createMediaStreamSource(stream)
            // ScriptProcessorNode è deprecato a favore di AudioWorklet, ma
            // funziona ancora ovunque e non richiede un file worklet separato
            // da far gestire al bundler — scelta pragmatica per questa feature.
            const processor = inputCtx.createScriptProcessor(4096, 1, 1)
            processorRef.current = processor
            processor.onaudioprocess = (e) => {
              if (ws.readyState !== WebSocket.OPEN) return
              const data = e.inputBuffer.getChannelData(0)
              ws.send(JSON.stringify({
                realtimeInput: {
                  mediaChunks: [{ mimeType: `audio/pcm;rate=${GEMINI_INPUT_SAMPLE_RATE}`, data: float32ToPcm16Base64(data) }]
                }
              }))
            }
            source.connect(processor)
            // Il processor deve essere collegato a una destinazione per essere
            // eseguito dal grafo audio, ma non vogliamo sentire il nostro
            // stesso microfono: guadagno azzerato invece del collegamento diretto.
            const silentGain = inputCtx.createGain()
            silentGain.gain.value = 0
            processor.connect(silentGain)
            silentGain.connect(inputCtx.destination)
            return
          }

          const serverContent = msg.serverContent
          if (!serverContent) return

          // Trascrizione utente (streaming a delta, come OpenAI ma con nomi diversi)
          if (serverContent.inputTranscription?.text) {
            geminiInputTranscriptRef.current += serverContent.inputTranscription.text
          }
          if (serverContent.outputTranscription?.text) {
            geminiOutputTranscriptRef.current += serverContent.outputTranscription.text
          }

          // Audio dell'assistente: chunk PCM16@24kHz da riprodurre in coda,
          // schedulati uno dopo l'altro sullo stesso AudioContext per evitare
          // sovrapposizioni o buchi tra un chunk e il successivo.
          const parts = serverContent.modelTurn?.parts || []
          for (const part of parts) {
            if (part.inlineData?.data && part.inlineData.mimeType?.startsWith('audio/pcm')) {
              const float32 = base64Pcm16ToFloat32(part.inlineData.data)
              const buffer = outputCtx.createBuffer(1, float32.length, GEMINI_OUTPUT_SAMPLE_RATE)
              buffer.copyToChannel(float32, 0)
              const source = outputCtx.createBufferSource()
              source.buffer = buffer
              source.connect(outputCtx.destination)
              const startAt = Math.max(nextPlaybackTimeRef.current, outputCtx.currentTime)
              source.start(startAt)
              nextPlaybackTimeRef.current = startAt + buffer.duration
            }
          }

          // Il turno finisce: svuota gli accumulatori di trascrizione nella chat.
          if (serverContent.turnComplete) {
            if (geminiInputTranscriptRef.current.trim()) {
              onTranscript('user', geminiInputTranscriptRef.current.trim())
              geminiInputTranscriptRef.current = ''
            }
            if (geminiOutputTranscriptRef.current.trim()) {
              onTranscript('assistant', geminiOutputTranscriptRef.current.trim())
              geminiOutputTranscriptRef.current = ''
            }
          }
        } catch {
          // frame non-JSON o non riconosciuto: ignorato, non fatale
        }
      }

      ws.onerror = () => {
        if (cancelled) return
        setError('Connessione WebSocket a Gemini Live fallita (chiave API non valida, modello non disponibile per il tuo account, o rete).')
        setStatus('error')
      }
      ws.onclose = (e) => {
        if (cancelled) return
        if (status !== 'error') {
          setStatus('closed')
          if (e.code !== 1000) setError(`Sessione Gemini Live chiusa (codice ${e.code}${e.reason ? `: ${e.reason}` : ''}).`)
        }
      }
    }

    async function connect() {
      const info = getNativeAudioModelInfo(model)
      if (!info) {
        setError(`Modello '${model}' non riconosciuto tra quelli ad audio nativo.`)
        setStatus('error')
        return
      }

      try {
        const modelId = stripRealtimePrefix(model)
        if (info.provider === 'openai-realtime') {
          await connectOpenAIRealtime(modelId)
        } else if (info.provider === 'gemini-live') {
          await connectGeminiLive(modelId)
        } else {
          setError(`Provider '${info.provider}' non implementato.`)
          setStatus('error')
        }
      } catch (err: any) {
        if (cancelled) return
        console.error('[NativeAudioPanel] Errore connessione:', err)
        setError(err.message || String(err))
        setStatus('error')
      }
    }

    connect()

    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach(t => t.stop())
      dcRef.current?.close()
      pcRef.current?.close()
      processorRef.current?.disconnect()
      inputCtxRef.current?.close().catch(() => {})
      outputCtxRef.current?.close().catch(() => {})
      wsRef.current?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model])

  const info = getNativeAudioModelInfo(model)

  return (
    <div className="absolute inset-x-2 bottom-2 top-2 z-40 flex flex-col items-center justify-center p-4 bg-[#1e1e1e] rounded-lg border border-[#333] shadow-xl">
      <div className="text-lg font-bold text-gray-200 mb-1">🎙️ Audio nativo — {info?.label || model}</div>
      <div className="text-xs text-gray-400 mb-4 uppercase tracking-wider">
        Stato: <span className={status === 'connected' ? 'text-green-500' : status === 'error' ? 'text-red-500' : 'text-yellow-500'}>{status}</span>
      </div>

      {error && (
        <div className="text-xs text-red-300 bg-red-900/30 border border-red-800 rounded p-2 mb-4 max-w-[320px] text-center whitespace-pre-wrap">
          {error}
        </div>
      )}

      {status === 'connected' && (
        <div className="text-sm text-gray-400 mb-4 animate-pulse">In conversazione — parla pure</div>
      )}

      <audio ref={audioRef} autoPlay />

      <button
        onClick={onClose}
        className="px-4 py-1.5 text-xs bg-red-900/40 hover:bg-red-900/70 text-red-300 rounded"
      >
        ⏹️ Termina conversazione
      </button>
    </div>
  )
}
