import { useState, useEffect } from 'react'
import { getOllamaModelsDetailed, pullOllamaModel, deleteOllamaModel, type OllamaModelInfo } from './services/llm'

// Modelli Ollama popolari e collaudati, curati a mano (non esiste un'API pubblica
// per sfogliare l'intero registry di Ollama). Il campo libero sotto accetta anche
// qualunque altro tag Ollama valido, incluso il formato 'hf.co/utente/repo' che
// Ollama supporta nativamente per scaricare modelli direttamente da Hugging Face.
const CURATED_MODELS = [
  { name: 'qwen2.5-coder:7b', desc: 'Ottimo per coding, leggero' },
  { name: 'llama3.2:3b', desc: 'Generalista, veloce' },
  { name: 'llama3.3:70b', desc: 'Generalista, potente (richiede molta RAM)' },
  { name: 'deepseek-coder-v2:16b', desc: 'Coding avanzato' },
  { name: 'mistral:7b', desc: 'Generalista, bilanciato' },
  { name: 'phi3:mini', desc: 'Piccolissimo, adatto a hardware limitato' },
  { name: 'gemma2:9b', desc: 'Generalista Google' },
  { name: 'nomic-embed-text', desc: 'Embedding per ricerca semantica' },
]

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const gb = bytes / 1e9
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(bytes / 1e6).toFixed(0)} MB`
}

interface ApiKeyField {
  key: string
  label: string
  placeholder: string
  helpUrl?: string
}

const API_KEY_FIELDS: ApiKeyField[] = [
  { key: 'OPENROUTER_API_KEY', label: 'OpenRouter (centinaia di modelli, una sola chiave)', placeholder: 'sk-or-...', helpUrl: 'https://openrouter.ai/keys' },
  { key: 'TOGETHER_API_KEY', label: 'Together AI (inferenza economica open-weight)', placeholder: '...', helpUrl: 'https://api.together.ai/settings/api-keys' },
  { key: 'OPENAI_API_KEY', label: 'OpenAI (GPT-4o, ecc.)', placeholder: 'sk-...', helpUrl: 'https://platform.openai.com/api-keys' },
  { key: 'GEMINI_API_KEY', label: 'Google Gemini', placeholder: 'AIza...', helpUrl: 'https://aistudio.google.com/app/apikey' },
  { key: 'GROQ_API_KEY', label: 'Groq', placeholder: 'gsk_...', helpUrl: 'https://console.groq.com/keys' },
  { key: 'DEEPSEEK_API_KEY', label: 'DeepSeek', placeholder: 'sk-...', helpUrl: 'https://platform.deepseek.com/api_keys' },
  { key: 'XAI_API_KEY', label: 'xAI (Grok)', placeholder: 'xai-...', helpUrl: 'https://console.x.ai' },
  { key: 'DASHSCOPE_API_KEY', label: 'Alibaba DashScope (Qwen Max)', placeholder: 'sk-...', helpUrl: 'https://dashscope.console.aliyun.com/apiKey' },
  { key: 'MOONSHOT_API_KEY', label: 'Moonshot (Kimi)', placeholder: 'sk-...', helpUrl: 'https://platform.moonshot.cn/console/api-keys' },
]

interface SettingsPanelProps {
  onClose: () => void
  currentProjectRoot?: string
}

interface ModelUsage {
  calls: number
  promptTokens: number
  completionTokens: number
}
interface UsageData {
  since: number
  byModel: Record<string, ModelUsage>
}

interface McpServerStatus {
  name: string
  status: 'ready' | 'error'
  error?: string
  toolCount: number
  toolNames: string[]
}

type OmniRouteStatus = 'checking' | 'installing' | 'starting' | 'ready' | 'unavailable'

export default function SettingsPanel({ onClose, currentProjectRoot }: SettingsPanelProps) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [localLlmBaseUrl, setLocalLlmBaseUrl] = useState('')
  const [omniStatus, setOmniStatus] = useState<OmniRouteStatus>('checking')
  const [omniDetail, setOmniDetail] = useState('')
  const [isRetrying, setIsRetrying] = useState(false)
  const [ollamaModels, setOllamaModels] = useState<OllamaModelInfo[] | null>(null)
  const [customPullName, setCustomPullName] = useState('')
  const [pullProgress, setPullProgress] = useState<{ name: string; status: string; percent: number } | null>(null)
  const [pullError, setPullError] = useState<string | null>(null)
  const [deletingModel, setDeletingModel] = useState<string | null>(null)
  const [usage, setUsage] = useState<UsageData | null>(null)
  const [mcpServers, setMcpServers] = useState<McpServerStatus[] | null>(null)
  const [mcpReloading, setMcpReloading] = useState(false)

  const refreshMcpStatus = () => {
    if (!currentProjectRoot) return
    // @ts-ignore
    window.ipcRenderer.invoke('mcp.status', currentProjectRoot).then((res: any) => {
      if (res.success) setMcpServers(res.data)
    })
  }

  const handleReloadMcp = () => {
    if (!currentProjectRoot) return
    setMcpReloading(true)
    // @ts-ignore
    window.ipcRenderer.invoke('mcp.reload', currentProjectRoot).then((res: any) => {
      setMcpReloading(false)
      if (res.success) setMcpServers(res.data)
    })
  }

  const refreshUsage = () => {
    // @ts-ignore
    window.ipcRenderer.invoke('usage.get').then((res: any) => {
      if (res.success) setUsage(res.data)
    })
  }

  const handleResetUsage = () => {
    if (!confirm('Azzerare il contatore di utilizzo (token/chiamate)? Non è reversibile.')) return
    // @ts-ignore
    window.ipcRenderer.invoke('usage.reset').then(refreshUsage)
  }

  const refreshOllamaModels = () => {
    getOllamaModelsDetailed().then(setOllamaModels)
  }

  const handlePullModel = async (name: string) => {
    if (!name.trim() || pullProgress) return
    setPullError(null)
    setPullProgress({ name, status: 'avvio...', percent: 0 })
    try {
      await pullOllamaModel(name.trim(), (status, completed, total) => {
        const percent = total > 0 ? Math.round((completed / total) * 100) : 0
        setPullProgress({ name, status, percent })
      })
      setPullProgress(null)
      setCustomPullName('')
      refreshOllamaModels()
    } catch (err: any) {
      setPullError(`Errore scaricando '${name}': ${err.message}`)
      setPullProgress(null)
    }
  }

  const handleDeleteModel = async (name: string) => {
    if (!confirm(`Rimuovere il modello '${name}' da questo Mac? Libererà spazio su disco, potrai riscaricarlo in qualsiasi momento.`)) return
    setDeletingModel(name)
    try {
      await deleteOllamaModel(name)
      refreshOllamaModels()
    } catch (err: any) {
      alert(`Errore rimuovendo '${name}': ${err.message}`)
    } finally {
      setDeletingModel(null)
    }
  }

  useEffect(() => {
    refreshOllamaModels()
    refreshUsage()
    refreshMcpStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const initial: Record<string, string> = {}
    API_KEY_FIELDS.forEach(f => {
      initial[f.key] = localStorage.getItem(f.key) || ''
    })
    setValues(initial)
    setLocalLlmBaseUrl(localStorage.getItem('LOCAL_LLM_BASE_URL') || '')

    // @ts-ignore
    window.ipcRenderer.invoke('get-omniroute-status').then((res: any) => {
      if (res.ready) setOmniStatus('ready')
    })

    // @ts-ignore
    const removeListener = window.ipcRenderer.on('omniroute-status', (_e: any, payload: any) => {
      setOmniStatus(payload.status)
      setOmniDetail(payload.detail || '')
      if (payload.status === 'ready' || payload.status === 'unavailable') setIsRetrying(false)
    })

    return () => {
      // @ts-ignore
      if (removeListener && typeof removeListener === 'function') removeListener()
    }
  }, [])

  const handleFieldChange = (key: string, value: string) => {
    setValues(prev => ({ ...prev, [key]: value }))
    if (value.trim()) {
      localStorage.setItem(key, value.trim())
    } else {
      localStorage.removeItem(key)
    }
  }

  const handleLocalUrlChange = (value: string) => {
    setLocalLlmBaseUrl(value)
    if (value.trim()) {
      localStorage.setItem('LOCAL_LLM_BASE_URL', value.trim())
    } else {
      localStorage.removeItem('LOCAL_LLM_BASE_URL')
    }
  }

  const handleRetryOmniRoute = () => {
    setIsRetrying(true)
    setOmniStatus('checking')
    // @ts-ignore
    window.ipcRenderer.invoke('retry-omniroute')
  }

  const statusLabel: Record<OmniRouteStatus, string> = {
    checking: '🟡 Verifica in corso...',
    installing: '🟡 Installazione in corso...',
    starting: '🟡 Avvio in corso...',
    ready: '🟢 Attivo',
    unavailable: '⚪ Non disponibile (fallback su Ollama locale)'
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-[#252526] text-gray-200 rounded-lg shadow-xl w-full max-w-lg max-h-[85vh] overflow-y-auto border border-[#333]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-[#333] sticky top-0 bg-[#252526]">
          <h2 className="text-sm font-semibold uppercase tracking-wide">⚙️ Impostazioni</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none px-2">✕</button>
        </div>

        <div className="p-4 flex flex-col gap-6">
          {/* Utilizzo cumulativo: token/chiamate reali per modello, NON un costo in $
              (i prezzi dei provider variano/cambiano — meglio un numero onesto che
              una stima di spesa inventata). Persistito, sopravvive al riavvio dell'app. */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Utilizzo</h3>
              {usage && Object.keys(usage.byModel).length > 0 && (
                <button onClick={handleResetUsage} className="text-[10px] text-gray-500 hover:text-red-400">Azzera</button>
              )}
            </div>
            <div className="bg-[#1e1e1e] rounded p-3 text-sm">
              {!usage || Object.keys(usage.byModel).length === 0 ? (
                <p className="text-xs text-gray-500 italic">Nessun utilizzo registrato da {usage ? new Date(usage.since).toLocaleDateString() : 'ora'}.</p>
              ) : (
                <div className="flex flex-col gap-1">
                  <div className="text-[10px] text-gray-500 mb-1">
                    Token e chiamate reali per modello (non un costo in $ — i prezzi dei provider cambiano, non li teniamo qui). Dal {new Date(usage.since).toLocaleDateString()}.
                  </div>
                  {Object.entries(usage.byModel).sort((a, b) => (b[1].promptTokens + b[1].completionTokens) - (a[1].promptTokens + a[1].completionTokens)).map(([model, u]) => (
                    <div key={model} className="flex items-center justify-between bg-[#252526] rounded px-2 py-1.5">
                      <div className="min-w-0 text-xs text-gray-300 truncate" title={model}>{model}</div>
                      <div className="text-[10px] text-gray-500 shrink-0">
                        {u.calls} chiamate · {(u.promptTokens + u.completionTokens).toLocaleString()} token
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* Server MCP: connessioni reali (JSON-RPC su stdio) a server di terze parti
              configurati in <progetto>/.code-ide/mcp.json — i loro tool si aggiungono
              automaticamente a quelli dell'agente. */}
          {currentProjectRoot && (
            <section>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Server MCP</h3>
                <button onClick={handleReloadMcp} disabled={mcpReloading} className="text-[10px] text-gray-500 hover:text-white disabled:opacity-50">
                  {mcpReloading ? 'Ricarico...' : '↻ Ricarica'}
                </button>
              </div>
              <div className="bg-[#1e1e1e] rounded p-3 text-sm">
                {!mcpServers || mcpServers.length === 0 ? (
                  <p className="text-xs text-gray-500 italic">
                    Nessun server configurato. Crea <code className="text-gray-400">.code-ide/mcp.json</code> nella root del progetto, es.:
                    <br />
                    <code className="text-[10px] text-gray-400 block mt-1 whitespace-pre">{'{ "mcpServers": { "nome": { "command": "npx", "args": ["-y", "@pacchetto/server"] } } }'}</code>
                  </p>
                ) : (
                  <div className="flex flex-col gap-1">
                    {mcpServers.map(s => (
                      <div key={s.name} className="bg-[#252526] rounded px-2 py-1.5">
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-gray-200">{s.name}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded ${s.status === 'ready' ? 'bg-green-900/50 text-green-300' : 'bg-red-900/50 text-red-300'}`}>
                            {s.status === 'ready' ? `🟢 ${s.toolCount} tool` : '🔴 Errore'}
                          </span>
                        </div>
                        {s.status === 'error' && <div className="text-[10px] text-red-400 mt-0.5">{s.error}</div>}
                        {s.status === 'ready' && s.toolNames.length > 0 && (
                          <div className="text-[10px] text-gray-500 mt-0.5 truncate" title={s.toolNames.join(', ')}>{s.toolNames.join(', ')}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Gestione modelli Ollama: scarica/rimuovi, vedi cosa è davvero installato */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">Modelli locali (Ollama)</h3>
            <div className="bg-[#1e1e1e] rounded p-3 text-sm flex flex-col gap-3">
              {/* Il tool 'semantic_search' (N-03) richiede specificamente questo
                  modello per generare gli embedding — prima l'unico modo per
                  scoprire che mancava era farlo fallire dal vivo dentro un run
                  dell'agente, con un errore visibile solo nello stream della chat. */}
              {ollamaModels && (
                <div className={`text-xs rounded px-2 py-1.5 ${ollamaModels.some(m => m.name.startsWith('nomic-embed-text')) ? 'bg-green-900/30 text-green-300' : 'bg-yellow-900/30 text-yellow-300'}`}>
                  {ollamaModels.some(m => m.name.startsWith('nomic-embed-text'))
                    ? '✅ Ricerca semantica (tool "semantic_search"): pronta — nomic-embed-text installato.'
                    : '⚠️ Ricerca semantica (tool "semantic_search") non disponibile: installa "nomic-embed-text" qui sotto per abilitarla.'}
                </div>
              )}
              <div>
                <div className="text-xs text-gray-400 mb-1.5">Installati su questo Mac{ollamaModels ? ` (${ollamaModels.length})` : ''}</div>
                {ollamaModels === null && <p className="text-xs text-gray-500 italic">Verifica in corso...</p>}
                {ollamaModels?.length === 0 && (
                  <p className="text-xs text-gray-500 italic">Nessun modello installato, o Ollama non è in esecuzione.</p>
                )}
                {ollamaModels && ollamaModels.length > 0 && (
                  <div className="flex flex-col gap-1">
                    {ollamaModels.map(m => (
                      <div key={m.name} className="flex items-center justify-between bg-[#252526] rounded px-2 py-1.5">
                        <div className="min-w-0">
                          <div className="text-sm text-gray-200 truncate" title={m.name}>{m.name}</div>
                          <div className="text-[10px] text-gray-500">{formatBytes(m.sizeBytes)} · {m.paramSize} parametri</div>
                        </div>
                        <button
                          onClick={() => handleDeleteModel(m.name)}
                          disabled={deletingModel === m.name}
                          className="text-xs px-2 py-1 bg-red-900/40 text-red-300 hover:bg-red-900/70 rounded disabled:opacity-50 shrink-0"
                        >
                          {deletingModel === m.name ? 'Rimuovo...' : 'Rimuovi'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="border-t border-[#333] pt-3">
                <div className="text-xs text-gray-400 mb-1.5">Scarica un modello</div>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {CURATED_MODELS.filter(c => !ollamaModels?.some(m => m.name === c.name || m.name.startsWith(c.name.split(':')[0] + ':'))).map(c => (
                    <button
                      key={c.name}
                      onClick={() => handlePullModel(c.name)}
                      disabled={!!pullProgress}
                      title={c.desc}
                      className="text-xs px-2 py-1 bg-[#37373d] hover:bg-[#4d4d54] rounded disabled:opacity-50"
                    >
                      + {c.name}
                    </button>
                  ))}
                </div>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={customPullName}
                    onChange={e => setCustomPullName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handlePullModel(customPullName)}
                    placeholder="es. qwen2.5:14b oppure hf.co/utente/repo"
                    disabled={!!pullProgress}
                    className="flex-1 min-w-0 bg-[#252526] text-sm text-gray-200 border border-[#444] rounded px-2 py-1.5 outline-none focus:border-blue-500 disabled:opacity-50"
                  />
                  <button
                    onClick={() => handlePullModel(customPullName)}
                    disabled={!!pullProgress || !customPullName.trim()}
                    className="text-xs px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50 shrink-0"
                  >
                    Scarica
                  </button>
                </div>
                {pullProgress && (
                  <div className="mt-2">
                    <div className="text-[10px] text-gray-400 mb-1">{pullProgress.name}: {pullProgress.status} {pullProgress.percent > 0 ? `(${pullProgress.percent}%)` : ''}</div>
                    <div className="w-full h-1.5 bg-[#252526] rounded overflow-hidden">
                      <div className="h-full bg-blue-500 transition-all" style={{ width: `${pullProgress.percent}%` }} />
                    </div>
                  </div>
                )}
                {pullError && <p className="text-xs text-red-400 mt-2">{pullError}</p>}
                <p className="text-[10px] text-gray-500 mt-2">
                  Richiede Ollama installato e in esecuzione. Modelli grandi possono richiedere molto tempo/spazio disco.
                </p>
              </div>
            </div>
          </section>

          {/* OmniRoute */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">OmniRoute</h3>
            <div className="bg-[#1e1e1e] rounded p-3 text-sm flex flex-col gap-2">
              <p className="text-gray-300">
                OmniRoute è un gateway locale che dà accesso a 1200+ modelli (Claude, GPT, Gemini, DeepSeek, ecc.)
                tramite un unico endpoint, senza gestire una chiave API per ogni provider. Code-IDE lo rileva,
                installa e avvia automaticamente in background all'apertura; se non è disponibile, l'Agent Mode
                ricade su Ollama locale.
              </p>
              <div className="flex items-center justify-between">
                <span className="font-medium">{statusLabel[omniStatus]}</span>
                <button
                  onClick={handleRetryOmniRoute}
                  disabled={isRetrying}
                  className="text-xs px-2 py-1 bg-[#37373d] hover:bg-[#4d4d54] rounded disabled:opacity-50"
                >
                  {isRetrying ? 'Riprovo...' : 'Riprova'}
                </button>
              </div>
              {omniDetail && <p className="text-xs text-gray-500 break-words">{omniDetail}</p>}
              <p className="text-xs text-gray-500">
                Per configurare provider/quote/API key dentro OmniRoute stesso, apri la sua dashboard su{' '}
                <span className="text-blue-400">http://localhost:20128</span> mentre è in esecuzione.
                Al primo accesso chiede una password: se questa app l'ha appena installato/avviato, la trovi
                qui sopra ("password iniziale"); se invece OmniRoute era già installato da prima (es. via Homebrew)
                e non ricordi di averla impostata, prova <code className="text-gray-400">CHANGEME</code> (il default
                di OmniRoute quando <code className="text-gray-400">INITIAL_PASSWORD</code> non è configurata —
                non fidarti del "123456" mostrato dalla sua pagina di login, è un bug noto del progetto), poi
                cambiala subito da Configurazione → Sicurezza.
                Per usare i suoi modelli via chiave protetta, aggiungi <code className="text-gray-400">OMNIROUTE_API_KEY</code>{' '}
                al file <code className="text-gray-400">.env</code> nella root del progetto.
              </p>
            </div>
          </section>

          {/* Modello locale personalizzato */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">Server locale personalizzato</h3>
            <p className="text-xs text-gray-500 mb-2">
              Per altri runtime locali OpenAI-compatibili (text-generation-webui, llama.cpp server, TGI, ecc.)
              diversi da Ollama/LM Studio. Seleziona "Server locale personalizzato" nel menu modelli della chat.
            </p>
            <input
              type="text"
              value={localLlmBaseUrl}
              onChange={e => handleLocalUrlChange(e.target.value)}
              placeholder="http://localhost:5000/v1"
              className="w-full bg-[#1e1e1e] text-sm text-gray-200 border border-[#444] rounded px-2 py-1.5 outline-none focus:border-blue-500"
            />
          </section>

          {/* Chiavi API provider a pagamento */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">Chiavi API (modelli commerciali)</h3>
            <p className="text-xs text-gray-500 mb-3">
              Salvate solo in locale nel browser dell'app (localStorage), mai inviate altrove se non al provider scelto.
              Servono per la chat normale; per l'Agent Mode senza OmniRoute solo i modelli Ollama/LM Studio/locali sono raggiungibili.
            </p>
            <div className="flex flex-col gap-3">
              {API_KEY_FIELDS.map(field => (
                <div key={field.key} className="flex flex-col gap-1">
                  <label className="text-xs text-gray-400 flex items-center justify-between">
                    <span>{field.label}</span>
                    {field.helpUrl && (
                      <a href={field.helpUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">
                        ottieni chiave ↗
                      </a>
                    )}
                  </label>
                  <input
                    type="password"
                    value={values[field.key] || ''}
                    onChange={e => handleFieldChange(field.key, e.target.value)}
                    placeholder={field.placeholder}
                    className="w-full bg-[#1e1e1e] text-sm text-gray-200 border border-[#444] rounded px-2 py-1.5 outline-none focus:border-blue-500"
                  />
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
