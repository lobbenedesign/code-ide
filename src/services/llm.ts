import { addDebugLog } from './debugLogger'

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  images?: string[]
  name?: string // nome della funzione, sui messaggi role:'tool'
  tool_calls?: any[] // sui messaggi role:'assistant' che hanno richiesto tool
  tool_call_id?: string // sui messaggi role:'tool', per collegarli alla richiesta
}

export interface LLMRequest {
  model: string
  messages: Message[]
  tools?: any[]
}

export interface LLMResponse {
  content: string
  // Modello EFFETTIVAMENTE usato per rispondere (campo 'model' della risposta),
  // se il provider lo dichiara — OmniRoute in particolare instrada verso
  // combo/fallback diversi da quello richiesto quando un provider esaurisce la
  // quota gratuita, quindi ciò che risponde davvero può differire dal modello
  // scelto nel menu. undefined quando il provider non instrada (Ollama diretto,
  // chiave singola fissa) o non dichiara il campo.
  resolvedModel?: string
  // Richieste di chiamata a tool (read_file, search_codebase, ecc.) — presente
  // solo se al provider sono stati passati 'tools' E il modello selezionato
  // sa davvero fare tool-calling ("solo se ne è in grado l'LLM"): un modello
  // che non lo supporta ignora semplicemente il campo 'tools' e risponde a
  // testo normalmente, senza errori.
  tool_calls?: any[]
}

/**
 * OmniRoute: gateway locale OpenAI-compatibile (npm 'omniroute', avviato/gestito
 * da electron/services/omniRoute.ts) con instradamento automatico tra centinaia
 * di provider free-tier — se uno esaurisce la quota passa al successivo senza
 * intervento dell'utente. Prima di questa funzione la chat normale (non-Agent-Mode)
 * non lo chiamava MAI: il badge in basso mostrava lo stato del gateway ma
 * sendLLMRequest non aveva alcun branch che lo raggiungesse davvero.
 *
 * La chiamata passa OBBLIGATORIAMENTE dall'IPC 'omniroute-chat-completion' verso
 * il processo main (electron/main.ts), MAI da un fetch() diretto qui nel renderer:
 * verificato dal vivo (DevTools Network + curl con header Origin reale) che
 * OmniRoute risponde correttamente al preflight CORS (OPTIONS) ma non include
 * MAI 'Access-Control-Allow-Origin' sulla risposta vera — nemmeno quando la
 * chiamata riesce con 200 OK. Chromium blocca quindi sempre la lettura della
 * risposta lato renderer, qualunque endpoint '/v1/*' si usi: non è un endpoint
 * sbagliato, è un limite del server OmniRoute stesso. Il fetch() del processo
 * main, non essendo un browser, non è soggetto a CORS — stessa via già usata
 * con successo dall'Agent Mode (electron/agent/llmClient.ts).
 */
async function callOmniRouteViaMainProcess(model: string, messages: Message[], tools?: any[]): Promise<LLMResponse> {
  const openAiMessages = messages.map(m => {
    if (m.images && m.images.length > 0) {
      const parts: any[] = [{ type: 'text', text: m.content }]
      m.images.forEach(img => parts.push({ type: 'image_url', image_url: { url: img } }))
      return { role: m.role, content: parts }
    }
    return { role: m.role, content: m.content, name: m.name, tool_calls: m.tool_calls, tool_call_id: m.tool_call_id }
  })
  // @ts-ignore
  return window.ipcRenderer.invoke('omniroute-chat-completion', { model, messages: openAiMessages, tools })
}

/**
 * Ritorna il primo modello Ollama REALMENTE installato (query /api/tags), o null
 * se Ollama non è raggiungibile / non ha modelli. Usato ovunque serva un default
 * "locale" sensato, invece di un tag inventato che risponde 404.
 */
export async function getDefaultOllamaModel(): Promise<string | null> {
  const models = await getOllamaModels()
  return models[0] || null
}

