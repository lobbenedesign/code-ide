import { useState, useRef, useEffect } from 'react'
import { skillManager } from './SkillManager'
import { sendLLMRequest, runReadOnlyToolStep, type Message as LlmMessage, type LLMResponse } from './services/llm'
import { getOllamaModels, getLMStudioModels, getOllamaContextLengths, looksLikeOllamaTag } from './services/llm'
import { estimateTokens, getContextWindowForModel } from './services/tokenCounter'
import { NativeAudioPanel } from './components/NativeAudioPanel'
import { isNativeAudioModel } from './services/nativeAudioModels'
import { StepContinueModal } from './components/StepContinueModal'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  images?: string[] // Base64
  isPlan?: boolean // true per un piano in attesa di approvazione (Plan Mode)
  planApproved?: boolean // impedisce di rieseguire/riapprovare lo stesso piano più volte
  runId?: string // collega il messaggio al run dell'harness che l'ha generato (checkpoint/rewind)
  resolvedModel?: string // modello che ha risposto DAVVERO (da OmniRoute/OpenRouter), se diverso da quello selezionato nel menu
  // Documenti allegati con la graffetta 📎 inviati con questo messaggio — prima
  // non venivano mostrati affatto nella bolla (bug reale: un messaggio con
  // SOLO un allegato e nessun testo appariva come una bolla vuota, senza
  // alcun modo di sapere quale file fosse stato inviato).
  attachedDocs?: { name: string, content: string }[]
}

interface SessionSummary {
  id: string
  title: string
  model: string
  messageCount: number
  updatedAt: number
}

interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

interface CommandDefinition {
  name: string
  description: string
  body: string
}

// Euristica (non un classificatore ML: un semplice elenco di verbi con \b, in
// linea con lo stile pragmatico già usato altrove nel codice, es.
// looksLikeOllamaTag) per capire quando un messaggio in chat NORMALE sta
// probabilmente chiedendo di scrivere/eseguire qualcosa — un caso reale:
// "crea una cartella e scrivimi un progetto di backup" inviato senza Agent
// Mode attivo ha prodotto solo codice a schermo, mai scritto su disco. Elenco
// ampio IT+EN di verbi di creazione/modifica/esecuzione: meglio un falso
// positivo occasionale (il banner si ignora con un click) che continuare a
// perdere silenziosamente lavoro reale mai scritto.
const WRITE_INTENT_PATTERN = new RegExp(
  '\\b(' + [
    // Italiano
    'crea', 'creare', 'creami', 'scrivi', 'scrivimi', 'scrivere', 'genera', 'generare', 'generami',
    'implementa', 'implementare', 'costruisci', 'costruire', 'sviluppa', 'sviluppare',
    'aggiungi', 'aggiungere', 'modifica', 'modificare', 'correggi', 'correggere',
    'sistema', 'sistemare', 'ripara', 'riparare', 'fixa', 'fixare', 'aggiusta', 'aggiustare',
    'refactora', 'refactorizza', 'rimuovi', 'rimuovere', 'elimina', 'eliminare', 'cancella', 'cancellare',
    'installa', 'installare', 'configura', 'configurare', 'esegui', 'eseguire',
    'lancia', 'lanciare', 'avvia', 'avviare', 'patcha', 'patchare', 'aggiorna', 'aggiornare',
    'pusha', 'pushare', 'committa', 'committare', 'pubblica', 'pubblicare',
    'testa', 'testare', 'debugga', 'debuggare', 'ottimizza', 'ottimizzare',
    'integra', 'integrare', 'collega', 'collegare', 'rinomina', 'rinominare',
    'sposta', 'spostare', 'riscrivi', 'riscrivere', 'converti', 'convertire',
    // English
    'create', 'write', 'generate', 'implement', 'build', 'develop', 'add', 'modify', 'edit',
    'fix', 'repair', 'patch', 'remove', 'delete', 'install', 'configure', 'setup', 'set up',
    'run', 'execute', 'launch', 'start', 'deploy', 'push', 'commit', 'publish', 'test', 'debug',
    'optimize', 'refactor', 'integrate', 'wire up', 'hook up', 'scaffold', 'rename', 'move',
    'rewrite', 'convert'
  ].join('|') + ')\\b',
  'i'
)

const WELCOME_MESSAGE: Message = {
  id: '1',
  role: 'assistant',
  content: 'Ciao! Sono il tuo Assistente Agentico. Posso aiutarti a scrivere codice, spiegare frammenti o navigare il progetto. Come posso aiutarti oggi?'
}

interface AiChatProps {
  currentFilePath: string | null
  activeCode: string
  currentProjectRoot: string
  onOpenSettings: () => void
  // Apre un file nell'editor centrale — usato per mostrare VISIVAMENTE quale
  // file il modello sta leggendo durante la chat normale (non-Agent-Mode),
  // così non resta un'operazione invisibile che l'utente deve fidarsi sia
  // avvenuta solo perché il modello lo dice a parole.
  onOpenFile?: (filePath: string) => void
  // Apre un documento allegato (📎, testo già letto in memoria — non
  // necessariamente dentro al progetto) in una scheda "virtuale" dell'editor,
  // così è consultabile con un click invece di dover riaprire il file
  // originale a mano dal proprio computer.
  onOpenVirtualFile?: (name: string, content: string) => void
}

