import { getOmniRouteBaseUrl } from '../services/omniRoute'
import { recordUsage } from '../services/usageTracker'

export interface ChatMessage {
  role: string
  content: string
  name?: string
  tool_calls?: any[]
  images?: string[] // Data URL base64 (es. 'data:image/png;base64,...')
}

// Converte i messaggi nel formato OpenAI/OmniRoute: le immagini diventano
// 'content' multi-parte [{type:'text'},{type:'image_url'}] invece del campo
// piatto 'content' usato per i messaggi solo testo.
function toOpenAIMessages(messages: ChatMessage[]): any[] {
  return messages.map(m => {
    if (m.images && m.images.length > 0) {
      const parts: any[] = [{ type: 'text', text: m.content }]
      m.images.forEach(img => parts.push({ type: 'image_url', image_url: { url: img } }))
      return { role: m.role, content: parts, name: m.name }
    }
    return { role: m.role, content: m.content, name: m.name, tool_calls: m.tool_calls }
  })
}

// Converte i messaggi nel formato Ollama: 'images' è un array separato di
// base64 GREZZO (senza il prefisso 'data:image/...;base64,').
function toOllamaMessages(messages: ChatMessage[]): any[] {
  return messages.map(m => {
    const msg: any = { role: m.role, content: m.content, name: m.name, tool_calls: m.tool_calls }
    if (m.images && m.images.length > 0) {
      msg.images = m.images.map(img => img.split(',')[1] || img)
    }
    return msg
  })
}

export interface ChatCompletionParams {
  model: string
  messages: ChatMessage[]
  tools?: any[]
  temperature?: number
}

export interface ChatCompletionResult {
  message: {
    role: string
    content: string
    tool_calls?: any[]
  }
  // Modello EFFETTIVAMENTE usato per rispondere, se il provider lo dichiara
  // nella risposta (campo 'model' — OmniRoute in particolare instrada
  // automaticamente verso combo/fallback diversi da quello richiesto quando
  // uno esaurisce la quota, quindi ciò che risponde davvero può differire dal
  // 'model' inviato nella richiesta). Prima questo campo veniva scartato: non
  // c'era alcun modo di sapere quale modello avesse risposto sul serio.
  resolvedModel?: string
}

// Un tag Ollama è sempre nel formato 'nome:tag' (es. 'qwen2.5:7b', 'llama3.2:3b').
// I nomi di modelli cloud/API (gpt-4o, claude-3-5-sonnet, llama-3.3-70b-groq, ecc.)
// non hanno mai questo formato: se non lo hanno, Ollama in locale non può servirli.
function looksLikeOllamaTag(model: string): boolean {
  if (model.startsWith('sakana:') || model.startsWith('duckai:') || model.startsWith('omniroute:') || model.startsWith('lmstudio:') || model.startsWith('local:') || model.startsWith('openrouter:') || model.startsWith('together:') || model.startsWith('realtime:')) {
    return false
  }
  return /^[\w.-]+:[\w.-]+$/.test(model)
}

const LMSTUDIO_BASE_URL = 'http://localhost:1234/v1'
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

// Chiamata generica a un endpoint OpenAI-compatibile: server locale (LM Studio, TGI,
// text-generation-webui, llama.cpp server — nessuna API key richiesta dalla maggior
// parte dei runtime locali) oppure remoto con chiave (OpenRouter).
async function callOpenAICompatible(baseURL: string, model: string, messages: ChatMessage[], tools?: any[], apiKey?: string): Promise<ChatCompletionResult> {
  let response: Response
  try {
    response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({ model, messages: toOpenAIMessages(messages), tools, stream: false })
    })
  } catch (err: any) {
    throw new Error(`Endpoint ${baseURL} non raggiungibile: ${err.message}.`)
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => '')
    throw new Error(`${baseURL} ha risposto con errore ${response.status}: ${errBody.substring(0, 300)}`)
  }

  const data = await response.json()
  const choice = data.choices?.[0]?.message
  // 'usage' è presente sulla maggior parte degli endpoint OpenAI-compatibili
  // (OpenRouter di sicuro; server locali variano) — se assente semplicemente
  // non registriamo nulla per quella chiamata, invece di inventare un numero.
  if (data.usage) {
    recordUsage(model, data.usage.prompt_tokens || 0, data.usage.completion_tokens || 0)
  }
  return {
    message: { role: choice?.role || 'assistant', content: choice?.content || '', tool_calls: choice?.tool_calls },
    resolvedModel: typeof data.model === 'string' ? data.model : undefined
  }
}