// Modelli di solo embedding (nomic-embed-text, mxbai-embed-large, bge-*, ecc.)
// non supportano affatto la chat — Ollama li elenca in /api/tags insieme ai
// modelli normali senza distinguerli esplicitamente. Trovato un bug reale:
// se un modello embedding-only capitava per primo nella lista, veniva
// selezionato di default per la chat, fallendo subito con
// '"nomic-embed-text:latest" does not support chat'.
function isEmbeddingOnlyModel(name: string): boolean {
  return /embed/i.test(name)
}

export async function getOllamaModels(): Promise<string[]> {
  try {
    const res = await fetch('http://localhost:11434/api/tags')
    if (!res.ok) return []
    const data = await res.json()
    return (data.models || []).map((m: any) => m.name).filter(Boolean).filter((name: string) => !isEmbeddingOnlyModel(name))
  } catch {
    return []
  }
}

/** Finestra di contesto dichiarata da Ollama per ogni modello installato (per il contatore token). */
export async function getOllamaContextLengths(): Promise<Record<string, number>> {
  try {
    const res = await fetch('http://localhost:11434/api/tags')
    if (!res.ok) return {}
    const data = await res.json()
    const result: Record<string, number> = {}
    for (const m of data.models || []) {
      if (m.name && m.details?.context_length) result[m.name] = m.details.context_length
    }
    return result
  } catch {
    return {}
  }
}

export interface OllamaModelInfo {
  name: string
  sizeBytes: number
  paramSize: string
}

export async function getOllamaModelsDetailed(): Promise<OllamaModelInfo[]> {
  try {
    const res = await fetch('http://localhost:11434/api/tags')
    if (!res.ok) return []
    const data = await res.json()
    return (data.models || []).map((m: any) => ({
      name: m.name,
      sizeBytes: m.size || 0,
      paramSize: m.details?.parameter_size || '?'
    }))
  } catch {
    return []
  }
}

/**
 * Scarica un modello Ollama (o un modello Hugging Face via il formato 'hf.co/utente/repo'
 * che Ollama supporta nativamente) mostrando il progresso reale — verificato: Ollama
 * risponde con NDJSON in streaming, un oggetto {status, total, completed} per riga.
 */
export async function pullOllamaModel(
  name: string,
  onProgress: (status: string, completed: number, total: number) => void
): Promise<void> {
  const res = await fetch('http://localhost:11434/api/pull', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, stream: true })
  })

  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Errore Ollama (${res.status}): ${errText || 'nessun corpo di risposta'}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const obj = JSON.parse(line)
        if (obj.error) throw new Error(obj.error)
        onProgress(obj.status || '', obj.completed || 0, obj.total || 0)
      } catch (e: any) {
        if (e.message && !e.message.startsWith('Unexpected')) throw e
      }
    }
  }
}

/** Rimuove un modello Ollama installato (verificato: DELETE /api/delete, 200 se rimosso, 404 se non esiste). */
export async function deleteOllamaModel(name: string): Promise<void> {
  const res = await fetch('http://localhost:11434/api/delete', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || `Errore Ollama (${res.status})`)
  }
}

/**
 * Together AI: provider di inferenza per modelli open-weight molto grandi (Llama
 * 405B, Mixtral 8x22B, DeepSeek, ecc.) a prezzi bassi — endpoint OpenAI-compatibile
 * verificato. Gli id modello Together sono nel formato 'vendor/Nome-Modello', con
 * '/' incluso: usa il prefisso 'together:' (come OpenRouter) invece del matching a
 * parola chiave, che fallirebbe su questi id.
 */
export const TOGETHER_BASE_URL = 'https://api.together.ai/v1'

/**
 * LM Studio espone un server locale OpenAI-compatibile (default porta 1234).
 * Elenca i modelli caricati/scaricati lì, indipendentemente da dove provengano
 * (Hugging Face, GGUF locali, ecc. — LM Studio li serve tutti allo stesso modo).
 */
export const LMSTUDIO_BASE_URL = 'http://localhost:1234/v1'

