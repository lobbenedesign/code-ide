import { useState, useEffect, useRef } from 'react'
import Editor from '@monaco-editor/react'
import Terminal from './Terminal'
import AiChat from './AiChat'
import './index.css'
import { skillManager } from './SkillManager'
import { getFimCompletion } from './services/fim'
import { getDefaultOllamaModel } from './services/llm'
import SettingsPanel from './SettingsPanel'

interface FileEntry {
  name: string
  isDirectory: boolean
  path: string
}

interface OpenTab {
  path: string
  content: string
  isDirty: boolean
  isAgentWriting?: boolean
}

// Calcola le righe (1-indicizzate, sul contenuto NUOVO) che differiscono da quelle
// vecchie, via LCS — usato per evidenziare solo ciò che l'agente ha realmente
// aggiunto/cambiato, non l'intero file. Stessa logica di FileEditorPlugin.ts,
// qui lato renderer per pilotare le decorazioni Monaco.
const MAX_LINES_FOR_DIFF_HIGHLIGHT = 3000
function computeChangedLines(oldContent: string, newContent: string): number[] {
  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')
  if (oldLines.length > MAX_LINES_FOR_DIFF_HIGHLIGHT || newLines.length > MAX_LINES_FOR_DIFF_HIGHLIGHT) return []

  const n = oldLines.length, m = newLines.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const changed: number[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) { i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { i++ }
    else { changed.push(j + 1); j++ }
  }
  while (j < m) { changed.push(j + 1); j++ }
  return changed
}

function joinPath(base: string, rel: string): string {
  if (!base) return rel
  const isWin = base.includes('\\')
  const sep = isWin ? '\\' : '/'
  return `${base.replace(/[/\\]+$/, '')}${sep}${rel}`
}

