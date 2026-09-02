import { BrowserWindow } from 'electron'
import { FileEditorToolDefinition, executeFileEditor } from './tools/FileEditorPlugin'
import { TerminalToolDefinition, executeTerminalCommand, RunBackgroundCommandToolDefinition, CheckBackgroundCommandToolDefinition, StopBackgroundCommandToolDefinition, executeRunBackgroundCommand, executeCheckBackgroundCommand, executeStopBackgroundCommand } from './tools/TerminalPlugin'
import { SearchToolDefinition, executeSearch } from './tools/SearchPlugin'
import { GitToolDefinition, executeGit } from './tools/GitPlugin'
import { MemoryToolDefinition, executeMemorySave } from './tools/MemoryPlugin'
import { GitHubToolDefinition, executeGitHubPublish } from './tools/GitHubPlugin'
import { TestPluginToolDefinition, executeTestVerify } from './tools/TestPlugin'
import { SubagentToolDefinition, executeSubagent } from './tools/SubagentPlugin'
import { PerplexityToolDefinition, executeWebSearch } from './tools/PerplexityPlugin'
import { ScraplingToolDefinition, executeFetchWebpage } from './tools/ScraplingPlugin'
import { RepoMapToolDefinition, executeGetRepoMap } from './tools/RepoMapPlugin'
import { ReadFileToolDefinition, executeReadFile } from './tools/ReadFilePlugin'
import { PatchFileToolDefinition, executePatchFile } from './tools/PatchFilePlugin'
import { BrowserToolDefinitions, executeBrowserTool } from './tools/BrowserAgentPlugin'
import { DiagnosticsToolDefinition, executeGetDiagnostics } from './tools/DiagnosticsPlugin'
import { TodoToolDefinition, executeWriteTodos } from './tools/TodoPlugin'
import { GenerateImageToolDefinition, executeGenerateImage } from './tools/InvokeAIPlugin'
import { beginCheckpoint, snapshotFileIfNeeded, finalizeCheckpoint } from '../services/checkpointStore'
import { compactMessagesIfNeeded } from './contextCompactor'
import { ensureMcpServersConnected, getMcpToolDefinitions, executeMcpTool, isMcpToolName } from '../services/mcpClient'
import { checkToolCallAllowed } from './permissions'
import { loadAgentDefinitions } from '../services/definitionLoader'
import { getProjectMemories } from './memory'
import { runMCTSTask } from './deepReasoning'
import { EccHookEngine } from './EccHookEngine'
import { chatCompletion } from './llmClient'
import { broadcastAgentStream } from '../services/outputBuffer'
import * as path from 'path'
import * as fs from 'fs'

// Assumendo che esista una libreria LLM simile a openai o che la implementeremo qui.
// Per semplicità useremo fetch locale a Ollama o OpenAI.

// Tool di sola lettura/investigazione: sicuri anche in Plan Mode, dove l'agente
// deve poter esplorare il progetto per formulare un piano informato ma non può
// scrivere/eseguire nulla finché l'utente non approva esplicitamente.
const READ_ONLY_TOOLS = [
  SearchToolDefinition,
  PerplexityToolDefinition,
  ScraplingToolDefinition,
  RepoMapToolDefinition,
  ReadFileToolDefinition,
  SubagentToolDefinition,
  // navigate/screenshot/eval sono investigazione (guardare, non agire); browser_click
  // resta tra i WRITE_TOOLS perché può innescare azioni reali sulla pagina (submit, ecc.)
  BrowserToolDefinitions[0], // browser_navigate
  BrowserToolDefinitions[1], // browser_screenshot
  BrowserToolDefinitions[2], // browser_eval
  DiagnosticsToolDefinition,
  // write_todos non tocca mai il filesystem: è solo bookkeeping/status del
  // proprio piano, sicuro anche in Plan Mode.
  TodoToolDefinition
]

const WRITE_TOOLS = [
  FileEditorToolDefinition,
  TerminalToolDefinition,
  RunBackgroundCommandToolDefinition,
  CheckBackgroundCommandToolDefinition,
  StopBackgroundCommandToolDefinition,
  GitToolDefinition,
  MemoryToolDefinition,
  GitHubToolDefinition,
  TestPluginToolDefinition,
  PatchFileToolDefinition,
  BrowserToolDefinitions[3], // browser_click
  GenerateImageToolDefinition
]