export async function getLMStudioModels(): Promise<string[]> {
  try {
    const res = await fetch(`${LMSTUDIO_BASE_URL}/models`)
    if (!res.ok) return []
    const data = await res.json()
    return (data.data || []).map((m: any) => m.id).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Trascrizione audio (Whisper via OpenAI API). Sostituisce webkitSpeechRecognition:
 * Google ha disattivato il backend dell'API vocale di Chrome per ambienti "shell"
 * come Electron, quindi il riconoscimento vocale nativo del browser parte e si
 * ferma subito senza mai produrre testo — non è un problema risolvibile lato client,
 * serve un servizio di trascrizione reale.
 */
export async function transcribeAudio(audioBlob: Blob): Promise<string> {
  const apiKey = localStorage.getItem('OPENAI_API_KEY')
  if (!apiKey) {
    throw new Error("Manca OPENAI_API_KEY nelle Impostazioni: serve per la trascrizione vocale (Whisper).")
  }

  const formData = new FormData()
  formData.append('file', audioBlob, 'audio.webm')
  formData.append('model', 'whisper-1')

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: formData
  })

  if (!response.ok) {
    const err = await response.text().catch(() => '')
    throw new Error(`Errore trascrizione (${response.status}): ${err.substring(0, 300)}`)
  }
  const data = await response.json()
  return data.text || ''
}

/**
 * Endpoint locale generico OpenAI-compatibile per qualunque altro runtime simile
 * (text-generation-webui, llama.cpp server, TGI, o qualunque altro server che
 * esponga /v1/chat/completions) — configurabile perché non esiste un default
 * universale come per Ollama/LM Studio. Stesso meccanismo di localStorage già
 * usato per le chiavi API dei provider cloud.
 */
export function getLocalCustomBaseUrl(): string | null {
  return localStorage.getItem('LOCAL_LLM_BASE_URL')
}

/**
 * OpenRouter: gateway remoto (a differenza di OmniRoute, nessun processo locale da
 * installare/avviare) che dà accesso a centinaia di modelli con una sola chiave API.
 * I modelli OpenRouter usano id nel formato 'vendor/modello' (es. 'anthropic/claude-3.5-sonnet').
 */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

export function getOpenRouterApiKey(): string | null {
  return localStorage.getItem('OPENROUTER_API_KEY')
}

// Un tag Ollama è sempre nel formato 'nome:tag' (es. 'qwen2.5:7b', 'llama3.2:3b').
// I nomi dei modelli cloud (gpt-4o, claude-3-5-sonnet, llama-3.3-70b-groq, ecc.)
// non hanno mai questo formato: il vecchio controllo per parole chiave ('llama3',
// 'latest', ecc.) falliva su tag reali come 'qwen2.5:7b' che non le contengono,
// facendoli finire per errore nel branch OpenAI (che poi chiede una API key inutile).
export function looksLikeOllamaTag(model: string): boolean {
  if (model.startsWith('sakana:') || model.startsWith('duckai:') || model.startsWith('omniroute:') || model.startsWith('lmstudio:') || model.startsWith('local:') || model.startsWith('openrouter:') || model.startsWith('together:') || model.startsWith('realtime:')) {
    return false
  }
  return /^[\w.-]+:[\w.-]+$/.test(model)
}

async function callOpenAICompatible(baseURL: string, model: string, messages: Message[], tools?: any[], apiKey?: string): Promise<LLMResponse> {
  const openAiMessages = messages.map(m => {
    if (m.images && m.images.length > 0) {
      const contentParts: any[] = [{ type: 'text', text: m.content }]
      m.images.forEach(img => contentParts.push({ type: 'image_url', image_url: { url: img } }))
      return { role: m.role, content: contentParts }
    }
    return { role: m.role, content: m.content, name: m.name, tool_calls: m.tool_calls, tool_call_id: m.tool_call_id }
  })

  let response: Response
  try {
    response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({ model, messages: openAiMessages, tools })
    })
  } catch (err: any) {
    throw new Error(`Server locale (${baseURL}) non raggiungibile: ${err.message}. Verifica che sia avviato.`)
  }

  if (!response.ok) {
    const err = await response.text().catch(() => '')
    throw new Error(`API Error: ${response.status} - ${err}`)
  }
  const data = await response.json()
  const choice = data.choices?.[0]?.message
  return {
    content: choice?.content || '',
    resolvedModel: typeof data.model === 'string' ? data.model : undefined,
    tool_calls: choice?.tool_calls
  }
}