export default function AiChat({ currentFilePath, activeCode, currentProjectRoot, onOpenSettings, onOpenFile, onOpenVirtualFile }: AiChatProps) {
  const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessionList, setSessionList] = useState<SessionSummary[]>([])
  const [showSessionList, setShowSessionList] = useState(false)
  // Evita di salvare la sessione appena caricata (o il messaggio di benvenuto
  // iniziale) come se fosse una modifica dell'utente — solo i cambiamenti reali
  // successivi al caricamento vengono persistiti.
  const skipNextSaveRef = useRef(true)
  const [input, setInput] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  // Ricorda l'ultimo modello scelto tra un avvio e l'altro: senza questo,
  // ogni riapertura dell'app ripartiva sempre dal default hardcoded
  // 'qwen2.5-coder:latest', ignorando qualunque scelta fatta dall'utente.
  const DEFAULT_MODEL = 'qwen2.5-coder:latest'
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem('SELECTED_MODEL') || DEFAULT_MODEL)
  const [activeSkillsCount, setActiveSkillsCount] = useState(0)
  const [isAgentMode, setIsAgentMode] = useState(false)
  // Banner "vuoi attivare Agent Mode?" in attesa di una scelta dell'utente —
  // vedi WRITE_INTENT_PATTERN/handleSend.
  const [pendingAgentModeSuggestion, setPendingAgentModeSuggestion] = useState(false)
  const [isDeepReasoning, setIsDeepReasoning] = useState(false)
  const [isPlanMode, setIsPlanMode] = useState(false)
  // Ricorda il prompt/contesto dell'ultimo piano generato, per poterlo rieseguire
  // per intero (con accesso completo ai tool) quando l'utente approva.
  const lastPlanRequestRef = useRef<{ userPrompt: string; systemPrompt: string; images?: string[] } | null>(null)
  const [attachedImages, setAttachedImages] = useState<string[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [isNativeAudioActive, setIsNativeAudioActive] = useState(false)
  // Modale di conferma tra uno step e il successivo di una revisione multi-file
  // in chat normale (vedi runReadOnlyToolStep) — null quando non c'è nessuna
  // pausa in corso. 'resolve' sblocca la Promise che l'orchestratore dello
  // step sta attendendo (vedi runSteppedReadOnlyChat più sotto).
  const [stepModalRequest, setStepModalRequest] = useState<{
    stepNumber: number
    filesReadThisStep: string[]
    totalFiles: number
    totalFolders: number
    resolve: (choice: 'once' | 'auto' | 'stop') => void
  } | null>(null)
  const [omniRouteStatus, setOmniRouteStatus] = useState<'checking' | 'installing' | 'starting' | 'ready' | 'unavailable'>('checking')
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [duckAiModels, setDuckAiModels] = useState<Array<{ id: string, label: string }>>([])
  const [sakanaAuthed, setSakanaAuthed] = useState(false)
  const [lmStudioModels, setLmStudioModels] = useState<string[]>([])
  const [ollamaContextLengths, setOllamaContextLengths] = useState<Record<string, number>>({})
  const [tokenUsage, setTokenUsage] = useState<{ used: number; window: number } | null>(null)
  const [projectFiles, setProjectFiles] = useState<string[]>([])
  const [pinnedFiles, setPinnedFiles] = useState<string[]>([])
  // Documenti allegati via graffetta 📎 (testo semplice, letto per intero come
  // contesto) — a differenza di 'pinnedFiles' (@-mention di file GIÀ nel
  // progetto aperto), questi possono venire da qualunque punto del disco.
  const [attachedDocuments, setAttachedDocuments] = useState<{ name: string, content: string }[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [commandDefinitions, setCommandDefinitions] = useState<CommandDefinition[]>([])
  const [agentTodos, setAgentTodos] = useState<TodoItem[]>([])
  const [checkpointsByRunId, setCheckpointsByRunId] = useState<Record<string, { fileCount: number; taskSummary: string }>>({})
  const [revertingRunId, setRevertingRunId] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const saveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refreshSessionList = (root: string) => {
    if (!root) { setSessionList([]); return }
    // @ts-ignore
    window.ipcRenderer.invoke('session.list', root).then((res: any) => {
      if (res.success) setSessionList(res.data)
    })
  }

  useEffect(() => {
    // Elenco file per l'autocomplete @-mention (pin esplicito di contesto, come in Cursor)
    if (!currentProjectRoot) { setProjectFiles([]); return }
    // @ts-ignore
    window.ipcRenderer.invoke('list-project-files', currentProjectRoot).then((res: any) => {
      if (res.success) setProjectFiles(res.data)
    })
  }, [currentProjectRoot])

  useEffect(() => {
    // Comandi slash (.code-ide/commands/*.md): template di prompt riusabili,
    // invocabili con '/nome argomenti' invece di riscrivere lo stesso prompt lungo ogni volta.
    if (!currentProjectRoot) { setCommandDefinitions([]); return }
    // @ts-ignore
    window.ipcRenderer.invoke('commands.list', currentProjectRoot).then((res: any) => {
      if (res.success) setCommandDefinitions(res.data)
    })
  }, [currentProjectRoot])

  // Persistenza sessioni: quando si apre/cambia progetto, riprende automaticamente
  // l'ultima conversazione salvata per quel progetto (se esiste) invece di partire
  // sempre da zero — prima la chat viveva solo in memoria e spariva alla chiusura.
  useEffect(() => {
    if (!currentProjectRoot) {
      setMessages([WELCOME_MESSAGE])
      setSessionId(null)
      return
    }

    skipNextSaveRef.current = true
    // @ts-ignore
    window.ipcRenderer.invoke('session.list', currentProjectRoot).then((res: any) => {
      if (res.success && res.data.length > 0) {
        setSessionList(res.data)
        const mostRecent = res.data[0]
        // @ts-ignore
        window.ipcRenderer.invoke('session.load', currentProjectRoot, mostRecent.id).then((loadRes: any) => {
          if (loadRes.success) {
            skipNextSaveRef.current = true
            setMessages(loadRes.data.messages)
            setSessionId(loadRes.data.id)
          }
        })
      } else {
        setSessionList([])
        setMessages([WELCOME_MESSAGE])
        setSessionId(null)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProjectRoot])

  // Auto-save con debounce: durante lo streaming dell'agente 'messages' cambia
  // molto spesso (una riga alla volta) — senza debounce scriveremmo su disco a
  // ogni singolo aggiornamento. Non salva finché non c'è almeno uno scambio reale
  // (il solo messaggio di benvenuto non genera mai un file di sessione vuoto).
  useEffect(() => {
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false
      return
    }
    if (!currentProjectRoot || messages.length <= 1) return

    if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current)
    saveDebounceRef.current = setTimeout(() => {
      const idToUse = sessionId || (window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`)
      if (!sessionId) setSessionId(idToUse)

      const firstUserMsg = messages.find(m => m.role === 'user')
      const title = firstUserMsg ? firstUserMsg.content.slice(0, 60) : 'Nuova conversazione'

      // @ts-ignore
      window.ipcRenderer.invoke('session.save', {
        id: idToUse,
        projectRoot: currentProjectRoot,
        title,
        model: selectedModel,
        messages,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }).then(() => refreshSessionList(currentProjectRoot))
    }, 800)

    return () => {
      if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages])

  const handleNewChat = () => {
    skipNextSaveRef.current = true
    setMessages([WELCOME_MESSAGE])
    setSessionId(null)
    setShowSessionList(false)
  }

  const handleLoadSession = (id: string) => {
    if (!currentProjectRoot) return
    // @ts-ignore
    window.ipcRenderer.invoke('session.load', currentProjectRoot, id).then((res: any) => {
      if (res.success) {
        skipNextSaveRef.current = true
        setMessages(res.data.messages)
        setSessionId(res.data.id)
        setShowSessionList(false)
      }
    })
  }

  const handleDeleteSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!currentProjectRoot) return
    // @ts-ignore
    window.ipcRenderer.invoke('session.delete', currentProjectRoot, id).then(() => {
      refreshSessionList(currentProjectRoot)
      if (id === sessionId) handleNewChat()
    })
  }

  useEffect(() => {
    localStorage.setItem('SELECTED_MODEL', selectedModel)
  }, [selectedModel])

  useEffect(() => {
    // Elenca i modelli locali REALMENTE disponibili (non tag inventati): evita di
    // proporre nel menu un modello che poi fallisce con un 404 travestito da
    // "demone non avviato".
    getOllamaModels().then(names => {
      setOllamaModels(names)
      // Sostituisce il default hardcoded mai scelto davvero dall'utente, MA
      // anche un tag Ollama restaurato da localStorage che non esiste più in
      // questa installazione — bug reale trovato dopo il fix di persistenza:
      // se l'utente aveva selezionato 'qwen2.5:7b' e poi lo rimuove/reinstalla
      // Ollama con un tag diverso, la vecchia selezione veniva preservata
      // all'infinito (perché non è il DEFAULT_MODEL) e ogni richiesta falliva
      // con 404 "model not found" senza che il menu lo segnalasse in alcun
      // modo. Un modello NON-Ollama restaurato (es. 'omniroute:auto',
      // 'gpt-4o') va sempre rispettato anche se non compare qui — questo
      // controllo si applica SOLO a selezioni che sembrano davvero tag Ollama.
      if (names.length > 0 && !names.includes(selectedModel) && (selectedModel === DEFAULT_MODEL || looksLikeOllamaTag(selectedModel))) {
        setSelectedModel(names[0])
      }
    })
    getLMStudioModels().then(setLmStudioModels)
    getOllamaContextLengths().then(setOllamaContextLengths)

    // Recupera i modelli gratuiti da Duck.ai (auto-discovery con cache)
    // @ts-ignore
    window.ipcRenderer.invoke('get-duckai-models').then((res: any) => {
      if (res?.success && Array.isArray(res.data)) {
        setDuckAiModels(res.data)
      }
    }).catch(() => {})

    // Controlla stato autenticazione Sakana AI
    // @ts-ignore
    window.ipcRenderer.invoke('sakana-status').then((res: any) => {
      if (res?.success) setSakanaAuthed(!!res.authenticated)
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    // Legge subito lo stato ATTUALE (get-omniroute-status), oltre ad ascoltare
    // i push futuri sotto — trovato un bug reale: ensureOmniRoute() nel main
    // process gira una volta sola all'avvio e può risolversi PRIMA che questo
    // componente monti il listener 'omniroute-status' (es. dopo un reload
    // della finestra, o semplicemente per timing), perdendo per sempre l'unico
    // evento 'ready' mai inviato — il badge restava bloccato su "verifica in
    // corso" e il gruppo OmniRoute nel menu modelli non appariva mai, anche a
    // gateway realmente pronto.
    // @ts-ignore
    window.ipcRenderer.invoke('get-omniroute-status').then((res: any) => {
      if (res?.ready) setOmniRouteStatus('ready')
    })

    // Ascolta lo stato del provisioning di OmniRoute (avvio/installazione in background).
    // Se genera una password iniziale (primo avvio pulito), la mostriamo come messaggio
    // in chat invece di lasciarla solo nel tooltip: è facile da perdere altrimenti, e
    // senza saperla l'utente resta bloccato al login della dashboard.
    // @ts-ignore
    const removeOmniRouteStatus = window.ipcRenderer.on('omniroute-status', (_event: any, payload: any) => {
      setOmniRouteStatus(payload.status)
      if (payload.status === 'ready' && payload.detail && payload.detail.includes('password iniziale')) {
        setMessages(prev => [...prev, {
          id: `omniroute-guide-${Date.now()}`,
          role: 'assistant',
          content:
            `🔑 OmniRoute è attivo su http://localhost:20128\n\n${payload.detail}\n\n` +
            `Nota: se OmniRoute era già installato/configurato in precedenza su questo Mac (es. via Homebrew, ` +
            `già avviato prima di aprire Code-IDE), questa password NON si applica — l'istanza esistente ha già ` +
            `una password propria. In quel caso, se non la ricordi, prova "CHANGEME" (il default di OmniRoute quando ` +
            `INITIAL_PASSWORD non è configurata — ignora eventuali "123456" mostrati dalla sua pagina di login, è un bug ` +
            `noto del progetto), poi cambiala subito da Configurazione → Sicurezza nella dashboard.`
        }])
      }
    })

    return () => {
      // @ts-ignore
      if (removeOmniRouteStatus && typeof removeOmniRouteStatus === 'function') removeOmniRouteStatus()
    }
  }, [])

  useEffect(() => {
    // Ascolta lo stream dell'agente
    // @ts-ignore
    const removeStream = window.ipcRenderer.on('agent-stream', (event, payload) => {
      const { type, message, taskFullyVerified } = payload

      const isFinal = type === 'done' || type === 'error' || type === 'plan'

      setMessages(prev => {
        const lastMsg = prev[prev.length - 1]

        if (lastMsg && lastMsg.role === 'assistant' && lastMsg.id === 'agent-current') {
          // Aggiungi nuova linea. Su evento finale assegniamo un id definitivo
          // cosi' il prossimo run dell'agente (nuovo placeholder 'agent-current')
          // non collida con questo messaggio ormai concluso.
          const updatedMsg: Message = {
            ...lastMsg,
            id: isFinal ? Date.now().toString() : lastMsg.id,
            content: lastMsg.content + '\n' + message,
            isPlan: type === 'plan'
          }
          return [...prev.slice(0, -1), updatedMsg]
        } else if (isFinal) {
          // Se per qualche motivo manca il messaggio current, crealo
          return [...prev, {
            id: Date.now().toString(),
            role: 'assistant',
            content: message,
            isPlan: type === 'plan'
          }]
        }
        return prev
      })

      // Disattivazione AUTONOMA di Agent Mode a fine task, ma solo quando è
      // DAVVERO verificato (taskFullyVerified, calcolato nell'harness da segnali
      // reali — non toccato nulla, oppure l'ultimo get_diagnostics/
      // run_and_verify_tests dopo l'ultima modifica è risultato pulito). Se il
      // task si è fermato in errore, ha esaurito le iterazioni, o ha modificato
      // codice senza mai verificarlo, resta acceso apposta: l'utente potrebbe
      // dover correggere/continuare subito senza doverlo riattivare a mano.
      if (type === 'done' && taskFullyVerified === true) {
        setIsAgentMode(false)
        setMessages(prev => [...prev, {
          id: `agent-mode-autooff-${Date.now()}`,
          role: 'assistant',
          content: '✅ Task completato e verificato — Agent Mode disattivato automaticamente. Riattivalo per il prossimo task che richiede scrittura/esecuzione.'
        }])
      }

      if (isFinal) {
        setIsTyping(false)
      }
    })

    return () => {
      // @ts-ignore
      if (removeStream && typeof removeStream === 'function') removeStream()
    }
  }, [])

  useEffect(() => {
    // Ascolta la todo list live dell'agente (tool 'write_todos', equivalente del
    // TodoWrite di Claude Code): mostra all'utente il piano multi-step in corso
    // invece di lasciarlo intuire solo dal log testuale.
    // @ts-ignore
    const removeTodos = window.ipcRenderer.on('agent-todos', (_event: any, payload: any) => {
      setAgentTodos(payload.todos || [])
    })

    return () => {
      // @ts-ignore
      if (removeTodos && typeof removeTodos === 'function') removeTodos()
    }
  }, [])

  useEffect(() => {
    // Checkpoint/rewind: quando un run dell'agente ha toccato almeno un file,
    // offre un pulsante per annullare TUTTE le modifiche di quel run come
    // unità atomica, sul messaggio finale corrispondente.
    // @ts-ignore
    const removeCheckpoint = window.ipcRenderer.on('agent-checkpoint-ready', (_event: any, payload: any) => {
      setCheckpointsByRunId(prev => ({ ...prev, [payload.runId]: { fileCount: payload.fileCount, taskSummary: payload.taskSummary } }))
    })

    return () => {
      // @ts-ignore
      if (removeCheckpoint && typeof removeCheckpoint === 'function') removeCheckpoint()
    }
  }, [])

  // Aggiorna le skill quando cambia il file attivo (senza testo del messaggio:
  // serve solo per il badge "N Skills", il matching vero avviene in handleSend)
  useEffect(() => {
    skillManager.analyzeContext('', currentFilePath || '', activeCode || '')
    setActiveSkillsCount(skillManager.getActiveSkills().length)
  }, [currentFilePath, activeCode])

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages, isTyping])

  // Estratto da handleSend per essere riusabile anche dal pulsante "rinvia" sui messaggi.
  const sendMessageContent = async (content: string, images?: string[]) => {
    // Bug pre-esistente trovato mentre aggiungevo la graffetta: bastava un solo
    // controllo su 'content' vuoto per bloccare completamente l'invio di un
    // messaggio con SOLO immagini/allegati e nessun testo — un caso d'uso reale
    // ("allega uno screenshot e invia senza scrivere nulla") che il bottone
    // 'Invia' in realtà permetteva di attivare (mai disabilitato in quel caso),
    // ma poi silenziosamente non succedeva nulla.
    if (!content.trim() && (!images || images.length === 0) && attachedDocuments.length === 0) return

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: content.trim(),
      images: images && images.length > 0 ? [...images] : undefined,
      attachedDocs: attachedDocuments.length > 0 ? [...attachedDocuments] : undefined
    }

    setMessages(prev => [...prev, userMessage])
    setIsTyping(true)
    setAgentTodos([])

    // Comandi slash: se il messaggio inizia con '/nome' e corrisponde a un
    // comando definito in .code-ide/commands/, il PROMPT REALE inviato al
    // modello è il template espanso (con {{args}} sostituito dal resto del
    // testo) — ma la bolla mostrata all'utente resta il comando così com'è
    // stato digitato, per chiarezza su cosa è stato effettivamente scritto.
    let effectivePrompt = userMessage.content

    // Bug reale trovato con un test dal vivo: allegare un file/immagine SENZA
    // scrivere nulla mandava al modello un turno utente vuoto — il contenuto
    // allegato finiva comunque nel system prompt, ma senza alcuna domanda/
    // istruzione esplicita molti modelli rispondono con un saluto generico
    // ("Ciao! Come posso assisterti?"), ignorando di fatto l'allegato. Un
    // prompt di default esplicito dà loro qualcosa di concreto da fare.
    if (!effectivePrompt.trim()) {
      if (attachedDocuments.length > 0 && !images?.length) {
        effectivePrompt = attachedDocuments.length === 1
          ? `Analizza il documento allegato (${attachedDocuments[0].name}) e riassumine il contenuto.`
          : `Analizza i documenti allegati e riassumine il contenuto.`
      } else if (images?.length) {
        effectivePrompt = "Descrivi cosa vedi nell'immagine allegata."
      }
    }

    const slashMatch = userMessage.content.match(/^\/(\S+)\s*([\s\S]*)$/)
    if (slashMatch) {
      const matchedCommand = commandDefinitions.find(c => c.name === slashMatch[1])
      if (matchedCommand) {
        const args = slashMatch[2] || ''
        effectivePrompt = matchedCommand.body.includes('{{args}}')
          ? matchedCommand.body.replace(/\{\{args\}\}/g, args)
          : `${matchedCommand.body}\n\n${args}`.trim()
      }
    }

    try {
      // 1. Raccogli il contesto del file
      let fileContext = ''
      if (currentFilePath) {
        const fileName = currentFilePath.split('/').pop() || currentFilePath.split('\\').pop()
        fileContext = `[Il file correntemente aperto nell'editor è: ${fileName}]\n\`\`\`\n${activeCode}\n\`\`\`\n`
      }

      // 1.5 File pinnati esplicitamente con @-mention: contesto ad alta priorità,
      // scelto dall'utente invece che dedotto automaticamente.
      let mentionContext = ''
      if (pinnedFiles.length > 0) {
        for (const relPath of pinnedFiles) {
          const absPath = currentProjectRoot ? `${currentProjectRoot.replace(/[/\\]+$/, '')}/${relPath}` : relPath
          // @ts-ignore
          const fileRes = await window.ipcRenderer.invoke('read-file', absPath)
          if (fileRes.success) {
            mentionContext += `\n[File pinnato dall'utente con @${relPath}]\n\`\`\`\n${fileRes.data}\n\`\`\`\n`
          }
        }
      }

      // 1.6 Documenti allegati con la graffetta 📎 (testo semplice, da
      // qualunque punto del disco — non necessariamente dentro al progetto).
      let attachmentContext = ''
      for (const doc of attachedDocuments) {
        attachmentContext += `\n[Documento allegato dall'utente: ${doc.name}]\n\`\`\`\n${doc.content}\n\`\`\`\n`
      }

      // 2. Contesto del progetto: mappa compatta dei simboli (AST), non il dump
      // dell'intero testo — un progetto anche piccolo può facilmente superare
      // 100.000 token in testo grezzo, saturando la finestra di contesto di un
      // modello locale ad ogni singolo messaggio. Il modello può comunque leggere
      // il contenuto completo di un file specifico chiedendolo esplicitamente
      // (Agent Mode) o aprendolo tu stesso (viene incluso come 'fileContext' sotto).
      // Albero completo di cartelle/file (qualunque estensione, non solo TS/JS)
      // invece della sola mappa AST: dà al modello consapevolezza dell'intera
      // struttura del progetto — legge poi i singoli file rilevanti con
      // 'read_file' (Agent Mode) invece di doversi limitare a ciò che rientra
      // nella mappa dei simboli esportati.
      let projectContext = ''
      if (currentProjectRoot) {
        // @ts-ignore
        const treeResult = await window.ipcRenderer.invoke('get-project-tree', currentProjectRoot)
        if (treeResult.success) {
          projectContext = `\n[Il progetto correntemente aperto è: ${currentProjectRoot}]\n[Albero di cartelle e file del progetto:]\n${treeResult.data}\n`
        }
      }

      // 3. Skills Context: rivaluta il matching sul messaggio appena inviato
      // (oltre al file attivo), cosi' le keyword nel testo dell'utente attivano
      // davvero le skill corrispondenti.
      skillManager.analyzeContext(effectivePrompt, currentFilePath || '', activeCode || '')
      setActiveSkillsCount(skillManager.getActiveSkills().length)
      const skillsContext = skillManager.generateSystemPromptInject()
      const toolsHint = currentProjectRoot
        ? "\n[Hai a disposizione i tool 'read_file', 'search_codebase', 'get_repo_map' e 'get_diagnostics' per leggere DAVVERO il contenuto di qualunque file elencato nell'albero, prima di rispondere — usali quando ti serve vedere del codice reale invece di indovinare dal solo nome del file o dalla mappa dei simboli. Non hai accesso di scrittura: puoi solo leggere/investigare.]\n"
        : ''
      const systemPrompt = `Sei l'Assistente AI di Code-IDE.\n\n${skillsContext}\n${projectContext}${toolsHint}\n${fileContext}${mentionContext}${attachmentContext}`

      // Contatore token: stima sull'intero payload che sta per partire (system
      // prompt + storico conversazione + nuovo messaggio), confrontata con la
      // finestra di contesto nota per il modello selezionato.
      const fullPromptText = systemPrompt + messages.map(m => m.content).join('\n') + effectivePrompt
      const usedTokens = estimateTokens(fullPromptText)
      const windowSize = getContextWindowForModel(selectedModel, ollamaContextLengths)
      setTokenUsage({ used: usedTokens, window: windowSize })

      if (isAgentMode) {
        // Aggiungiamo un placeholder per lo stream
        setMessages(prev => [...prev, {
          id: 'agent-current',
          role: 'assistant',
          content: isPlanMode ? '⏳ Esplorazione in corso per formulare un piano...' : '⏳ Avvio DeepSeek Harness (Agent Loop)...'
        }])

        // Se è un piano, ricordiamo il prompt originale per poterlo rieseguire per
        // intero (con accesso completo ai tool) quando l'utente lo approva.
        if (isPlanMode) {
          lastPlanRequestRef.current = { userPrompt: effectivePrompt, systemPrompt, images: userMessage.images }
        }

        // Manda al backend l'orchestratore (invoke: il main process risponde subito
        // con un runId di correlazione, l'harness prosegue in background). Il runId
        // viene attaccato al placeholder per collegare l'eventuale checkpoint (vedi
        // 'agent-checkpoint-ready') al messaggio finale di questo run.
        // @ts-ignore
        window.ipcRenderer.invoke('run-agent-task', {
          userPrompt: effectivePrompt,
          systemPrompt: systemPrompt,
          cwd: currentProjectRoot || '',
          model: selectedModel,
          images: userMessage.images,
          deepReasoning: isDeepReasoning,
          planMode: isPlanMode
        }).then((res: any) => {
          if (res?.runId) setMessages(prev => prev.map(m => m.id === 'agent-current' ? { ...m, runId: res.runId } : m))
        })
      } else {
        // runSteppedReadOnlyChat dà anche al modello in chat NORMALE (non solo
        // all'Agent Mode) la possibilità reale di leggere qualunque file del
        // progetto aperto in ESPLORA RISORSE su richiesta — un modello capace
        // di tool-calling lo usa da solo per investigare prima di rispondere;
        // uno che non lo sa fare ignora 'tools' e risponde subito a testo,
        // senza errori (nessuna regressione). Esegue a STEP: se un task ampio
        // (es. "trova bug in ogni file") non basta in uno step, si ferma e
        // mostra la modale di conferma invece di troncare in silenzio.
        const toolStatusId = 'chat-tool-status'
        const llmResponse = await runSteppedReadOnlyChat(
          selectedModel,
          [
            { role: 'system', content: systemPrompt },
            ...messages.map(m => ({
              role: m.role as 'system'|'user'|'assistant',
              content: m.content,
              images: m.images
            })),
            { role: 'user', content: effectivePrompt, images: userMessage.images }
          ],
          currentProjectRoot || '',
          (functionName, args) => {
            const label =
              functionName === 'read_file' ? `🔍 Lettura di ${args.filePath}...` :
              functionName === 'search_codebase' ? `🔍 Ricerca "${args.query}" nel progetto...` :
              functionName === 'get_repo_map' ? `🔍 Analisi struttura del progetto...` :
              functionName === 'get_diagnostics' ? `🔍 Controllo errori in ${args.filePath}...` :
              `🔍 ${functionName}...`
            setMessages(prev => {
              const withoutStatus = prev.filter(m => m.id !== toolStatusId)
              return [...withoutStatus, { id: toolStatusId, role: 'assistant', content: label }]
            })
            // Apre davvero il file nell'editor centrale mentre il modello lo
            // legge, invece di lasciare un'operazione invisibile di cui
            // fidarsi solo sulla parola del modello.
            if (functionName === 'read_file' && args.filePath && currentProjectRoot && onOpenFile) {
              const absPath = args.filePath.startsWith('/') ? args.filePath : `${currentProjectRoot.replace(/[/\\]+$/, '')}/${args.filePath}`
              onOpenFile(absPath)
            }
          }
        )

        // Il modello che ha risposto davvero può differire da quello richiesto
        // solo quando il gateway instrada (OmniRoute, OpenRouter) — se combacia
        // o il provider non lo dichiara non mostriamo nulla di ridondante.
        const rawRequestedModel = selectedModel.includes(':') ? selectedModel.split(':').slice(1).join(':') : selectedModel
        const resolvedModel = llmResponse.resolvedModel && llmResponse.resolvedModel !== rawRequestedModel
          ? llmResponse.resolvedModel
          : undefined

        const assistantMessage: Message = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: llmResponse.content,
          resolvedModel
        }
        setMessages(prev => [...prev.filter(m => m.id !== toolStatusId), assistantMessage])
        setIsTyping(false)
      }
    } catch (error: any) {
      setMessages(prev => [...prev, {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `❌ Errore durante l'esecuzione dell'LLM: ${error.message}`
      }])
      setIsTyping(false)
    }
  }

  const doSend = () => {
    const content = input
    const images = attachedImages
    setInput('')
    setAttachedImages([])
    setAttachedDocuments([])
    setPinnedFiles([])
    setMentionQuery(null)
    sendMessageContent(content, images)
  }

  const handleSend = () => {
    // Suggerimento (non blocco definitivo): se il messaggio somiglia a una
    // richiesta di scrittura/esecuzione ma Agent Mode è spento, mostra il
    // banner invece di inviare subito — l'utente sceglie se attivarlo o
    // proseguire comunque in chat normale (sola lettura, come sempre). Un
    // secondo click su "Invia" (dopo aver visto il banner una volta) passa
    // sempre, per non bloccare chi lo ignora deliberatamente.
    if (!isAgentMode && !pendingAgentModeSuggestion && WRITE_INTENT_PATTERN.test(input)) {
      setPendingAgentModeSuggestion(true)
      return
    }
    setPendingAgentModeSuggestion(false)
    doSend()
  }

  // Approva un piano: rilancia lo STESSO task (stesso prompt/contesto già investigato)
  // ma con planMode:false, quindi con accesso completo ai tool di scrittura/esecuzione.
  const handleApprovePlan = (messageId: string) => {
    const req = lastPlanRequestRef.current
    if (!req || isTyping) return

    setMessages(prev => prev.map(m => m.id === messageId ? { ...m, planApproved: true } : m))
    setMessages(prev => [...prev, {
      id: 'agent-current',
      role: 'assistant',
      content: '⏳ Piano approvato, avvio esecuzione con accesso completo ai tool...'
    }])
    setIsTyping(true)

    // @ts-ignore
    window.ipcRenderer.invoke('run-agent-task', {
      userPrompt: req.userPrompt,
      systemPrompt: req.systemPrompt,
      cwd: currentProjectRoot || '',
      model: selectedModel,
      images: req.images,
      deepReasoning: false,
      planMode: false
    }).then((res: any) => {
      if (res?.runId) setMessages(prev => prev.map(m => m.id === 'agent-current' ? { ...m, runId: res.runId } : m))
    })
  }

  const handleRejectPlan = (messageId: string) => {
    setMessages(prev => prev.map(m => m.id === messageId ? { ...m, planApproved: true } : m))
    lastPlanRequestRef.current = null
  }

  // Checkpoint/rewind: annulla TUTTE le modifiche ai file fatte da un singolo
  // run dell'agente come unità atomica, ripristinando il contenuto pre-task.
  const handleRevertCheckpoint = (runId: string) => {
    const cp = checkpointsByRunId[runId]
    if (!cp || !currentProjectRoot) return
    if (!confirm(`Annullare le modifiche a ${cp.fileCount} file fatte da questa richiesta? Verranno ripristinati al loro stato precedente.`)) return

    setRevertingRunId(runId)
    // @ts-ignore
    window.ipcRenderer.invoke('checkpoint.revert', currentProjectRoot, runId).then((res: any) => {
      setRevertingRunId(null)
      if (res.success) {
        setCheckpointsByRunId(prev => {
          const next = { ...prev }
          delete next[runId]
          return next
        })
        setMessages(prev => [...prev, {
          id: `checkpoint-revert-${Date.now()}`,
          role: 'assistant',
          content: `↩️ Modifiche annullate. File ripristinati:\n${res.data.restoredFiles.map((f: string) => `- ${f}`).join('\n')}`
        }])
      } else {
        alert(`Errore durante l'annullamento: ${res.error}`)
      }
    })
  }

  // Rileva '@parola' in coda al testo mentre si digita, per proporre l'autocomplete
  // dei file del progetto da pinnare esplicitamente come contesto (come @-mention in Cursor).
  const handleInputChange = (value: string) => {
    setInput(value)
    const match = value.match(/@([^\s@]*)$/)
    setMentionQuery(match ? match[1] : null)
  }

  const filteredMentionFiles = mentionQuery !== null
    ? projectFiles.filter(f => f.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 8)
    : []

  const handleSelectMention = (filePath: string) => {
    setInput(prev => prev.replace(/@([^\s@]*)$/, ''))
    setPinnedFiles(prev => prev.includes(filePath) ? prev : [...prev, filePath])
    setMentionQuery(null)
    textareaRef.current?.focus()
  }

  // Comandi slash: mostra l'autocomplete SOLO quando '/' è il primissimo
  // carattere digitato (i comandi hanno senso solo come primo token del
  // messaggio, non a metà frase come le @-mention).
  const slashQuery = /^\/(\S*)$/.test(input) ? input.slice(1) : null
  const filteredCommands = slashQuery !== null
    ? commandDefinitions.filter(c => c.name.toLowerCase().includes(slashQuery.toLowerCase())).slice(0, 8)
    : []

  const handleSelectCommand = (name: string) => {
    setInput(`/${name} `)
    textareaRef.current?.focus()
  }

  const handleUnpinFile = (filePath: string) => {
    setPinnedFiles(prev => prev.filter(f => f !== filePath))
  }

  // id del messaggio appena copiato: usato per mostrare un feedback visivo
  // temporaneo (✅ "Copiato!") sul bottone cliccato, che prima non dava alcun
  // riscontro — l'unico segnale che la copia fosse avvenuta era controllare
  // manualmente gli appunti.
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)

  const handleCopyMessage = (messageId: string, content: string) => {
    navigator.clipboard.writeText(content)
      .then(() => {
        setCopiedMessageId(messageId)
        setTimeout(() => setCopiedMessageId(prev => (prev === messageId ? null : prev)), 1500)
      })
      .catch(err => console.error('Copia fallita:', err))
  }

  const handleEditMessage = (messageId: string, content: string) => {
    // Vero "edit in place": tronca lo storico da questo messaggio in poi (non solo
    // ricarica il testo), così quando l'utente rinvia la versione modificata sostituisce
    // davvero questo punto della conversazione invece di limitarsi ad accodarsi.
    setMessages(prev => {
      const idx = prev.findIndex(m => m.id === messageId)
      return idx === -1 ? prev : prev.slice(0, idx)
    })
    setInput(content)
  }

  const handleResendMessage = (content: string, images?: string[]) => {
    // A differenza di "modifica": qui il messaggio originale resta nello storico,
    // il rinvio si aggiunge come nuovo turno (utile per riprovare la stessa domanda
    // e ottenere una risposta diversa, senza perdere quella precedente).
    if (isTyping) return
    sendMessageContent(content, images)
  }

  // Elimina UN SOLO messaggio (prompt o risposta) senza toccare il resto
  // della conversazione — a differenza di "+ Nuova" (inizia una chat
  // completamente nuova) o di "modifica" (tronca tutto da quel punto in poi),
  // qui l'utente ripulisce chirurgicamente un singolo scambio che non gli
  // serve più, lasciando intatto il resto.
  const handleDeleteMessage = (messageId: string) => {
    setMessages(prev => prev.filter(m => m.id !== messageId))
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }

  // Estensioni di testo semplice che ha senso leggere per intero come
  // contesto (codice, config, prosa) — un binario letto con readAsText
  // produrrebbe solo byte illeggibili spacciati per contenuto reale.
  const TEXT_DOC_EXTENSIONS = /\.(txt|md|markdown|json|csv|log|js|jsx|ts|tsx|py|html|css|scss|yml|yaml|xml|sh|env|toml|ini|sql|java|go|rs|c|cpp|h|swift|kt|rb|php)$/i
  // .pdf/.docx non sono testo semplice: l'estrazione vera (pdf-parse/mammoth)
  // richiede API Node non disponibili nel renderer, quindi il file grezzo
  // viene inviato al processo main via IPC e il testo estratto torna qui.
  const BINARY_DOC_EXTENSIONS = /\.(pdf|docx)$/i

  const attachFiles = (files: File[]) => {
    files.forEach(file => {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader()
        reader.onload = (ev) => {
          if (ev.target?.result) {
            setAttachedImages(prev => [...prev, ev.target!.result as string])
          }
        }
        reader.readAsDataURL(file)
      } else if (TEXT_DOC_EXTENSIONS.test(file.name)) {
        const reader = new FileReader()
        reader.onload = (ev) => {
          if (typeof ev.target?.result === 'string') {
            setAttachedDocuments(prev => [...prev, { name: file.name, content: ev.target!.result as string }])
          }
        }
        reader.readAsText(file)
      } else if (BINARY_DOC_EXTENSIONS.test(file.name)) {
        const reader = new FileReader()
        reader.onload = async (ev) => {
          if (!(ev.target?.result instanceof ArrayBuffer)) return
          // @ts-ignore
          const res = await window.ipcRenderer.invoke('extract-document-text', { fileName: file.name, buffer: ev.target.result })
          if (res.ok) {
            const content = res.warning ? `${res.text}\n\n[${res.warning}]` : res.text
            setAttachedDocuments(prev => [...prev, { name: file.name, content }])
          } else {
            setMessages(prev => [...prev, {
              id: `attach-warn-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              role: 'assistant',
              content: `⚠️ Estrazione testo da "${file.name}" fallita: ${res.error}`
            }])
          }
        }
        reader.readAsArrayBuffer(file)
      } else {
        setMessages(prev => [...prev, {
          id: `attach-warn-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          role: 'assistant',
          content: `⚠️ "${file.name}" non è supportato: solo immagini, file di testo semplice (.txt, .md, .json, codice, ecc.) e PDF/DOCX possono essere allegati.`
        }])
      }
    })
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    attachFiles(Array.from(e.dataTransfer.files))
  }

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) attachFiles(Array.from(e.target.files))
    e.target.value = '' // permette di riselezionare lo stesso file una seconda volta
  }

  // Avvia il pannello di conversazione vocale ad audio nativo (WebRTC diretto
  // col provider del modello selezionato — vedi services/nativeAudioModels.ts).
  // Attivabile solo se il modello nel menu supporta davvero audio nativo.
  const toggleVoice = () => {
    if (!isNativeAudioActive && !isNativeAudioModel(selectedModel)) return
    setIsNativeAudioActive(prev => !prev)
  }

  const handleNativeAudioTranscript = (role: 'user' | 'assistant', text: string) => {
    setMessages(prev => [...prev, { id: `${Date.now()}-${role}-${Math.random().toString(36).slice(2)}`, role, content: text }])
  }

  // Orchestratore a step per la chat normale (non-Agent-Mode): esegue uno
  // step di tool-calling di sola lettura alla volta (runReadOnlyToolStep) e,
  // quando uno step finisce SENZA una risposta finale (task ampio, es. "trova
  // bug in ogni file"), si ferma e mostra la modale di conferma invece di
  // troncare silenziosamente o continuare all'infinito senza controllo
  // dell'utente. 'autoApprove' vale solo per QUESTA richiesta: ogni nuovo
  // messaggio dell'utente riparte chiedendo di nuovo, non è un'impostazione
  // permanente.
  const runSteppedReadOnlyChat = async (
    model: string,
    initialMessages: LlmMessage[],
    cwd: string,
    onToolCall: (functionName: string, args: any) => void
  ): Promise<LLMResponse> => {
    if (!cwd) {
      // Nessun progetto aperto: niente file da leggere, nessun tool da offrire.
      return sendLLMRequest({ model, messages: initialMessages })
    }

    let messages = initialMessages
    let step = 1
    let autoApprove = false

    while (true) {
      const result = await runReadOnlyToolStep(model, messages, cwd, onToolCall)
      messages = result.messages

      if (result.done) {
        return { content: result.content || '', resolvedModel: result.resolvedModel }
      }

      // Step esaurito senza risposta finale: annuncia lo scope reale la prima
      // volta (numero di file/cartelle nel progetto) e chiede conferma,
      // a meno che l'utente non abbia già scelto "continua automaticamente".
      if (!autoApprove) {
        const filesReadThisStep = result.stepsExecuted
          .filter(s => s.functionName === 'read_file')
          .map(s => s.args.filePath)

        // @ts-ignore
        const countRes = await window.ipcRenderer.invoke('get-project-entry-count', currentProjectRoot)
        const totalFiles = countRes?.success ? countRes.data.files : 0
        const totalFolders = countRes?.success ? countRes.data.folders : 0

        const choice = await new Promise<'once' | 'auto' | 'stop'>((resolve) => {
          setStepModalRequest({ stepNumber: step, filesReadThisStep, totalFiles, totalFolders, resolve })
        })
        setStepModalRequest(null)

        if (choice === 'stop') {
          return {
            content: `⏸️ Investigazione interrotta su tua richiesta dopo ${step} step. Ecco cosa avevo trovato finora:\n\n${messages[messages.length - 1]?.content || '(nessuna sintesi ancora prodotta)'}`,
            resolvedModel: result.resolvedModel
          }
        }
        if (choice === 'auto') autoApprove = true
      }

      step++
    }
  }

  return (
    <div 
      className={`flex flex-col h-full bg-[#1e1e1e] border-l border-[#333] w-[416px] relative ${isDragging ? 'ring-2 ring-blue-500' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isNativeAudioActive && (
        <NativeAudioPanel model={selectedModel} onClose={() => setIsNativeAudioActive(false)} onTranscript={handleNativeAudioTranscript} />
      )}
      {stepModalRequest && (
        <StepContinueModal
          stepNumber={stepModalRequest.stepNumber}
          filesReadThisStep={stepModalRequest.filesReadThisStep}
          totalFiles={stepModalRequest.totalFiles}
          totalFolders={stepModalRequest.totalFolders}
          onContinueOnce={() => stepModalRequest.resolve('once')}
          onContinueAuto={() => stepModalRequest.resolve('auto')}
          onStop={() => stepModalRequest.resolve('stop')}
        />
      )}
      {isDragging && (
        <div className="absolute inset-0 z-50 bg-blue-500/20 flex items-center justify-center pointer-events-none">
          <div className="bg-[#252526] text-blue-400 p-4 rounded shadow-lg flex items-center gap-2 font-semibold">
            <span>🖼️</span> Rilascia l'immagine qui
          </div>
        </div>
      )}
      {/* Header & Model Selector */}
      <div className="p-3 bg-[#252526] border-b border-[#333] flex flex-col gap-2 shrink-0">
        <div className="text-sm font-semibold tracking-wide text-gray-300 uppercase flex items-center justify-between relative">
          <span className="flex items-center gap-2">
            🧠 AI Assistant
            <button
              onClick={handleNewChat}
              className="text-[10px] normal-case font-normal bg-[#1e1e1e] border border-[#333] rounded px-1.5 py-0.5 text-gray-400 hover:text-white hover:bg-[#333]"
              title="Nuova conversazione"
            >
              + Nuova
            </button>
            <button
              onClick={() => { setShowSessionList(v => !v); if (currentProjectRoot) refreshSessionList(currentProjectRoot) }}
              className="text-[10px] normal-case font-normal bg-[#1e1e1e] border border-[#333] rounded px-1.5 py-0.5 text-gray-400 hover:text-white hover:bg-[#333]"
              title="Cronologia conversazioni salvate"
            >
              🕒 {sessionList.length > 0 ? sessionList.length : ''}
            </button>
          </span>
          {showSessionList && (
            <div className="absolute top-full left-0 mt-1 w-72 max-h-64 overflow-y-auto bg-[#252526] border border-[#444] rounded shadow-lg z-20 normal-case font-normal">
              {sessionList.length === 0 ? (
                <div className="px-3 py-2 text-xs text-gray-500">Nessuna conversazione salvata per questo progetto.</div>
              ) : (
                sessionList.map(s => (
                  <div
                    key={s.id}
                    onClick={() => handleLoadSession(s.id)}
                    className={`px-3 py-2 text-xs cursor-pointer hover:bg-[#37373d] flex items-center justify-between gap-2 ${s.id === sessionId ? 'bg-[#2d2d2d] text-blue-300' : 'text-gray-300'}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{s.title}</div>
                      <div className="text-[10px] text-gray-500">{new Date(s.updatedAt).toLocaleString()} · {s.messageCount} messaggi</div>
                    </div>
                    <button
                      onClick={(e) => handleDeleteSession(s.id, e)}
                      className="text-gray-500 hover:text-red-400 shrink-0"
                      title="Elimina conversazione"
                    >
                      🗑️
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
          <span className="flex items-center gap-1.5">
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded ${
                omniRouteStatus === 'ready' ? 'bg-green-900/50 text-green-300' :
                omniRouteStatus === 'unavailable' ? 'bg-gray-700/50 text-gray-400' :
                'bg-yellow-900/50 text-yellow-300 animate-pulse'
              }`}
              title={
                omniRouteStatus === 'ready' ? 'OmniRoute attivo: instrada verso qualunque provider selezionato' :
                omniRouteStatus === 'installing' ? 'Installazione OmniRoute in corso...' :
                omniRouteStatus === 'starting' ? 'Avvio OmniRoute in corso...' :
                omniRouteStatus === 'unavailable' ? 'OmniRoute non disponibile: fallback su Ollama locale' :
                'Verifica OmniRoute in corso...'
              }
            >
              {omniRouteStatus === 'ready' ? '🟢 OmniRoute' :
               omniRouteStatus === 'unavailable' ? '⚪ Solo Ollama' :
               '🟡 OmniRoute...'}
            </span>
            <span className="text-[10px] bg-blue-900/50 text-blue-300 px-1.5 py-0.5 rounded" title="Skill caricate automaticamente">
              {activeSkillsCount} Skills
            </span>
          </span>
        </div>
        <div className="flex gap-1.5 items-stretch">
        <select
          value={selectedModel}
          onChange={(e) => {
            const val = e.target.value
            setSelectedModel(val)
            if (val === 'sakana:fugu' && !sakanaAuthed) {
              // @ts-ignore
              window.ipcRenderer.invoke('sakana-open-login').then((res: any) => {
                if (res?.success) setSakanaAuthed(true)
              }).catch(() => {})
            }
          }}
          className="flex-1 min-w-0 bg-[#1e1e1e] text-xs text-gray-300 border border-[#333] rounded px-2 py-1 outline-none"
        >
          <optgroup label={`Locali (Ollama)${ollamaModels.length === 0 ? ' — nessuno trovato' : ''}`}>
            {ollamaModels.length > 0 ? (
              ollamaModels.map(name => (
                <option key={name} value={name}>{name}</option>
              ))
            ) : (
              <option value="qwen2.5-coder:latest" disabled>Ollama non raggiungibile o senza modelli</option>
            )}
          </optgroup>
          {lmStudioModels.length > 0 && (
            <optgroup label="Locali (LM Studio)">
              {lmStudioModels.map(id => (
                <option key={id} value={`lmstudio:${id}`}>{id}</option>
              ))}
            </optgroup>
          )}
          {duckAiModels.length > 0 && (
            <optgroup label="DuckAI (Gratuito, senza chiavi API 🦆)">
              {duckAiModels.map(m => (
                <option key={m.id} value={`duckai:${m.id}`}>{m.label}</option>
              ))}
            </optgroup>
          )}
          <optgroup label="Sakana AI (chat.sakana.ai 🐟)">
            <option value="sakana:sakana-namazu">Sakana: Namazu (Ragionamento, gratuito)</option>
            <option value="sakana:fugu">
              {`Sakana: Fugu (Intelligenza Collettiva ${sakanaAuthed ? '✓ Autenticato' : '🔒 Richiede Login'})`}
            </option>
          </optgroup>
          <optgroup label="Audio nativo (conversazione vocale diretta col microfono 🎙️)">
            <option value="realtime:gpt-4o-realtime-preview">GPT-4o Realtime</option>
            <option value="realtime:gpt-4o-mini-realtime-preview">GPT-4o mini Realtime</option>
            <option value="realtime:gemini-2.0-flash-live-001">Gemini Live</option>
          </optgroup>
          <optgroup label="Locali (server personalizzato)">
            <option value="local:custom">Server locale personalizzato (config. nelle Impostazioni)</option>
          </optgroup>
          {omniRouteStatus === 'ready' && (
            // Solo 'Auto': le altre 3 opzioni con nome di modello specifico
            // (GPT-4o mini/Claude 3.5 Sonnet/Gemini 1.5 Pro) c'erano prima ma
            // fallivano SEMPRE — verificato dal vivo con curl diretto a
            // OmniRoute: "No active credentials for provider: openai/aimlapi/
            // nanogpt". Instradano verso provider a pagamento che richiedono
            // credenziali configurate nella dashboard di OmniRoute stesso
            // (http://localhost:20128), non presenti di default. 'Auto' invece
            // pesca da un pool gratuito che non ne ha bisogno ed è l'unica
            // opzione che funziona finché quelle credenziali non vengono
            // configurate manualmente dall'utente.
            <optgroup label="OmniRoute (gateway locale, instradamento automatico gratuito)">
              <option value="omniroute:auto">Auto (lascia scegliere il gateway)</option>
            </optgroup>
          )}
          <optgroup label="OpenRouter (chiave unica, centinaia di modelli)">
            <option value="openrouter:anthropic/claude-3.5-sonnet">Claude 3.5 Sonnet</option>
            <option value="openrouter:openai/gpt-4o">GPT-4o</option>
            <option value="openrouter:google/gemini-pro-1.5">Gemini 1.5 Pro</option>
            <option value="openrouter:deepseek/deepseek-chat">DeepSeek Chat</option>
            <option value="openrouter:meta-llama/llama-3.3-70b-instruct">Llama 3.3 70B</option>
            <option value="openrouter:qwen/qwen-2.5-72b-instruct">Qwen 2.5 72B</option>
          </optgroup>
          <optgroup label="Together AI (inferenza economica open-weight)">
            <option value="together:meta-llama/Llama-3.3-70B-Instruct-Turbo">Llama 3.3 70B Turbo</option>
            <option value="together:deepseek-ai/DeepSeek-V3">DeepSeek V3</option>
            <option value="together:mistralai/Mixtral-8x22B-Instruct-v0.1">Mixtral 8x22B</option>
          </optgroup>
          <optgroup label="API Free / Open">
            {/* Prima 'llama-3.3-70b-groq': nome inventato, mai un vero model
                id Groq (che sono es. 'llama-3.3-70b-versatile') — 404
                garantito ad ogni chiamata. */}
            <option value="llama-3.3-70b-versatile">Llama 3.3 70B (Groq)</option>
          </optgroup>
          <optgroup label="Commerciali (Fallback Avanzato)">
            {/* Rimosse stanotte 4 voci morte, verificate leggendo il codice
                reale di sendLLMRequest in services/llm.ts — nessuna aveva un
                branch/endpoint che le raggiungesse davvero, fallivano SEMPRE:
                'Claude 3.5 Sonnet' qui (Anthropic non è OpenAI-compatibile,
                serve un client dedicato mai costruito — usa quello identico
                già funzionante nel gruppo OpenRouter sopra), 'Z.ai', 'Sakana',
                'HF Inference API' (nessuno dei tre aveva mai avuto un endpoint
                configurato in questo file). */}
            <option value="gpt-4o">GPT-4o</option>
            <option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
            <option value="grok-2">Grok (gtok)</option>
            <option value="qwen-max">Qwen Max</option>
            <option value="deepseek-coder">DeepSeek Coder</option>
            <option value="kimi-k3">Kimi k3</option>
          </optgroup>
        </select>
        <button
          onClick={onOpenSettings}
          className="px-2 bg-[#1e1e1e] border border-[#333] rounded text-gray-400 hover:text-white hover:bg-[#333] shrink-0"
          title="Inserisci qui la chiave API per i modelli a pagamento (OpenRouter, OpenAI, Gemini, ecc.)"
        >
          🔑
        </button>
        </div>
        <p className="text-[10px] text-gray-500 -mt-1">
          "Locali" = già sul tuo Mac, nessuna chiave richiesta. Tutti gli altri gruppi richiedono una chiave API — inseriscila con 🔑.
        </p>
        {/* Controls */}
        <div className="px-3 py-2 bg-[#1e1e1e] flex flex-col gap-2 shrink-0">
          <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
            <input 
              type="checkbox" 
              checked={isAgentMode} 
              onChange={(e) => setIsAgentMode(e.target.checked)}
              className="accent-blue-500 w-4 h-4"
            />
            <span className="select-none font-semibold">Agent Mode (Auto-Edit)</span>
          </label>
          
          {isAgentMode && (
            <label className="flex items-center gap-2 text-sm text-purple-400 cursor-pointer ml-6">
              <input
                type="checkbox"
                checked={isDeepReasoning}
                onChange={(e) => { setIsDeepReasoning(e.target.checked); if (e.target.checked) setIsPlanMode(false) }}
                className="accent-purple-500 w-3 h-3"
              />
              <span className="select-none text-xs">🧠 Deep Reasoning (MCTS / Supreme Court)</span>
            </label>
          )}

          {isAgentMode && (
            <label className="flex items-center gap-2 text-sm text-amber-400 cursor-pointer ml-6" title="L'agente esplora solo in sola lettura e propone un piano numerato; nulla viene scritto/eseguito finché non lo approvi.">
              <input
                type="checkbox"
                checked={isPlanMode}
                onChange={(e) => { setIsPlanMode(e.target.checked); if (e.target.checked) setIsDeepReasoning(false) }}
                className="accent-amber-500 w-3 h-3"
              />
              <span className="select-none text-xs">📋 Modalità Piano (approvazione prima di eseguire)</span>
            </label>
          )}
        </div>
      </div>

      {/* Todo list live dell'agente (tool write_todos) */}
      {agentTodos.length > 0 && (
        <div className="mx-3 mt-2 p-2 bg-[#1e1e1e] border border-[#333] rounded shrink-0">
          <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Piano in corso</div>
          <div className="flex flex-col gap-0.5">
            {agentTodos.map((t, i) => (
              <div key={i} className={`text-xs flex items-start gap-1.5 ${t.status === 'completed' ? 'text-gray-500 line-through' : t.status === 'in_progress' ? 'text-blue-300' : 'text-gray-300'}`}>
                <span>{t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜'}</span>
                <span>{t.content}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
        {messages.map(msg => (
          <div 
            key={msg.id} 
            className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
          >
            <div 
              className={`max-w-[90%] p-3 rounded-lg text-sm whitespace-pre-wrap ${
                msg.role === 'user' 
                  ? 'bg-blue-600 text-white rounded-br-none' 
                  : 'bg-[#2d2d2d] text-gray-200 rounded-bl-none border border-[#333]'
              }`}
            >
              {msg.images && msg.images.map((img, i) => (
                <img key={i} src={img} alt="attached" className="w-full rounded mb-2 object-cover max-h-48" />
              ))}
              {msg.attachedDocs && msg.attachedDocs.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-2">
                  {msg.attachedDocs.map((doc, i) => (
                    <button
                      key={i}
                      onClick={() => onOpenVirtualFile?.(doc.name, doc.content)}
                      className="flex items-center gap-1 text-[11px] bg-black/20 hover:bg-black/30 px-2 py-1 rounded"
                      title="Apri nell'editor"
                    >
                      📎 {doc.name}
                    </button>
                  ))}
                </div>
              )}
              {msg.content}
            </div>
            {msg.resolvedModel && (
              <div className="text-[10px] text-gray-500 mt-1" title="Modello che ha risposto davvero (instradato dal gateway, diverso da quello selezionato)">
                🔀 instradato verso: {msg.resolvedModel}
              </div>
            )}
            {msg.isPlan && !msg.planApproved && (
              <div className="flex gap-2 mt-1.5">
                <button
                  onClick={() => handleApprovePlan(msg.id)}
                  disabled={isTyping}
                  className="text-xs px-3 py-1 bg-green-700 hover:bg-green-600 text-white rounded disabled:opacity-50"
                >
                  ✅ Approva ed esegui
                </button>
                <button
                  onClick={() => handleRejectPlan(msg.id)}
                  disabled={isTyping}
                  className="text-xs px-3 py-1 bg-[#37373d] hover:bg-[#4d4d54] text-gray-300 rounded disabled:opacity-50"
                >
                  ✕ Annulla
                </button>
              </div>
            )}
            {msg.isPlan && msg.planApproved && (
              <div className="text-[10px] text-gray-500 mt-1">Piano gestito.</div>
            )}
            {msg.runId && checkpointsByRunId[msg.runId] && (
              <button
                onClick={() => handleRevertCheckpoint(msg.runId as string)}
                disabled={revertingRunId === msg.runId}
                className="text-[10px] mt-1 px-2 py-1 bg-red-900/30 hover:bg-red-900/60 text-red-300 rounded disabled:opacity-50 self-start"
                title="Annulla tutte le modifiche ai file fatte da questa richiesta"
              >
                {revertingRunId === msg.runId ? '⏳ Annullamento...' : `↩️ Annulla modifiche (${checkpointsByRunId[msg.runId].fileCount} file)`}
              </button>
            )}
            {msg.role === 'user' && (
              <div className="flex gap-1 mt-1">
                <button
                  onClick={() => handleCopyMessage(msg.id, msg.content)}
                  className={`text-[10px] px-1.5 py-0.5 rounded hover:bg-[#333] transition-colors ${copiedMessageId === msg.id ? 'text-green-400' : 'text-gray-500 hover:text-gray-300'}`}
                  title="Copia prompt"
                >
                  {copiedMessageId === msg.id ? '✅ Copiato' : '📋'}
                </button>
                <button
                  onClick={() => handleEditMessage(msg.id, msg.content)}
                  className="text-[10px] text-gray-500 hover:text-gray-300 px-1.5 py-0.5 rounded hover:bg-[#333]"
                  title="Modifica e rinvia (sostituisce la conversazione da qui)"
                >
                  ✏️
                </button>
                <button
                  onClick={() => handleResendMessage(msg.content, msg.images)}
                  disabled={isTyping}
                  className="text-[10px] text-gray-500 hover:text-gray-300 px-1.5 py-0.5 rounded hover:bg-[#333] disabled:opacity-40"
                  title="Rinvia lo stesso prompt"
                >
                  🔁
                </button>
                <button
                  onClick={() => handleDeleteMessage(msg.id)}
                  className="text-[10px] text-gray-500 hover:text-red-400 px-1.5 py-0.5 rounded hover:bg-[#333]"
                  title="Elimina questo messaggio"
                >
                  🗑️
                </button>
              </div>
            )}
            {/* Copia risposta: prima esisteva SOLO sui messaggi utente (📋/✏️/🔁
                sopra) — l'output dell'assistente non aveva alcun modo di essere
                copiato senza selezionare il testo a mano. Niente modifica/rinvio
                qui: non hanno senso su una risposta generata, non su un prompt. */}
            {msg.role === 'assistant' && msg.id !== 'chat-tool-status' && msg.id !== 'agent-current' && msg.content && (
              <div className="flex gap-1 mt-1">
                <button
                  onClick={() => handleCopyMessage(msg.id, msg.content)}
                  className={`text-[10px] px-1.5 py-0.5 rounded hover:bg-[#333] transition-colors ${copiedMessageId === msg.id ? 'text-green-400' : 'text-gray-500 hover:text-gray-300'}`}
                  title="Copia risposta"
                >
                  {copiedMessageId === msg.id ? '✅ Copiato' : '📋'}
                </button>
                <button
                  onClick={() => handleDeleteMessage(msg.id)}
                  className="text-[10px] text-gray-500 hover:text-red-400 px-1.5 py-0.5 rounded hover:bg-[#333]"
                  title="Elimina questo messaggio"
                >
                  🗑️
                </button>
              </div>
            )}
          </div>
        ))}
        {isTyping && (
          <div className="flex flex-col items-start">
            <div className="max-w-[90%] p-3 rounded-lg text-sm bg-[#2d2d2d] text-gray-400 rounded-bl-none border border-[#333] flex items-center gap-2">
              <span className="animate-pulse">●</span>
              <span className="animate-pulse delay-75">●</span>
              <span className="animate-pulse delay-150">●</span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="p-3 bg-[#252526] border-t border-[#333] shrink-0">
        {tokenUsage && (() => {
          const pct = Math.min(100, Math.round((tokenUsage.used / tokenUsage.window) * 100))
          const barColor = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-yellow-500' : 'bg-green-600'
          const textColor = pct >= 90 ? 'text-red-400' : pct >= 70 ? 'text-yellow-400' : 'text-gray-500'
          return (
            <div className="mb-2" title="Stima token dell'ultimo prompt inviato (~4 caratteri/token, non un conteggio esatto)">
              <div className="flex items-center justify-between text-[10px] mb-0.5">
                <span className={textColor}>
                  ~{tokenUsage.used.toLocaleString()} / {tokenUsage.window.toLocaleString()} token ({pct}%)
                  {pct >= 90 && ' — quasi al limite del contesto!'}
                </span>
              </div>
              <div className="w-full h-1 bg-[#1e1e1e] rounded overflow-hidden">
                <div className={`h-full ${barColor} transition-all`} style={{ width: `${pct}%` }} />
              </div>
            </div>
          )
        })()}
        {currentFilePath && (
           <div className="text-[10px] text-gray-500 mb-2 truncate">
             Context: {currentFilePath.split('/').pop() || currentFilePath.split('\\').pop()}
           </div>
        )}
        {attachedImages.length > 0 && (
          <div className="flex gap-2 mb-2 overflow-x-auto pb-1">
            {attachedImages.map((img, index) => (
              <div key={index} className="relative shrink-0">
                <img src={img} className="h-12 w-12 object-cover rounded border border-[#444]" />
                <button
                  onClick={() => setAttachedImages(prev => prev.filter((_, i) => i !== index))}
                  className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full w-4 h-4 flex items-center justify-center text-[10px]"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        {pinnedFiles.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2">
            {pinnedFiles.map(f => (
              <span key={f} className="flex items-center gap-1 text-[10px] bg-purple-900/40 text-purple-300 px-1.5 py-0.5 rounded" title={f}>
                @{f.split('/').pop()}
                <button onClick={() => handleUnpinFile(f)} className="hover:text-white">✕</button>
              </span>
            ))}
          </div>
        )}
        {attachedDocuments.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2">
            {attachedDocuments.map((doc, index) => (
              <span key={`${doc.name}-${index}`} className="flex items-center gap-1 text-[10px] bg-teal-900/40 text-teal-300 px-1.5 py-0.5 rounded" title={doc.name}>
                📎 {doc.name}
                <button onClick={() => setAttachedDocuments(prev => prev.filter((_, i) => i !== index))} className="hover:text-white">✕</button>
              </span>
            ))}
          </div>
        )}
        {pendingAgentModeSuggestion && (
          <div className="flex items-center gap-2 mb-2 p-2 bg-amber-900/30 border border-amber-700/50 rounded text-xs">
            <span className="text-amber-300 flex-1">🤖 Questo messaggio sembra chiedere di scrivere/eseguire qualcosa — senza Agent Mode il modello può solo risponderti a parole, senza toccare davvero i file.</span>
            <button
              onClick={() => { setIsAgentMode(true); setPendingAgentModeSuggestion(false); doSend() }}
              className="shrink-0 px-2 py-1 bg-amber-600 hover:bg-amber-500 text-white rounded"
            >
              Attiva e invia
            </button>
            <button
              onClick={() => { setPendingAgentModeSuggestion(false); doSend() }}
              className="shrink-0 px-2 py-1 bg-[#37373d] hover:bg-[#4d4d54] text-gray-300 rounded"
            >
              Invia comunque
            </button>
            <button
              onClick={() => setPendingAgentModeSuggestion(false)}
              className="shrink-0 text-gray-500 hover:text-gray-300 px-1"
              title="Chiudi"
            >
              ✕
            </button>
          </div>
        )}
        <div className="relative">
          {mentionQuery !== null && filteredMentionFiles.length > 0 && (
            <div className="absolute bottom-full left-0 mb-1 w-full max-h-40 overflow-y-auto bg-[#252526] border border-[#444] rounded shadow-lg z-10">
              {filteredMentionFiles.map(f => (
                <div
                  key={f}
                  onClick={() => handleSelectMention(f)}
                  className="px-2 py-1.5 text-xs text-gray-300 hover:bg-[#37373d] cursor-pointer truncate"
                  title={f}
                >
                  📄 {f}
                </div>
              ))}
            </div>
          )}
          {slashQuery !== null && filteredCommands.length > 0 && (
            <div className="absolute bottom-full left-0 mb-1 w-full max-h-40 overflow-y-auto bg-[#252526] border border-[#444] rounded shadow-lg z-10">
              {filteredCommands.map(c => (
                <div
                  key={c.name}
                  onClick={() => handleSelectCommand(c.name)}
                  className="px-2 py-1.5 text-xs text-gray-300 hover:bg-[#37373d] cursor-pointer"
                  title={c.description}
                >
                  <span className="text-purple-300">/{c.name}</span> <span className="text-gray-500">{c.description}</span>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isNativeAudioActive ? "Conversazione vocale in corso..." : "Chiedi qualcosa all'Assistente AI (@file per pinnare un file, /comando, Invio per inviare)..."}
            className={`w-full bg-[#333] text-white text-sm rounded border ${isNativeAudioActive ? 'border-blue-500 ring-1 ring-blue-500' : 'border-[#444]'} p-2 pr-32 resize-none h-20 focus:outline-none focus:border-blue-500`}
            disabled={isTyping || isNativeAudioActive}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,.txt,.md,.markdown,.json,.csv,.log,.js,.jsx,.ts,.tsx,.py,.html,.css,.scss,.yml,.yaml,.xml,.sh,.env,.toml,.ini,.sql,.java,.go,.rs,.c,.cpp,.h,.swift,.kt,.rb,.php,.pdf,.docx"
            onChange={handleFileInputChange}
            className="hidden"
          />
          <div className="absolute right-2 bottom-2 flex items-center gap-1">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isTyping || isNativeAudioActive}
              className="p-2 rounded-full bg-[#444] hover:bg-[#555] text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title="Allega immagini o documenti di testo"
            >
              📎
            </button>
            <button
              onClick={toggleVoice}
              disabled={!isNativeAudioActive && !isNativeAudioModel(selectedModel)}
              className={`p-2 rounded-full ${isNativeAudioActive ? 'bg-blue-500 animate-pulse' : 'bg-[#444] hover:bg-[#555]'} text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed`}
              title={isNativeAudioActive ? 'Termina conversazione vocale' : isNativeAudioModel(selectedModel) ? `Avvia conversazione vocale nativa con ${selectedModel}` : "Seleziona un modello dal gruppo 'Audio nativo' nel menu per abilitare il microfono"}
            >
              {isNativeAudioActive ? '⏳' : '🎙️'}
            </button>
            <button
              onClick={handleSend}
              disabled={isTyping || (!input.trim() && attachedImages.length === 0 && attachedDocuments.length === 0)}
              className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded transition-colors disabled:opacity-50"
            >
              Invia
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
