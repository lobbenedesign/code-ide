import { useEffect, useRef, useState } from 'react'
import { getNativeAudioModelInfo, stripRealtimePrefix } from '../services/nativeAudioModels'

interface NativeAudioPanelProps {
  model: string // es. 'realtime:gpt-4o-realtime-preview'
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

  useEffect(() => {
    let cancelled = false

    async function connect() {
      const info = getNativeAudioModelInfo(model)
      if (!info) {
        setError(`Modello '${model}' non riconosciuto tra quelli ad audio nativo.`)
        setStatus('error')
        return
      }
      if (!info.implemented) {
        setError(`Il provider ${info.provider} non è ancora implementato in code-ide (solo OpenAI Realtime lo è al momento). Scegli GPT-4o Realtime o GPT-4o mini Realtime.`)
        setStatus('error')
        return
      }

      const apiKey = localStorage.getItem('OPENAI_API_KEY')
      if (!apiKey) {
        setError("Manca OPENAI_API_KEY nelle Impostazioni: serve per aprire una sessione Realtime.")
        setStatus('error')
        return
      }

      try {
        const modelId = stripRealtimePrefix(model)
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
      } catch (err: any) {
        if (cancelled) return
        console.error('[NativeAudioPanel] Errore connessione Realtime:', err)
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
    }
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