// Router universale per i provider LLM
export async function sendLLMRequest(request: LLMRequest): Promise<LLMResponse> {
  const { model, messages, tools } = request
  addDebugLog('info', 'LLM', `Nuova richiesta [${model}] con ${messages.length} messaggi${tools?.length ? ` e ${tools.length} tools` : ''}`)

  // Modelli 'realtime:' (audio nativo, WebRTC — vedi NativeAudioPanel.tsx) non
  // hanno un endpoint chat-completions testuale: si parla loro solo a voce, dal
  // bottone microfono. Un messaggio testuale con uno di questi selezionati
  // finirebbe altrimenti nel fallback OpenAI generico in fondo a questa
  // funzione con un model id letteralmente 'realtime:...', fallendo con un
  // errore poco chiaro invece che con uno che spiega cosa fare.
  if (model.startsWith('realtime:')) {
    addDebugLog('warn', 'LLM', 'Tentativo di invio testo su modello realtime')
    throw new Error("Questo modello supporta solo conversazione vocale: usa il pulsante 🎙️ invece di scrivere, oppure seleziona un altro modello per la chat testuale.")
  }

  // OmniRoute — modelli selezionati dal menu con prefisso 'omniroute:'. Vedi
  // il commento su callOmniRouteViaMainProcess: DEVE passare dall'IPC verso il
  // processo main, un fetch() diretto qui viene sempre bloccato da CORS.
  if (model.startsWith('omniroute:')) {
    addDebugLog('info', 'OmniRoute', `Routing richiesta verso OmniRoute (${model})`)
    const res = await callOmniRouteViaMainProcess(model.slice('omniroute:'.length), messages, tools)
    addDebugLog('success', 'OmniRoute', `Risposta completata da OmniRoute (modello: ${res.resolvedModel || model})`)
    return res
  }

  // DuckAI (modelli gratuiti Duck.ai) — prefisso 'duckai:'. Deve essere
  // controllato PRIMA di looksLikeOllamaTag, altrimenti il pattern \w+:\w+
  // lo considera per errore un tag Ollama e fallisce con 404.
  if (model.startsWith('duckai:')) {
    addDebugLog('info', 'DuckAI', `Richiesta Duck.ai avviata con modello: ${model}`)
    // @ts-ignore
    const res = await window.ipcRenderer.invoke('duckai-chat', { model, messages, tools })
    if (!res.success) {
      addDebugLog('error', 'DuckAI', `Errore Duck.ai: ${res.error}`)
      throw new Error(res.error || 'Errore durante la chiamata a DuckAI')
    }
    addDebugLog('success', 'DuckAI', `Risposta ricevuta da Duck.ai (${res.data?.content?.length || 0} caratteri)`)
    return { content: res.data.content, resolvedModel: model }
  }

  // Sakana AI (chat.sakana.ai) — prefisso 'sakana:'
  if (model.startsWith('sakana:')) {
    addDebugLog('info', 'SakanaAI', `Richiesta Sakana AI avviata con modello: ${model}`)
    // @ts-ignore
    const res = await window.ipcRenderer.invoke('sakana-chat', { model, messages, tools })
    if (!res.success) {
      addDebugLog('error', 'SakanaAI', `Errore Sakana AI: ${res.error}`)
      throw new Error(res.error || 'Errore durante la chiamata a Sakana AI')
    }
    addDebugLog('success', 'SakanaAI', `Risposta ricevuta da Sakana AI (${res.data?.content?.length || 0} caratteri)`)
    return { content: res.data.content, resolvedModel: model }
  }

  // Ollama (Local) — supporta tool-calling da tempo per i modelli che lo
  // dichiarano (es. qwen2.5, llama3.1+): passiamo 'tools' anche qui, un
  // modello che non lo sa fare lo ignora e risponde a testo normalmente.
  if (looksLikeOllamaTag(model)) {
    addDebugLog('info', 'Ollama', `Richiesta a modello locale Ollama: ${model}`)

    // Ollama richiede l'array 'images' con i raw base64 (senza intestazione data:image/...)
    const ollamaMessages = messages.map(m => {
      const msg: any = { role: m.role, content: m.content, name: m.name, tool_calls: m.tool_calls, tool_call_id: m.tool_call_id }
      if (m.images && m.images.length > 0) {
        msg.images = m.images.map(img => img.split(',')[1] || img)
      }
      return msg
    })

    let response: Response
    try {
      response = await fetch('http://localhost:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model,
          messages: ollamaMessages,
          tools,
          stream: false
        })
      })
    } catch (err: any) {
      addDebugLog('error', 'Ollama', `Errore connessione Ollama: ${err.message}`)
      throw new Error(`Errore Ollama: verifica che il demone sia avviato (${err.message}).`)
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '')
      const errorMsg = `Ollama ha risposto con errore ${response.status}: ${errBody.substring(0, 300) || `modello '${model}' probabilmente non installato — prova "ollama pull ${model}"`}`
      addDebugLog('error', 'Ollama', errorMsg)
      throw new Error(errorMsg)
    }
    const data = await response.json()
    addDebugLog('success', 'Ollama', `Risposta ricevuta da Ollama (${data.message?.content?.length || 0} caratteri)`)
    return { content: data.message?.content || '', tool_calls: data.message?.tool_calls }
  }

  // LM Studio (locale, OpenAI-compatibile) — modelli selezionati dal menu con prefisso 'lmstudio:'
  if (model.startsWith('lmstudio:')) {
    return callOpenAICompatible(LMSTUDIO_BASE_URL, model.slice('lmstudio:'.length), messages, tools)
  }

  // Server locale personalizzato (text-generation-webui, llama.cpp server, TGI, ecc.)
  // — modelli selezionati dal menu con prefisso 'local:', endpoint da localStorage
  if (model.startsWith('local:')) {
    const baseURL = getLocalCustomBaseUrl()
    if (!baseURL) throw new Error("Manca LOCAL_LLM_BASE_URL nel localStorage (es. 'http://localhost:5000/v1').")
    return callOpenAICompatible(baseURL, model.slice('local:'.length), messages, tools)
  }

  // OpenRouter — modelli selezionati dal menu con prefisso 'openrouter:'
  if (model.startsWith('openrouter:')) {
    const apiKey = getOpenRouterApiKey()
    if (!apiKey) throw new Error('Manca OPENROUTER_API_KEY nel localStorage (impostala nelle Impostazioni).')
    return callOpenAICompatible(OPENROUTER_BASE_URL, model.slice('openrouter:'.length), messages, tools, apiKey)
  }

  // Together AI — modelli selezionati dal menu con prefisso 'together:'
  if (model.startsWith('together:')) {
    const apiKey = localStorage.getItem('TOGETHER_API_KEY')
    if (!apiKey) throw new Error('Manca TOGETHER_API_KEY nel localStorage (impostala nelle Impostazioni).')
    return callOpenAICompatible(TOGETHER_BASE_URL, model.slice('together:'.length), messages, tools, apiKey)
  }

  // Google Gemini API — formato function-calling nativo diverso da quello
  // OpenAI ('tools' qui sopra è già in formato OpenAI): tool-calling per
  // Gemini non è cablato, quindi con questo provider selezionato la lettura
  // file automatica non è disponibile ("solo se ne è in grado l'LLM" — qui
  // è la nostra integrazione a non esserlo ancora, non il modello).
  if (model.includes('gemini')) {
    const apiKey = localStorage.getItem('GEMINI_API_KEY')
    if (!apiKey) throw new Error('Manca GEMINI_API_KEY nel localStorage.')
    
    // Convert to Gemini format
    const geminiMessages = messages.map(m => {
      const parts: any[] = [{ text: m.content }]
      if (m.images) {
        m.images.forEach(img => {
          const match = img.match(/^data:(image\/[a-z]+);base64,(.+)$/)
          if (match) {
            parts.push({
              inline_data: { mime_type: match[1], data: match[2] }
            })
          }
        })
      }
      return {
        role: m.role === 'assistant' ? 'model' : 'user', 
        parts: parts
      }
    })

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: geminiMessages })
    })

    if (!response.ok) throw new Error('Errore Gemini API')
    const data = await response.json()
    return { content: data.candidates?.[0]?.content?.parts?.[0]?.text || '' }
  }

  // OpenAI Compatible APIs (Groq, DeepSeek, Grok, Qwen-Max, Z.ai, Sakana, Kimi)
  // They all share the exact same payload structure
  let baseURL = ''
  let apiKey = ''

  if (model.includes('groq')) {
    baseURL = 'https://api.groq.com/openai/v1'
    apiKey = localStorage.getItem('GROQ_API_KEY') || ''
  } else if (model.includes('deepseek')) {
    baseURL = 'https://api.deepseek.com/v1'
    apiKey = localStorage.getItem('DEEPSEEK_API_KEY') || ''
  } else if (model.includes('grok')) {
    baseURL = 'https://api.x.ai/v1'
    apiKey = localStorage.getItem('XAI_API_KEY') || ''
  } else if (model.includes('qwen-max')) {
    baseURL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
    apiKey = localStorage.getItem('DASHSCOPE_API_KEY') || ''
  } else if (model.includes('kimi')) {
    baseURL = 'https://api.moonshot.cn/v1'
    apiKey = localStorage.getItem('MOONSHOT_API_KEY') || ''
  } else {
    // Generico OpenAI fallback
    baseURL = 'https://api.openai.com/v1'
    apiKey = localStorage.getItem('OPENAI_API_KEY') || ''
  }

  if (!apiKey) throw new Error(`Chiave API mancante per il modello ${model}. Inseriscila nel localStorage.`)

  return callOpenAICompatible(baseURL, model, messages, tools, apiKey)
}