function App() {
  const [files, setFiles] = useState<FileEntry[]>([])
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([])
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null)
  const [currentDir, setCurrentDir] = useState<string>('')
  const [isSaving, setIsSaving] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const editorRef = useRef<any>(null)
  const decorationsRef = useRef<string[]>([])
  const openTabsRef = useRef<OpenTab[]>([])
  const currentDirRef = useRef<string>('')

  useEffect(() => { openTabsRef.current = openTabs }, [openTabs])
  useEffect(() => { currentDirRef.current = currentDir }, [currentDir])

  const currentFilePath = activeTabPath
  const code = openTabs.find(t => t.path === activeTabPath)?.content ?? '// Seleziona un file dalla barra laterale per iniziare a lavorare'

  useEffect(() => {
    // Carica la cartella iniziale di progetto (il Backend capirà che vuoto significa process.cwd())
    loadDirectory('')
    // Carica le skill vere dal disco
    skillManager.init('')
  }, [])

  useEffect(() => {
    // L'agente apre/aggiorna automaticamente le schede dei file che sta scrivendo,
    // ed evidenzia (per qualche secondo) le righe che ha realmente cambiato —
    // così si vede in tempo reale cosa sta facendo, non solo a posteriori nella chat.
    // @ts-ignore
    const removeAgentFileWrite = window.ipcRenderer.on('agent-file-write', async (_evt: any, payload: any) => {
      const { filePath, cwd, phase, content } = payload
      const absPath = filePath.startsWith('/') || /^[a-zA-Z]:\\/.test(filePath) ? filePath : joinPath(cwd || currentDirRef.current, filePath)

      if (phase === 'start') {
        setOpenTabs(prev => {
          const existing = prev.find(t => t.path === absPath)
          if (existing) return prev.map(t => t.path === absPath ? { ...t, isAgentWriting: true } : t)
          return [...prev, { path: absPath, content: '// L\'agente sta scrivendo questo file...', isDirty: false, isAgentWriting: true }]
        })
        setActiveTabPath(absPath)
        return
      }

      // phase === 'done'
      const previousContent = openTabsRef.current.find(t => t.path === absPath)?.content
      const changedLines = previousContent !== undefined
        ? computeChangedLines(previousContent === '// L\'agente sta scrivendo questo file...' ? '' : previousContent, content)
        : Array.from({ length: Math.min(content.split('\n').length, MAX_LINES_FOR_DIFF_HIGHLIGHT) }, (_, idx) => idx + 1)

      setOpenTabs(prev => {
        const existing = prev.find(t => t.path === absPath)
        if (existing) return prev.map(t => t.path === absPath ? { ...t, content, isDirty: false, isAgentWriting: false } : t)
        return [...prev, { path: absPath, content, isDirty: false, isAgentWriting: false }]
      })
      setActiveTabPath(absPath)

      // Applica l'evidenziazione al prossimo tick, quando Monaco ha già il nuovo valore montato
      setTimeout(() => highlightChangedLines(changedLines), 50)
    })

    return () => {
      // @ts-ignore
      if (removeAgentFileWrite && typeof removeAgentFileWrite === 'function') removeAgentFileWrite()
    }
  }, [])

  useEffect(() => {

    // Listener per i messaggi remoti dai Bot (Telegram/WhatsApp)
    // @ts-ignore
    const removeListener = window.ipcRenderer.on('bot-message', async (event, msg) => {
      console.log('Ricevuto messaggio bot:', msg)
      const { source, chatId, text } = msg

      let replyText = ''

      if (text === '/status' || text === '/progetto') {
        replyText = `📂 Progetto aperto attualmente: ${currentDir || 'Nessuno'}\n📄 File attivo: ${currentFilePath || 'Nessuno'}`
      } else if (text === '/output') {
        try {
          // @ts-ignore
          const outputResult = await window.ipcRenderer.invoke('get-output-buffer')
          replyText = outputResult.success ? outputResult.data : `❌ Errore lettura output: ${outputResult.error}`
        } catch (e: any) {
          replyText = `❌ Errore lettura output: ${e.message}`
        }
      } else if (text === '/checkpoints') {
        // Il checkpoint/rewind della UI desktop era invisibile da remoto: un task
        // innescato via bot creava comunque un checkpoint, ma l'utente Telegram/
        // WhatsApp non aveva modo di vederlo o annullarlo.
        try {
          // @ts-ignore
          const res = await window.ipcRenderer.invoke('checkpoint.list', currentDir || '')
          if (!res.success || res.data.length === 0) {
            replyText = '📋 Nessun checkpoint disponibile per questo progetto.'
          } else {
            replyText = '📋 Checkpoint disponibili (più recente = /revert 1):\n' + res.data.map((cp: any, i: number) =>
              `${i + 1}. ${new Date(cp.createdAt).toLocaleString()} — ${cp.fileCount} file — "${cp.taskSummary}"`
            ).join('\n')
          }
        } catch (e: any) {
          replyText = `❌ Errore lettura checkpoint: ${e.message}`
        }
      } else if (text === '/revert' || /^\/revert\s+\d+$/.test(text)) {
        try {
          const idx = text === '/revert' ? 0 : parseInt(text.split(/\s+/)[1], 10) - 1
          // @ts-ignore
          const listRes = await window.ipcRenderer.invoke('checkpoint.list', currentDir || '')
          const cp = listRes.success ? listRes.data[idx] : null
          if (!cp) {
            replyText = '❌ Nessun checkpoint a quell\'indice. Usa /checkpoints per vedere la lista.'
          } else {
            // @ts-ignore
            const revertRes = await window.ipcRenderer.invoke('checkpoint.revert', currentDir || '', cp.runId)
            replyText = revertRes.success
              ? `↩️ Modifiche annullate. File ripristinati:\n${revertRes.data.restoredFiles.map((f: string) => `- ${f}`).join('\n')}`
              : `❌ Errore durante l'annullamento: ${revertRes.error}`
          }
        } catch (e: any) {
          replyText = `❌ Errore durante l'annullamento: ${e.message}`
        }
      } else {
        // Ogni altro messaggio attiva l'harness agentico completo (stesso Agent Mode
        // della chat desktop): edit_file, run_terminal_command, manage_git,
        // publish_to_github, ecc. Nessuna conferma interattiva è possibile da bot,
        // quindi l'harness esegue in autonomia fino al suo limite di iterazioni.
        try {
          replyText = "⏳ Modalità agente attiva: sto eseguendo il task (edit file, comandi, git se necessario)..."
          // @ts-ignore
          window.ipcRenderer.send('bot-reply', { source, chatId, text: replyText })

          // Albero di cartelle/file (percorsi soli, nessun contenuto) invece
          // del dump dell'intero testo — vedi AiChat.tsx per il perché: un
          // progetto di media grandezza satura da solo la finestra di
          // contesto di un modello locale ad ogni messaggio.
          let projectContext = ''
          if (currentDir) {
            // @ts-ignore
            const treeResult = await window.ipcRenderer.invoke('get-project-tree', currentDir)
            if (treeResult.success) {
              projectContext = `\n[Il progetto correntemente aperto è: ${currentDir}]\n[Albero di cartelle e file del progetto:]\n${treeResult.data}\n`
            }
          }

          skillManager.analyzeContext(text, currentFilePath || '', '')
          const skillsContext = skillManager.generateSystemPromptInject()
          const systemPrompt = `Sei l'Assistente Agentico di Code-IDE, contattato via ${source}. Hai accesso completo ai tool (edit_file, run_terminal_command, manage_git, publish_to_github, ecc.) e agisci in autonomia: non puoi chiedere conferme, quindi procedi direttamente.\n${skillsContext}\n${projectContext}`

          const defaultModel = await getDefaultOllamaModel()

          // 'invoke' risponde subito con un runId di correlazione univoco per questo
          // run: filtriamo gli eventi 'agent-stream' su quel runId, così se un run
          // desktop è in corso in parallelo la sua risposta non finisce per errore
          // in questa chat bot (e viceversa).
          // @ts-ignore
          const { runId } = await window.ipcRenderer.invoke('run-agent-task', {
            userPrompt: text,
            systemPrompt,
            cwd: currentDir || '',
            // Se Ollama non ha modelli installati, passiamo comunque un valore:
            // l'harness lo instraderà via OmniRoute se attivo, o fallirà con un
            // messaggio chiaro (vedi llmClient.ts) invece del generico 404.
            model: defaultModel || 'qwen2.5-coder:latest'
          })

          // Se questo run crea un checkpoint (ha toccato almeno un file), lo
          // segnaliamo: da bot non c'è un pulsante "annulla modifiche" come nella
          // UI desktop, quindi l'utente remoto deve sapere che /revert esiste.
          let hasCheckpoint = false
          // @ts-ignore
          const removeCheckpointListener = window.ipcRenderer.on('agent-checkpoint-ready', (_evt: any, payload: any) => {
            if (payload.runId === runId) hasCheckpoint = true
          })

          await new Promise<void>((resolve) => {
            // @ts-ignore
            const removeAgentListener = window.ipcRenderer.on('agent-stream', (_evt: any, payload: any) => {
              if (payload.runId !== runId) return // evento di un run diverso, ignora
              if (payload.type === 'done' || payload.type === 'error') {
                const suffix = hasCheckpoint ? '\n\n💡 Questo task ha modificato dei file — usa /checkpoints o /revert per annullare.' : ''
                // @ts-ignore
                window.ipcRenderer.send('bot-reply', { source, chatId, text: payload.message + suffix })
                if (removeAgentListener && typeof removeAgentListener === 'function') removeAgentListener()
                if (removeCheckpointListener && typeof removeCheckpointListener === 'function') removeCheckpointListener()
                resolve()
              }
            })
          })
          return
        } catch (error: any) {
          replyText = `❌ Errore harness agentico remoto: ${error.message}`
        }
      }

      // @ts-ignore
      window.ipcRenderer.send('bot-reply', { source, chatId, text: replyText })
    })

    return () => {
      // @ts-ignore
      if (removeListener && typeof removeListener === 'function') removeListener()
    }
  }, [currentDir, currentFilePath])

  const loadDirectory = async (dirPath: string) => {
    try {
      // @ts-ignore (ignora l'errore TS temporaneamente, l'API è esposta in preload.ts)
      const result = await window.ipcRenderer.invoke('read-dir', dirPath)
      if (result.success) {
        setFiles(result.data)
        setCurrentDir(result.path)
      } else {
        console.error('Failed to read dir:', result.error)
      }
    } catch (e) {
      console.error(e)
    }
  }

  const loadFile = async (filePath: string) => {
    const existing = openTabs.find(t => t.path === filePath)
    if (existing) {
      setActiveTabPath(filePath)
      return
    }
    try {
      // @ts-ignore
      const result = await window.ipcRenderer.invoke('read-file', filePath)
      if (result.success) {
        setOpenTabs(prev => [...prev, { path: filePath, content: result.data, isDirty: false }])
        setActiveTabPath(filePath)
      } else {
        console.error('Failed to read file:', result.error)
      }
    } catch (e) {
      console.error(e)
    }
  }

  const closeTab = (filePath: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    setOpenTabs(prev => {
      const next = prev.filter(t => t.path !== filePath)
      if (activeTabPath === filePath) {
        setActiveTabPath(next.length > 0 ? next[next.length - 1].path : null)
      }
      return next
    })
  }

  const updateActiveTabContent = (value: string) => {
    setOpenTabs(prev => prev.map(t => t.path === activeTabPath ? { ...t, content: value, isDirty: true } : t))
  }

  const navigateUp = () => {
    if (!currentDir) return
    // Simple way to go up one directory using the OS path separators
    const isWin = currentDir.includes('\\')
    const separator = isWin ? '\\' : '/'
    const parts = currentDir.split(separator)
    if (parts.length > 1) {
      parts.pop() // remove last folder
      loadDirectory(parts.join(separator) || separator)
    }
  }

  const handleSave = async () => {
    if (!activeTabPath) return
    setIsSaving(true)
    try {
      const activeTab = openTabsRef.current.find(t => t.path === activeTabPath)
      // @ts-ignore
      const result = await window.ipcRenderer.invoke('save-file', activeTabPath, activeTab?.content ?? '')
      if (result.success) {
        setOpenTabs(prev => prev.map(t => t.path === activeTabPath ? { ...t, isDirty: false } : t))
      } else {
        console.error('Failed to save file:', result.error)
      }
    } catch (e) {
      console.error(e)
    } finally {
      setTimeout(() => setIsSaving(false), 500)
    }
  }

  // Keyboard shortcut listener for Save
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeTabPath])

  // Helper per indovinare il linguaggio per l'editor Monaco
  const getLanguage = (fileName: string) => {
    if (fileName.endsWith('.ts') || fileName.endsWith('.tsx')) return 'typescript'
    if (fileName.endsWith('.js') || fileName.endsWith('.jsx')) return 'javascript'
    if (fileName.endsWith('.json')) return 'json'
    if (fileName.endsWith('.md')) return 'markdown'
    if (fileName.endsWith('.html')) return 'html'
    if (fileName.endsWith('.css')) return 'css'
    if (fileName.endsWith('.rs')) return 'rust'
    if (fileName.endsWith('.py')) return 'python'
    return 'plaintext'
  }

  // Evidenzia temporaneamente (via decorazioni Monaco) le righe che l'agente ha
  // appena scritto, con uno sfondo distinto — svanisce dopo qualche secondo.
  const highlightChangedLines = (lines: number[]) => {
    const editor = editorRef.current
    if (!editor || lines.length === 0) return

    const monacoDecorations = lines.map(lineNumber => ({
      range: { startLineNumber: lineNumber, startColumn: 1, endLineNumber: lineNumber, endColumn: 1 },
      options: { isWholeLine: true, className: 'agent-edited-line', linesDecorationsClassName: 'agent-edited-line-gutter' }
    }))

    decorationsRef.current = editor.deltaDecorations(decorationsRef.current, monacoDecorations)

    setTimeout(() => {
      if (editorRef.current === editor) {
        decorationsRef.current = editor.deltaDecorations(decorationsRef.current, [])
      }
    }, 4000)
  }

  const handleEditorDidMount = (editor: any, monaco: any) => {
    editorRef.current = editor

    // Registra l'inline completion provider (Ghost Text FIM)
    monaco.languages.registerInlineCompletionsProvider('*', {
      provideInlineCompletions: async (model: any, position: any, _context: any, _token: any) => {
        // Estraiamo il prefisso (fino a 50 righe prima)
        const startLineNumber = Math.max(1, position.lineNumber - 50)
        const prefixRange = new monaco.Range(startLineNumber, 1, position.lineNumber, position.column)
        const prefix = model.getValueInRange(prefixRange)

        // Estraiamo il suffisso (fino a 50 righe dopo)
        const endLineNumber = Math.min(model.getLineCount(), position.lineNumber + 50)
        const suffixRange = new monaco.Range(position.lineNumber, position.column, endLineNumber, model.getLineMaxColumn(endLineNumber))
        const suffix = model.getValueInRange(suffixRange)

        if (!prefix.trim() && !suffix.trim()) {
          return { items: [] }
        }

        // Chiamiamo il nostro engine FIM
        const completionText = await getFimCompletion(prefix, suffix)

        if (completionText) {
          return {
            items: [{
              insertText: completionText,
              range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column)
            }]
          }
        }
        return { items: [] }
      },
      freeInlineCompletions(_completions: any) {
        // Nessuna risorsa da liberare in modo specifico per ora
      }
    })
  }

  const fileName = (p: string) => p.split('/').pop() || p.split('\\').pop() || p

  return (
    <div className="flex h-screen bg-[#1e1e1e] text-white">
      {/* Sidebar - Explorer */}
      <div className="w-72 bg-[#252526] border-r border-[#333] flex flex-col">
        <div className="p-4 flex items-center justify-between border-b border-[#333]">
          <div className="uppercase text-xs font-semibold tracking-wider text-gray-400 truncate" title={currentDir}>
            Esplora Risorse
          </div>
          <button
            onClick={navigateUp}
            className="text-gray-400 hover:text-white px-2 rounded hover:bg-[#333]"
            title="Sali di un livello"
          >
            ↑
          </button>
        </div>

        <div className="p-2 text-[10px] text-gray-500 break-all bg-[#1e1e1e]">
          {currentDir}
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {files.map((file) => (
            <div
              key={file.path}
              onClick={() => {
                if (file.isDirectory) {
                  loadDirectory(file.path)
                } else {
                  loadFile(file.path)
                }
              }}
              className={`py-1 px-2 hover:bg-[#37373d] cursor-pointer text-sm rounded flex items-center gap-2 ${activeTabPath === file.path ? 'bg-[#37373d]' : ''}`}
            >
              <span className="text-gray-400">{file.isDirectory ? '📁' : '📄'}</span>
              <span className="truncate">{file.name}</span>
            </div>
          ))}

          {files.length === 0 && (
            <div className="text-gray-500 text-sm italic text-center mt-4">
              Cartella vuota
            </div>
          )}
        </div>

        {/* Footer sidebar: impostazioni */}
        <div className="p-2 border-t border-[#333] flex items-center">
          <button
            onClick={() => setIsSettingsOpen(true)}
            className="text-gray-400 hover:text-white p-2 rounded hover:bg-[#333] flex items-center gap-2 text-xs"
            title="Impostazioni: chiavi API, OmniRoute, modelli locali"
          >
            <span>⚙️</span>
            <span>Impostazioni</span>
          </button>
        </div>
      </div>

      {isSettingsOpen && <SettingsPanel onClose={() => setIsSettingsOpen(false)} currentProjectRoot={currentDir} />}

      {/* Main Editor Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Tabs and Actions */}
        <div className="flex bg-[#2d2d2d] overflow-x-auto justify-between items-center pr-4">
          <div className="flex overflow-x-auto">
            {openTabs.length > 0 ? (
              openTabs.map(tab => (
                <div
                  key={tab.path}
                  onClick={() => setActiveTabPath(tab.path)}
                  className={`px-3 py-2 text-sm cursor-pointer flex items-center gap-2 shrink-0 border-t-2 ${
                    activeTabPath === tab.path
                      ? 'bg-[#1e1e1e] text-blue-400 border-blue-500'
                      : 'bg-[#2d2d2d] text-gray-400 border-transparent hover:bg-[#333]'
                  }`}
                  title={tab.path}
                >
                  {tab.isAgentWriting && <span className="animate-pulse" title="L'agente sta scrivendo questo file">🤖</span>}
                  <span className="truncate max-w-[140px]">{fileName(tab.path)}</span>
                  {tab.isDirty && <span className="text-gray-500">●</span>}
                  <button
                    onClick={(e) => closeTab(tab.path, e)}
                    className="text-gray-500 hover:text-white hover:bg-[#444] rounded px-1"
                    title="Chiudi scheda"
                  >
                    ✕
                  </button>
                </div>
              ))
            ) : (
              <div className="px-4 py-2 text-sm text-gray-500 italic shrink-0">
                Nessun file aperto
              </div>
            )}
          </div>

          {/* Actions */}
          {activeTabPath && (
            <button
              onClick={handleSave}
              className={`text-xs px-3 py-1 rounded transition-colors shrink-0 ${isSaving ? 'bg-green-600 text-white' : 'bg-[#37373d] text-gray-300 hover:bg-[#4d4d54]'}`}
            >
              {isSaving ? 'Salvato!' : 'Salva (Cmd+S)'}
            </button>
          )}
        </div>

        {/* Editor */}
        <div className="flex-1 relative">
          {!activeTabPath && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
               <img src="favicon.svg" className="w-32 h-32 opacity-10 grayscale" alt="Logo" />
            </div>
          )}
          <Editor
            height="100%"
            path={activeTabPath || undefined}
            language={activeTabPath ? getLanguage(activeTabPath) : 'plaintext'}
            theme="vs-dark"
            value={code}
            onChange={(value) => updateActiveTabContent(value || '')}
            onMount={handleEditorDidMount}
            options={{
              minimap: { enabled: false },
              fontSize: 14,
              wordWrap: 'on',
              readOnly: !activeTabPath, // Blocca la scrittura se non ci sono file aperti
              fontFamily: "'Fira Code', 'JetBrains Mono', 'Courier New', monospace",
              inlineSuggest: { enabled: true },
              lineNumbers: 'on'
            }}
          />
        </div>

        {/* Terminal Area */}
        <div className="h-64 flex flex-col shrink-0">
          <div className="px-4 py-1 bg-[#252526] text-xs font-semibold text-gray-400 border-t border-[#333] uppercase tracking-wider">
            Terminale
          </div>
          <div className="flex-1 min-h-0">
            <Terminal />
          </div>
        </div>
      </div>

      {/* AI Chat Panel */}
      <AiChat
        currentFilePath={currentFilePath}
        activeCode={code}
        currentProjectRoot={currentDir}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenFile={loadFile}
      />
    </div>
  )
}

export default App