export async function runAgenticTask(
  mainWindow: BrowserWindow,
  userPrompt: string,
  systemPrompt: string,
  cwd: string,
  model: string = 'qwen2.5-coder:latest', // Ollama
  images: string[] = [],
  deepReasoning: boolean = false,
  runId?: string,
  planMode: boolean = false
) {
  if (deepReasoning) {
    // Se attivato il toggle MCTS/Supreme Court, dirottiamo l'esecuzione al motore avanzato
    await runMCTSTask(mainWindow, userPrompt, systemPrompt, cwd, model, runId)
    return
  }

  // Hook di progetto: <cwd>/.code-ide/hooks.json — prima puntava a un percorso
  // globale fisso e praticamente introvabile (~/.gemini/antigravity-ide/...),
  // rendendo la feature invisibile/inconfigurabile. Ora è per-progetto, versionabile
  // con il repo, come i hooks.json di Claude Code stesso.
  const eccEngine = new EccHookEngine(cwd)

  // Session Start Hook
  await eccEngine.dispatch('SessionStart');

  // 1. Definisci i Tool: in Plan Mode SOLO quelli di sola lettura sono disponibili
  // — l'agente non ha letteralmente modo di scrivere/eseguire nulla, non è solo
  // un'istruzione a parole che potrebbe ignorare.
  // I tool MCP (server di terze parti da .code-ide/mcp.json) sono esclusi dalla
  // Plan Mode per default prudente: non conosciamo la natura di ogni tool scoperto
  // da un server esterno (potrebbe scrivere/eseguire), quindi li trattiamo come
  // WRITE_TOOLS anche se in pratica molti sono di sola lettura.
  await ensureMcpServersConnected(cwd)
  const mcpTools = getMcpToolDefinitions(cwd)
  const tools = planMode ? READ_ONLY_TOOLS : [...READ_ONLY_TOOLS, ...WRITE_TOOLS, ...mcpTools]

  // 1.5. Aggiungi memorie di progetto al System Prompt
  const memories = getProjectMemories(cwd)
  let injectedSystemPrompt = systemPrompt
    + "\n\nSe il task richiede 3 o più passi distinti, usa il tool 'write_todos' per dichiarare il piano all'inizio e aggiornarne lo stato (pending/in_progress/completed) man mano che procedi — l'utente lo vede in tempo reale."
    + "\n\nHai ricevuto solo un ALBERO di cartelle e file (percorsi, nessun contenuto): NON conosci cosa c'è dentro nessun file finché non lo leggi davvero. Prima di affermare cosa fa o contiene un file, o prima di modificarlo, usa SEMPRE 'read_file' (per un file specifico già individuato) o 'search_codebase' (per trovare dove si trova qualcosa) — non indovinare mai il contenuto dal solo nome o percorso del file."
  if (memories.length > 0) {
    injectedSystemPrompt += '\n\n[MEMORIE DI PROGETTO - REGOLE FISSE]\n'
    memories.forEach(m => {
      injectedSystemPrompt += `- ${m.key}: ${m.value}\n`
    })
  }

  // Sub-agenti persistenti (.code-ide/agents/*.md): il modello li vede elencati
  // qui e può richiamarli per NOME con invoke_subagent invece di reinventare la
  // stessa persona specializzata ad-hoc a ogni task.
  const agentDefinitions = loadAgentDefinitions(cwd)
  if (agentDefinitions.length > 0) {
    injectedSystemPrompt += '\n\n[SUB-AGENTI PERSISTENTI DISPONIBILI — usa invoke_subagent con agentName]\n'
    agentDefinitions.forEach(a => {
      injectedSystemPrompt += `- ${a.name}: ${a.description}\n`
    })
  }

  if (planMode) {
    injectedSystemPrompt += `\n\n[MODALITÀ PIANO ATTIVA]\nNon hai accesso a NESSUN tool di scrittura/esecuzione (niente edit_file, patch_file, run_terminal_command, manage_git, ecc.) — solo a tool di investigazione (search_codebase, read_file, get_repo_map, invoke_subagent, web_search, fetch_webpage). Esplora quanto ti serve con questi tool per capire il codice reale, poi produci un PIANO chiaro e numerato dei passi che eseguiresti per completare il task, includendo per ogni passo quali file toccheresti e come. NON provare a eseguire il task: il tuo unico obiettivo è produrre il piano a testo. L'utente lo revisionerà e, se approvato, un secondo passaggio con accesso completo ai tool lo eseguirà davvero.`
  }

  // 2. Inizializza la conversazione (con le immagini allegate, se presenti)
  const messages: any[] = [
    { role: 'system', content: injectedSystemPrompt },
    { role: 'user', content: userPrompt, ...(images.length > 0 ? { images } : {}) }
  ]

  // Checkpoint/rewind: senza runId non c'è modo di collegare il checkpoint a un
  // messaggio in UI per offrirne l'annullamento, quindi lo saltiamo in quel caso
  // raro invece di crearne uno orfano. In Plan Mode non serve mai (nessuna scrittura).
  const checkpointsEnabled = !planMode && !!runId
  if (checkpointsEnabled) {
    beginCheckpoint(runId as string, userPrompt.slice(0, 100))
  }

  let isTaskComplete = false
  let finalResponse = ''

  // Loop di Agentic Action (DeepSeek Harness logic). 5 era troppo poco per task
  // che toccano più file (repo-map + qualche read_file/edit_file esauriva già il
  // budget prima di finire) — ora configurabile via .env per chi vuole un limite
  // diverso, con un default più realistico per task multi-file reali.
  const maxIterations = Number(process.env.AGENT_MAX_ITERATIONS) || 25
  let iterations = 0
  // OmniRoute (e in parte OpenRouter) instradano automaticamente verso un
  // provider/modello diverso da quello richiesto quando quello scelto esaurisce
  // la quota o è momentaneamente indisponibile — prima non c'era alcun modo di
  // sapere quale modello avesse risposto DAVVERO. Segnalato una sola volta
  // (non a ogni iterazione, per non intasare lo stream) quando differisce da
  // quello richiesto.
  let resolvedModelAnnounced = false

  while (!isTaskComplete && iterations < maxIterations) {
    iterations++

    // Compattazione automatica del contesto PRIMA di ogni chiamata: un task
    // lungo (tool result voluminosi come repo-map/read_file, molte iterazioni)
    // altrimenti non ha alcun modo di evitare di saturare/superare la finestra
    // di contesto del modello.
    await compactMessagesIfNeeded(messages, model, mainWindow, runId)

    // Notifica UI che l'agente sta pensando
    broadcastAgentStream(mainWindow, { type: 'status', message: `[⚙️ L'agente sta pensando (Iterazione ${iterations})...]` }, runId)

    try {
      const result = await chatCompletion({ model, messages, tools })
      const assistantMessage = result.message
      messages.push(assistantMessage)

      if (!resolvedModelAnnounced && result.resolvedModel && result.resolvedModel !== model) {
        resolvedModelAnnounced = true
        broadcastAgentStream(mainWindow, { type: 'status', message: `[🔀 OmniRoute ha instradato "${model}" verso: ${result.resolvedModel}]` }, runId)
      }

      if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        // L'agente ha deciso di usare un tool
        for (const toolCall of assistantMessage.tool_calls) {
          const functionName = toolCall.function.name
          const functionArgs = toolCall.function.arguments // Oggetto JS o stringa JSON da parsare
          let parsedArgs = typeof functionArgs === 'string' ? JSON.parse(functionArgs) : functionArgs

          let toolResult = ''

          // Permessi granulari di progetto (.code-ide/settings.json): controllato
          // PRIMA di qualunque hook o esecuzione — se negato, il tool non gira
          // affatto, niente PreToolUse/PostToolUse per un'azione mai avvenuta.
          const permissionCheck = checkToolCallAllowed(cwd, functionName, parsedArgs)
          if (!permissionCheck.allowed) {
            broadcastAgentStream(mainWindow, { type: 'status', message: `[🚫 Permesso negato: ${functionName}]` }, runId)
            messages.push({ role: 'tool', name: functionName, content: `🚫 ${permissionCheck.reason}` })
            continue
          }

          // PreToolUse Hook
          await eccEngine.dispatch('PreToolUse', functionName, parsedArgs);

          if (functionName === 'edit_file') {
            broadcastAgentStream(mainWindow, { type: 'status', message: `[📝 Scrittura file in corso: ${parsedArgs.filePath}]` }, runId)
            // Notifica il renderer PRIMA di scrivere: apre/porta in primo piano la scheda
            // del file che l'agente sta per modificare, così l'utente lo vede aprirsi.
            mainWindow.webContents.send('agent-file-write', { filePath: parsedArgs.filePath, cwd, phase: 'start', runId })
            if (checkpointsEnabled) snapshotFileIfNeeded(cwd, runId as string, parsedArgs.filePath)
            toolResult = await executeFileEditor(parsedArgs, cwd)
            mainWindow.webContents.send('agent-file-write', { filePath: parsedArgs.filePath, cwd, phase: 'done', content: parsedArgs.content, runId })
          } else if (functionName === 'run_terminal_command') {
            broadcastAgentStream(mainWindow, { type: 'status', message: `[🖥️ Esecuzione comando: ${parsedArgs.command}]` }, runId)
            toolResult = await executeTerminalCommand(parsedArgs, cwd, mainWindow)
          } else if (functionName === 'run_background_command') {
            broadcastAgentStream(mainWindow, { type: 'status', message: `[🖥️ Avvio comando in background: ${parsedArgs.command}]` }, runId)
            toolResult = await executeRunBackgroundCommand(parsedArgs, cwd, mainWindow)
          } else if (functionName === 'check_background_command') {
            toolResult = await executeCheckBackgroundCommand(parsedArgs)
          } else if (functionName === 'stop_background_command') {
            broadcastAgentStream(mainWindow, { type: 'status', message: `[🛑 Arresto job background: ${parsedArgs.jobId}]` }, runId)
            toolResult = await executeStopBackgroundCommand(parsedArgs)
          } else if (functionName === 'search_codebase') {
            broadcastAgentStream(mainWindow, { type: 'status', message: `[🔍 Ricerca nel codice: ${parsedArgs.query}]` }, runId)
            toolResult = await executeSearch(parsedArgs, cwd)
          } else if (functionName === 'manage_git') {
            broadcastAgentStream(mainWindow, { type: 'status', message: `[🐙 Esecuzione Git: ${parsedArgs.action}]` }, runId)
            toolResult = await executeGit(parsedArgs, cwd)
          } else if (functionName === 'save_memory') {
            broadcastAgentStream(mainWindow, { type: 'status', message: `[🧠 Memorizzazione regola: ${parsedArgs.key}]` }, runId)
            toolResult = await executeMemorySave(parsedArgs, cwd)
          } else if (functionName === 'publish_to_github') {
            broadcastAgentStream(mainWindow, { type: 'status', message: `[📦 Pubblicazione su GitHub in corso...]` }, runId)
            toolResult = await executeGitHubPublish(cwd, parsedArgs.repoName, parsedArgs.isPrivate)
          } else if (functionName === 'run_and_verify_tests') {
            broadcastAgentStream(mainWindow, { type: 'status', message: `[🧪 Esecuzione Test TDD in corso...]` }, runId)
            toolResult = await executeTestVerify(parsedArgs, cwd)
          } else if (functionName === 'invoke_subagent') {
            broadcastAgentStream(mainWindow, { type: 'status', message: `[🤖 Invocazione Sub-Agente: ${parsedArgs.agentRole}...]` }, runId)
            toolResult = await executeSubagent(parsedArgs, model, cwd)
          } else if (functionName === 'web_search') {
            broadcastAgentStream(mainWindow, { type: 'status', message: `[🔎 Ricerca web: ${parsedArgs.query}]` }, runId)
            toolResult = await executeWebSearch(parsedArgs)
          } else if (functionName === 'fetch_webpage') {
            broadcastAgentStream(mainWindow, { type: 'status', message: `[📄 Lettura pagina: ${parsedArgs.url}]` }, runId)
            toolResult = await executeFetchWebpage(parsedArgs)
          } else if (functionName === 'get_repo_map') {
            broadcastAgentStream(mainWindow, { type: 'status', message: `[🗺️ Generazione repo map...]` }, runId)
            toolResult = await executeGetRepoMap(parsedArgs, cwd)
          } else if (functionName === 'read_file') {
            broadcastAgentStream(mainWindow, { type: 'status', message: `[👁️ Lettura file: ${parsedArgs.filePath}]` }, runId)
            toolResult = await executeReadFile(parsedArgs, cwd)
          } else if (functionName === 'patch_file') {
            broadcastAgentStream(mainWindow, { type: 'status', message: `[🩹 Patch file: ${parsedArgs.filePath}]` }, runId)
            mainWindow.webContents.send('agent-file-write', { filePath: parsedArgs.filePath, cwd, phase: 'start', runId })
            if (checkpointsEnabled) snapshotFileIfNeeded(cwd, runId as string, parsedArgs.filePath)
            toolResult = await executePatchFile(parsedArgs, cwd)
            // Rileggiamo il contenuto reale post-patch per l'evidenziazione in editor,
            // invece di ricostruirlo qui (più semplice e sempre coerente col disco).
            try {
              const patchedPath = path.isAbsolute(parsedArgs.filePath) ? parsedArgs.filePath : path.join(cwd, parsedArgs.filePath)
              const patchedContent = fs.readFileSync(patchedPath, 'utf-8')
              mainWindow.webContents.send('agent-file-write', { filePath: parsedArgs.filePath, cwd, phase: 'done', content: patchedContent, runId })
            } catch {
              // Se non riusciamo a rileggerlo per l'anteprima, la patch è comunque già stata applicata su disco.
            }
          } else if (functionName.startsWith('browser_')) {
            broadcastAgentStream(mainWindow, { type: 'status', message: `[🌐 ${functionName}: ${JSON.stringify(parsedArgs)}]` }, runId)
            toolResult = await executeBrowserTool(functionName, parsedArgs, cwd)
          } else if (functionName === 'get_diagnostics') {
            broadcastAgentStream(mainWindow, { type: 'status', message: `[🩺 Analisi tipi: ${parsedArgs.filePath}]` }, runId)
            toolResult = await executeGetDiagnostics(parsedArgs, cwd)
          } else if (functionName === 'write_todos') {
            toolResult = await executeWriteTodos(parsedArgs, mainWindow, runId)
          } else if (functionName === 'generate_image') {
            broadcastAgentStream(mainWindow, { type: 'status', message: `[🎨 Generazione immagine: ${parsedArgs.outputPath}]` }, runId)
            toolResult = await executeGenerateImage(parsedArgs, cwd)
          } else if (isMcpToolName(functionName)) {
            broadcastAgentStream(mainWindow, { type: 'status', message: `[🔌 Tool MCP: ${functionName}]` }, runId)
            toolResult = await executeMcpTool(cwd, functionName, parsedArgs)
          } else {
            toolResult = `Strumento non riconosciuto: ${functionName}`
          }

          // PostToolUse Hook
          await eccEngine.dispatch('PostToolUse', functionName, { result: toolResult });

          // Notifica UI del risultato
          broadcastAgentStream(mainWindow, { type: 'status', message: `[✅ Tool completato]` }, runId)

          // Aggiungi il risultato alla conversazione
          messages.push({
            role: 'tool',
            name: functionName,
            content: toolResult
          })
        }
        // Il loop riparte, l'LLM valuterà il risultato del tool
      } else {
        // L'agente ha finito e risponde a testo
        isTaskComplete = true
        finalResponse = assistantMessage.content
        broadcastAgentStream(mainWindow, { type: planMode ? 'plan' : 'done', message: finalResponse }, runId)
      }

    } catch (error: any) {
      isTaskComplete = true
      broadcastAgentStream(mainWindow, { type: 'error', message: `Crash dell'Harness: ${error.message}` }, runId)
    }
  }

  if (iterations >= maxIterations) {
    broadcastAgentStream(mainWindow, { type: 'error', message: `Raggiunto il limite massimo di azioni (${maxIterations}). L'agente si è fermato per sicurezza.` }, runId)
  }

  // Finalizza il checkpoint (se almeno un file è stato toccato) e notifica il
  // renderer: gli permette di offrire un pulsante "annulla queste modifiche"
  // sul messaggio finale di questo run, qualunque sia l'esito (successo, errore
  // a metà task, o limite di iterazioni raggiunto — un task fallito a metà è
  // il caso in cui l'annullamento serve di più).
  if (checkpointsEnabled) {
    const fileCount = finalizeCheckpoint(cwd, runId as string)
    if (fileCount > 0) {
      mainWindow.webContents.send('agent-checkpoint-ready', { runId, fileCount, taskSummary: userPrompt.slice(0, 100) })
    }
  }

  // Session End Hook
  await eccEngine.dispatch('SessionEnd');
}