// Tool di sola lettura (leggere file, cercare nel codice, mappa repo,
// diagnostica) che qualunque modello selezionato nel menu — non solo l'Agent
// Mode — può ora usare per "mettere mano" davvero ai file del progetto aperto
// in ESPLORA RISORSE, invece di vedere solo l'albero dei percorsi. Girano nel
// processo main (filesystem/TypeScript Compiler API non disponibili nel
// renderer) tramite IPC dedicato — vedi 'get-readonly-chat-tools' e
// 'run-readonly-tool' in electron/main.ts.
//
// Eseguito A STEP (non in un unico loop bloccante): un tetto fisso e silente
// (com'era prima) va bene per una domanda mirata ma è fuorviante per un task
// ampio ("trova bug in ogni file") — l'utente si ritrova un troncamento
// improvviso senza sapere che stava per succedere né poter scegliere di
// continuare. Ogni step esegue al più STEP_SIZE round-trip di tool-calling;
// il chiamante (AiChat.tsx) decide cosa fare quando uno step finisce SENZA
// una risposta finale: continuare (con o senza chiedere di nuovo) o fermarsi.
export const READONLY_TOOL_STEP_SIZE = 6

export interface ToolStep {
  functionName: string
  args: any
}

export interface ToolStepResult {
  done: boolean // true = il modello ha dato una risposta finale, niente altro da fare
  content?: string // presente solo se done
  resolvedModel?: string
  messages: Message[] // conversazione aggiornata, da ripassare al prossimo step se done=false
  stepsExecuted: ToolStep[] // i tool effettivamente chiamati in QUESTO step (per mostrarli in UI)
}