// Tetto di sicurezza sul numero totale di chiamate LLM per singolo task
// dell'agente: senza questo, un task con Deep Reasoning (3 giudici x 5
// investigazioni + 1 valutatore) innestato in un harness da 25 iterazioni che
// invoca anche sub-agenti (fino a 5 chiamate extra ciascuno) non ha alcun
// limite reale al numero di chiamate — con modelli a pagamento (OpenRouter,
// OmniRoute verso provider cloud) questo significa nessun tetto di spesa.
// Il contatore viene azzerato a ogni nuovo task (vedi resetChatCallCounter,
// chiamato da main.ts prima di avviare l'harness), non è un limite globale
// per l'intera sessione dell'app.
const DEFAULT_MAX_CALLS_PER_RUN = 150
let chatCallCount = 0

export function resetChatCallCounter(): void {
  chatCallCount = 0
}

function getMaxCallsPerRun(): number {
  const fromEnv = Number(process.env.AGENT_MAX_LLM_CALLS_PER_RUN)
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_MAX_CALLS_PER_RUN
}

// Chiamata effettiva a OmniRoute — usata sia dal branch esplicito
// 'omniroute:' sia dal fallback generico. Ritorna null quando la risposta è
// ok ma senza una scelta valida (formato inatteso), altrimenti lascia
// propagare l'eccezione di fetch/rete al chiamante.
async function callOmniRoute(omniBaseUrl: string, model: string, params: ChatCompletionParams): Promise<ChatCompletionResult | null> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (process.env.OMNIROUTE_API_KEY) {
    headers['Authorization'] = `Bearer ${process.env.OMNIROUTE_API_KEY}`
  }

  const response = await fetch(`${omniBaseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: toOpenAIMessages(params.messages),
      tools: params.tools,
      stream: false,
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {})
    })
  })

  if (!response.ok) {
    const errBody = await response.text().catch(() => '')
    throw new Error(`OmniRoute ha risposto con errore ${response.status}: ${errBody.slice(0, 300)}`)
  }

  const data = await response.json()
  const choice = data.choices?.[0]?.message
  if (!choice) return null

  if (data.usage) {
    recordUsage(model, data.usage.prompt_tokens || 0, data.usage.completion_tokens || 0)
  }
  return {
    message: {
      role: choice.role || 'assistant',
      content: choice.content || '',
      tool_calls: choice.tool_calls
    },
    resolvedModel: typeof data.model === 'string' ? data.model : undefined
  }
}

/**
 * Punto unico di chiamata al modello per l'harness agentico (harness.ts,
 * deepReasoning.ts, SubagentPlugin.ts). Se OmniRoute è pronto instrada la
 * richiesta lì (endpoint OpenAI-compatibile, accesso a qualunque provider);
 * altrimenti ricade sulla chiamata diretta a Ollama locale SOLO se il modello
 * richiesto è effettivamente un tag Ollama — altrimenti fallirebbe con un
 * errore fuorviante ('verifica che il demone') anche quando Ollama è su e
 * funzionante, semplicemente perché quel modello non lo serve lui.
 */
export async function chatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResult> {
  const maxCalls = getMaxCallsPerRun()
  chatCallCount++
  if (chatCallCount > maxCalls) {
    throw new Error(
      `🚫 Limite di sicurezza raggiunto: ${maxCalls} chiamate LLM in questo task (AGENT_MAX_LLM_CALLS_PER_RUN nel .env per modificarlo). ` +
      `Il task viene interrotto per evitare un ciclo fuori controllo (e, con modelli a pagamento, una spesa incontrollata). Riprova con un prompt più mirato.`
    )
  }

  // DuckAI (modelli gratuiti Duck.ai) — prefisso 'duckai:'
  if (params.model.startsWith('duckai:')) {
    const { callDuckAiChat } = await import('../services/duckAi')
    const res = await callDuckAiChat({
      model: params.model,
      messages: params.messages,
      tools: params.tools
    })
    return {
      message: {
        role: 'assistant',
        content: res.content
      },
      resolvedModel: params.model
    }
  }

  // Sakana AI (chat.sakana.ai) — prefisso 'sakana:'
  if (params.model.startsWith('sakana:')) {
    const { callSakanaChat } = await import('../services/sakanaAi')
    const res = await callSakanaChat({
      model: params.model,
      messages: params.messages,
      tools: params.tools
    })
    return {
      message: {
        role: 'assistant',
        content: res.content
      },
      resolvedModel: params.model
    }
  }

  // LM Studio (locale, OpenAI-compatibile) — modelli con prefisso 'lmstudio:'
  if (params.model.startsWith('lmstudio:')) {
    return callOpenAICompatible(LMSTUDIO_BASE_URL, params.model.slice('lmstudio:'.length), params.messages, params.tools)
  }

  // Server locale personalizzato (text-generation-webui, llama.cpp server, TGI, ecc.)
  // — modelli con prefisso 'local:', endpoint da LOCAL_LLM_BASE_URL nel .env
  if (params.model.startsWith('local:')) {
    const baseURL = process.env.LOCAL_LLM_BASE_URL
    if (!baseURL) {
      throw new Error("Manca LOCAL_LLM_BASE_URL nel file .env (es. 'http://localhost:5000/v1').")
    }
    return callOpenAICompatible(baseURL, params.model.slice('local:'.length), params.messages, params.tools)
  }

  // OpenRouter — modelli con prefisso 'openrouter:', chiave da OPENROUTER_API_KEY nel .env
  if (params.model.startsWith('openrouter:')) {
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error('Manca OPENROUTER_API_KEY nel file .env.')
    }
    return callOpenAICompatible(OPENROUTER_BASE_URL, params.model.slice('openrouter:'.length), params.messages, params.tools, process.env.OPENROUTER_API_KEY)
  }

  // OmniRoute — modelli scelti nel menu con prefisso esplicito 'omniroute:'
  // (es. 'omniroute:auto'). Trovato un bug reale: senza questo branch il
  // prefisso non veniva mai tolto, quindi il modello inviato letteralmente
  // era 'omniroute:auto' — OmniRoute non lo riconosce (si aspetta solo
  // 'auto'), la chiamata falliva, e siccome quella stringa combacia col
  // pattern \w+:\w+ di looksLikeOllamaTag il codice ricadeva sul fallback
  // Ollama, che rispondeva 404 "model 'omniroute:auto' not found" — un
  // crash dell'harness anche con OmniRoute perfettamente funzionante e
  // selezionato esplicitamente dall'utente. Qui, a differenza del fallback
  // generico sotto, un fallimento è un errore vero (l'utente ha scelto
  // OmniRoute apposta), non un fallback silenzioso su Ollama.
  if (params.model.startsWith('omniroute:')) {
    const omniBaseUrl = getOmniRouteBaseUrl()
    if (!omniBaseUrl) {
      throw new Error("OmniRoute non è pronto (badge in basso nella chat, o riprova dalle Impostazioni).")
    }
    const result = await callOmniRoute(omniBaseUrl, params.model.slice('omniroute:'.length), params)
    if (!result) {
      throw new Error('OmniRoute ha risposto in modo inatteso (nessuna scelta nella risposta).')
    }
    return result
  }

  // Un tag Ollama (es. 'qwen2.5-coder:7b') va SEMPRE diretto a Ollama, senza
  // passare prima da OmniRoute — trovato con un vero test dal vivo: OmniRoute
  // non sa cosa farsene di un tag Ollama locale (risponde 400 "Unable to
  // determine provider"), quindi quel tentativo falliva SEMPRE per questi
  // modelli, aggiungendo una latenza di rete inutile ad ogni singola chiamata
  // prima di ricadere comunque su Ollama. Per un modello non-Ollama, invece,
  // OmniRoute resta l'unica via (nessun downgrade di comportamento qui sotto).
  if (looksLikeOllamaTag(params.model)) {
    return callOllamaDirect(params)
  }

  const omniBaseUrl = getOmniRouteBaseUrl()

  if (omniBaseUrl) {
    try {
      const result = await callOmniRoute(omniBaseUrl, params.model, params)
      if (result) return result
    } catch (err: any) {
      console.warn('[llmClient] OmniRoute non raggiungibile:', err.message)
    }
  }

  throw new Error(
    `Il modello '${params.model}' non è un tag Ollama e OmniRoute non è disponibile: non c'è modo di raggiungerlo da questo processo ` +
    `(le chiavi API dei singoli provider vivono solo nel localStorage della chat desktop, non nel processo Agent Mode). ` +
    `Avvia/installa OmniRoute (badge in alto nella chat AI) oppure scegli un modello Ollama installato localmente.`
  )
}

async function callOllamaDirect(params: ChatCompletionParams): Promise<ChatCompletionResult> {
  let response: Response
  try {
    response = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: params.model,
        messages: toOllamaMessages(params.messages),
        tools: params.tools,
        stream: false,
        ...(params.temperature !== undefined ? { options: { temperature: params.temperature } } : {})
      })
    })
  } catch (err: any) {
    throw new Error(`Errore Ollama: verifica che il demone sia avviato (${err.message}).`)
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => '')
    throw new Error(`Ollama ha risposto con errore ${response.status}: ${errBody.substring(0, 300) || '(modello forse non installato localmente — prova "ollama pull ' + params.model + '")'}`)
  }

  const data = await response.json()
  // Ollama restituisce conteggi token reali in prompt_eval_count/eval_count
  // (non stimati) sulla risposta non-streaming.
  if (typeof data.prompt_eval_count === 'number' || typeof data.eval_count === 'number') {
    recordUsage(params.model, data.prompt_eval_count || 0, data.eval_count || 0)
  }
  return { message: data.message || { role: 'assistant', content: '' } }
}
