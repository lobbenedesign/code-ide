// Test di connettività standalone per Gemini Live, SENZA passare dalla UI
// completa di code-ide (niente microfono/AudioContext coinvolti) — verifica
// solo che l'URL del WebSocket, l'autenticazione con la chiave API e il
// messaggio 'setup' vengano accettati dal server, cioè i punti più probabili
// di un errore di protocollo mai testato dal vivo. Non invia audio reale.
//
// Uso:
//   GEMINI_API_KEY=AIza... node scripts/test-gemini-live.mjs
//
// Richiede Node 22+ (WebSocket globale nativo, nessuna dipendenza da installare).

const apiKey = process.env.GEMINI_API_KEY
if (!apiKey) {
  console.error('Errore: variabile d\'ambiente GEMINI_API_KEY mancante.')
  console.error('Uso: GEMINI_API_KEY=AIza... node scripts/test-gemini-live.mjs')
  process.exit(1)
}

const MODEL_ID = 'gemini-2.0-flash-live-001'
const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`

console.log(`Connessione a Gemini Live (modello: ${MODEL_ID})...`)
const ws = new WebSocket(url)

const timeout = setTimeout(() => {
  console.error('❌ Timeout: nessuna risposta entro 15 secondi.')
  ws.close()
  process.exit(1)
}, 15000)

ws.onopen = () => {
  console.log('✅ WebSocket connesso. Invio messaggio "setup"...')
  ws.send(JSON.stringify({
    setup: {
      model: `models/${MODEL_ID}`,
      generationConfig: { responseModalities: ['AUDIO'] },
      inputAudioTranscription: {},
      outputAudioTranscription: {}
    }
  }))
}

ws.onmessage = async (event) => {
  const raw = event.data instanceof Blob ? await event.data.text() : event.data
  try {
    const msg = JSON.parse(raw)
    if (msg.setupComplete) {
      console.log('✅ setupComplete ricevuto: il protocollo di setup funziona esattamente come implementato in NativeAudioPanel.tsx.')
      console.log('   (Questo NON testa lo scambio audio vero e proprio, solo la connessione+setup.)')
      clearTimeout(timeout)
      ws.close(1000)
      process.exit(0)
    } else {
      console.log('Messaggio ricevuto (inatteso a questo punto):', JSON.stringify(msg).slice(0, 500))
    }
  } catch {
    console.log('Frame non-JSON ricevuto:', raw.slice(0, 200))
  }
}

ws.onerror = (err) => {
  clearTimeout(timeout)
  console.error('❌ Errore WebSocket:', err.message || err)
  process.exit(1)
}

ws.onclose = (event) => {
  clearTimeout(timeout)
  if (event.code !== 1000) {
    console.error(`❌ Connessione chiusa con codice ${event.code}${event.reason ? `: ${event.reason}` : ''}`)
    console.error('   Cause comuni: chiave API non valida, modello non abilitato per il tuo account/regione, quota esaurita.')
    process.exit(1)
  }
}
