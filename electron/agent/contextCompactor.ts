import { BrowserWindow } from 'electron'
import { chatCompletion } from './llmClient'
import { broadcastAgentStream } from '../services/outputBuffer'

// Stima ~4 caratteri/token (stessa euristica di src/services/tokenCounter.ts,
// duplicata qui invece che importata: electron/ e src/ sono due scope di build
// separati — vite-plugin-electron per il main process, Vite normale per il
// renderer — cross-importare tra i due creerebbe complicazioni nel bundling
// senza un beneficio reale per una funzione di 3 righe).
function estimateTokensFromChars(charCount: number): number {
  return Math.ceil(charCount / 4)
}

// Finestre note per i modelli commerciali/cloud più comuni nel menu; per i tag
// Ollama locali non abbiamo un modo affidabile di interrogare la context length
// da questo processo (quell'informazione vive solo nel renderer, via /api/show),
// quindi usiamo una stima prudente configurabile.
const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-3-5-sonnet': 200000,
  'gpt-4o': 128000,
  'gemini-1.5-pro': 1000000,
  'grok-2': 131072,
  'qwen-max': 32768,
  'deepseek-coder': 32768,
  'llama-3.3-70b-groq': 128000,
  'hf-inference-api': 4096,
  'z-ai': 8192,
  'sakana': 8192,
  'kimi-k3': 200000,
}

function getEstimatedContextWindow(model: string): number {
  const envOverride = Number(process.env.AGENT_CONTEXT_WINDOW_TOKENS)
  if (Number.isFinite(envOverride) && envOverride > 0) return envOverride
  const bareModel = model.includes(':') && !model.match(/^[\w.-]+:[\w.-]+$/) ? model.split(':').slice(1).join(':') : model
  return KNOWN_CONTEXT_WINDOWS[bareModel] || KNOWN_CONTEXT_WINDOWS[model] || 32768
}

const COMPACTION_TRIGGER_RATIO = 0.75
const KEEP_RECENT_MESSAGES = 6
const MIN_MESSAGES_TO_COMPACT = 10

/**
 * Compatta in-place l'array 'messages' di un loop agentico quando si avvicina
 * al limite di contesto stimato del modello: sostituisce i messaggi più
 * vecchi (system prompt e user prompt originali ESCLUSI, sempre agli indici
 * 0-1; e gli ultimi KEEP_RECENT_MESSAGES sempre intatti) con un unico riassunto
 * denso generato da una chiamata LLM dedicata. Prima di questa funzione, un
 * task agentico lungo (molte iterazioni, tool result voluminosi come repo-map
 * o read_file) non aveva alcun meccanismo per evitare di saturare/superare la
 * finestra di contesto — semplicemente falliva o degradava silenziosamente.
 * Ritorna true se ha effettivamente compattato.
 */
export async function compactMessagesIfNeeded(messages: any[], model: string, mainWindow: BrowserWindow, runId?: string): Promise<boolean> {
  if (messages.length < MIN_MESSAGES_TO_COMPACT) return false
  if (messages.length <= 2 + KEEP_RECENT_MESSAGES) return false

  const totalChars = messages.reduce((sum, m) => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')
    return sum + content.length
  }, 0)
  const estimatedTokens = estimateTokensFromChars(totalChars)
  const windowLimit = getEstimatedContextWindow(model)

  if (estimatedTokens < windowLimit * COMPACTION_TRIGGER_RATIO) return false

  const toSummarize = messages.slice(2, messages.length - KEEP_RECENT_MESSAGES)
  if (toSummarize.length === 0) return false

  broadcastAgentStream(mainWindow, { type: 'status', message: `[🗜️ Contesto al ${Math.round((estimatedTokens / windowLimit) * 100)}% stimato — compatto ${toSummarize.length} messaggi più vecchi...]` }, runId)

  const transcript = toSummarize.map(m => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    return `[${m.role}${m.name ? `:${m.name}` : ''}] ${content}`
  }).join('\n\n').slice(0, 40000)

  let summary: string
  try {
    const result = await chatCompletion({
      model,
      messages: [
        {
          role: 'system',
          content: "Riassumi in modo denso e fedele questa porzione di conversazione tra un agente di programmazione e i risultati dei suoi tool. Includi SEMPRE fatti concreti necessari per continuare il task: nomi/percorsi di file letti o modificati, comandi eseguiti e il loro esito, errori o vincoli emersi, decisioni prese. Ometti solo il testo ridondante (es. contenuti di file già riassumibili in una riga). Non aggiungere commenti tuoi, solo il riassunto."
        },
        { role: 'user', content: transcript }
      ]
    })
    summary = result.message?.content || ''
    if (!summary.trim()) throw new Error('riassunto vuoto')
  } catch (err: any) {
    // Se il riassunto stesso fallisce, meglio continuare senza compattare che
    // perdere silenziosamente contesto rilevante per il task.
    broadcastAgentStream(mainWindow, { type: 'status', message: `[⚠️ Compattazione contesto fallita (${err.message}), proseguo senza compattare]` }, runId)
    return false
  }

  const compactedEntry = {
    role: 'user',
    content: `[CONTESTO COMPATTATO — riassunto di ${toSummarize.length} messaggi precedenti, generato automaticamente per restare nella finestra di contesto]\n${summary}`
  }

  messages.splice(2, toSummarize.length, compactedEntry)

  broadcastAgentStream(mainWindow, { type: 'status', message: `[🗜️ Contesto compattato: ${toSummarize.length} messaggi → 1 riassunto]` }, runId)
  return true
}