// Stesso bug osservato dal vivo in Agent Mode (harness.ts) esiste anche qui:
// un modello locale può scrivere la chiamata a tool come TESTO
// ('{"name": "ocr_image", "arguments": {...}}' nel messaggio) invece di
// popolare davvero tool_calls — senza questo recupero, il ramo 'done: true'
// qui sotto la tratterebbe come risposta finale e il tool non verrebbe mai
// eseguito, con l'utente che vede il JSON grezzo al posto del risultato.
export function tryRecoverToolCallFromText(content: string | undefined, availableTools: any[]): { id: string, function: { name: string, arguments: any } } | null {
  if (!content) return null
  // Stesso riconoscimento di harness.ts (tenuto sincronizzato a mano finché
  // renderer e main process restano build separate senza un modulo
  // condiviso): un modello può incollare il JSON dentro un blocco ```json
  // invece che a testo nudo, e usare 'parameters'/'params' invece di
  // 'arguments' (entrambi visti dal vivo con modelli diversi).
  const jsonBlockMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/)
  const targetStr = jsonBlockMatch ? jsonBlockMatch[1] : content
  const match = targetStr.match(/\{[\s\S]*"name"\s*:\s*"([^"]+)"[\s\S]*\}/)
  if (!match) return null

  const toolNames = new Set(availableTools.map(t => t.function.name))
  if (!toolNames.has(match[1])) return null

  try {
    const parsed = JSON.parse(match[0])
    if (!parsed.name || !toolNames.has(parsed.name)) return null
    const args = parsed.arguments ?? parsed.parameters ?? parsed.params ?? {}
    return { id: `recovered-${Date.now()}`, function: { name: parsed.name, arguments: args } }
  } catch {
    return null
  }
}

/**
 * Esegue UN singolo step (al più READONLY_TOOL_STEP_SIZE chiamate a tool di
 * sola lettura) della conversazione con 'messages', poi si ferma — che sia
 * arrivato o no a una risposta finale. Un modello senza tool-calling risponde
 * subito al primo giro: 'done' sarà true dopo un solo step, senza alcuna
 * differenza percepibile rispetto a sendLLMRequest normale.
 */
export async function runReadOnlyToolStep(
  model: string,
  messages: Message[],
  cwd: string,
  onToolCall?: (functionName: string, args: any) => void
): Promise<ToolStepResult> {
  // @ts-ignore
  const tools = await window.ipcRenderer.invoke('get-readonly-chat-tools')
  const msgs: Message[] = [...messages]
  const stepsExecuted: ToolStep[] = []
  let lastResolvedModel: string | undefined

  for (let i = 0; i < READONLY_TOOL_STEP_SIZE; i++) {
    const result = await sendLLMRequest({ model, messages: msgs, tools })
    if (result.resolvedModel) lastResolvedModel = result.resolvedModel

    const recoveredToolCall = (!result.tool_calls || result.tool_calls.length === 0)
      ? tryRecoverToolCallFromText(result.content, tools)
      : null
    const toolCalls = recoveredToolCall ? [recoveredToolCall] : result.tool_calls

    if (!toolCalls || toolCalls.length === 0) {
      return { done: true, content: result.content, resolvedModel: lastResolvedModel, messages: msgs, stepsExecuted }
    }

    msgs.push({ role: 'assistant', content: recoveredToolCall ? '' : (result.content || ''), tool_calls: toolCalls })

    for (const toolCall of toolCalls) {
      const functionName = toolCall.function.name
      const args = typeof toolCall.function.arguments === 'string'
        ? JSON.parse(toolCall.function.arguments)
        : (toolCall.function.arguments || {})
      stepsExecuted.push({ functionName, args })
      addDebugLog('info', 'Tool', `Esecuzione tool di lettura: ${functionName}`, args)
      onToolCall?.(functionName, args)
      // @ts-ignore
      const toolResult = await window.ipcRenderer.invoke('run-readonly-tool', { functionName, args, cwd })
      addDebugLog('success', 'Tool', `Tool [${functionName}] completato`)
      msgs.push({
        role: 'tool',
        name: functionName,
        content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
        tool_call_id: toolCall.id
      })
    }
  }

  return { done: false, resolvedModel: lastResolvedModel, messages: msgs, stepsExecuted }
}
