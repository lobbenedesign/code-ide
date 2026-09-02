import { BrowserWindow } from 'electron'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { FileEditorToolDefinition, executeFileEditor } from './tools/FileEditorPlugin'
import { TerminalToolDefinition, executeTerminalCommand } from './tools/TerminalPlugin'
import { ReadFileToolDefinition, executeReadFile } from './tools/ReadFilePlugin'
import { SearchToolDefinition, executeSearch } from './tools/SearchPlugin'
import { RepoMapToolDefinition, executeGetRepoMap } from './tools/RepoMapPlugin'
import { DiagnosticsToolDefinition, executeGetDiagnostics } from './tools/DiagnosticsPlugin'
import { chatCompletion } from './llmClient'
import { broadcastAgentStream } from '../services/outputBuffer'
import { beginCheckpoint, snapshotFileIfNeeded, finalizeCheckpoint } from '../services/checkpointStore'
import { checkToolCallAllowed } from './permissions'
import { compactMessagesIfNeeded } from './contextCompactor'

// typescript usa internamente globali CJS (__filename) incompatibili con il bundle
// ESM del main process: caricato a runtime, come già si fa per node-pty in main.ts.
const require = createRequire(import.meta.url)
const ts = require('typescript') as typeof import('typescript')

const SYNTAX_CHECKABLE_EXT = /\.(ts|tsx|js|jsx)$/i
const INVESTIGATIVE_TOOL_NAMES = new Set(['read_file', 'search_codebase', 'get_repo_map', 'get_diagnostics'])
const CANDIDATE_MAX_ITERATIONS = 5

// Screening oggettivo prima del voto soggettivo del giudice LLM (ispirato al
// punteggio a "partial credit" di reasoning-tree-mcts, qui scoped a un controllo
// di validità sintattica via AST invece di esecuzione sandboxata completa — un
// segnale reale ed economico che il solo giudizio testuale del giudice non dava:
// nessuna garanzia che il codice proposto fosse anche solo sintatticamente valido).
function countSyntaxErrors(filePath: string, content: string): number {
  const scriptKind = filePath.endsWith('.tsx') || filePath.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, false, scriptKind)
  // parseDiagnostics è un campo interno stabile dell'API di TypeScript, usato
  // comunemente per controlli di sintassi "leggeri" senza costruire un intero Program.
  return ((sourceFile as any).parseDiagnostics || []).length
}

function scoreCandidateSyntax(candidate: { tool_calls?: any[] }): number {
  if (!candidate.tool_calls) return 0
  let errors = 0
  for (const call of candidate.tool_calls) {
    if (call.function?.name !== 'edit_file') continue
    try {
      const args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments
      if (args.filePath && SYNTAX_CHECKABLE_EXT.test(args.filePath) && typeof args.content === 'string') {
        errors += countSyntaxErrors(args.filePath, args.content)
      }
    } catch {
      errors += 1 // arguments non parsabili: consideralo un errore, non un crash
    }
  }
  return errors
}

export async function runSupremeCourtTask(
  mainWindow: BrowserWindow,
  userPrompt: string,
  systemPrompt: string,
  cwd: string,
  model: string,
  runId?: string
) {
  broadcastAgentStream(mainWindow, { type: 'status', message: `[⚖️ Avvio Supreme Court per task complesso...]` }, runId)

  if (runId) beginCheckpoint(runId, userPrompt.slice(0, 100))

  // Eseguiamo 3 "Giudici" indipendenti in parallelo
  const numJudges = 3
  const candidatePromises = []

  for (let i = 0; i < numJudges; i++) {
    candidatePromises.push(generateCandidate(userPrompt, systemPrompt, model, i + 1, mainWindow, cwd, runId))
  }

  const candidates = await Promise.all(candidatePromises)

  // Screening oggettivo: scarta i candidati con codice sintatticamente non valido
  // PRIMA del voto soggettivo del giudice, invece di lasciare che un'opinione
  // testuale scelga (anche per errore) una soluzione che non compilerebbe nemmeno.
  const scored = candidates.map(c => ({ ...c, syntaxErrors: scoreCandidateSyntax(c) }))
  const validCandidates = scored.filter(c => c.syntaxErrors === 0)
  const survivingCandidates = validCandidates.length > 0 ? validCandidates : scored

  if (validCandidates.length < scored.length) {
    const discarded = scored.filter(c => c.syntaxErrors > 0).map(c => `Giudice ${c.judgeId} (${c.syntaxErrors} errori)`).join(', ')
    broadcastAgentStream(mainWindow, { type: 'status', message: `[⚖️ Screening sintattico: scartati ${scored.length - validCandidates.length}/${scored.length} candidati con codice non valido — ${discarded}]` }, runId)
  }

  broadcastAgentStream(mainWindow, { type: 'status', message: `[⚖️ Valutazione delle soluzioni candidate sopravvissute allo screening...]` }, runId)

  // Il 4° modello sceglie la migliore tra quelle già filtrate per validità sintattica
  const bestCandidate = await evaluateCandidates(survivingCandidates, userPrompt, systemPrompt, model)

  broadcastAgentStream(mainWindow, { type: 'status', message: `[⚖️ Soluzione scelta (Giudice ${bestCandidate.judgeId}). Applicazione in corso...]` }, runId)

  // Esegue le tool calls del candidato vincente
  if (bestCandidate.tool_calls) {
    for (const toolCall of bestCandidate.tool_calls) {
      await executeBestTool(toolCall, cwd, mainWindow, runId)
    }
  }

  if (runId) {
    const fileCount = finalizeCheckpoint(cwd, runId)
    if (fileCount > 0) mainWindow.webContents.send('agent-checkpoint-ready', { runId, fileCount, taskSummary: userPrompt.slice(0, 100) })
  }

  broadcastAgentStream(mainWindow, { type: 'done', message: bestCandidate.content || 'Task completato con successo tramite Supreme Court.' }, runId)
}

// Ogni "giudice" può investigare il codice reale (read_file/search_codebase/
// get_repo_map/get_diagnostics — tool side-effect-free, sicuri da eseguire 3 volte
// in parallelo) prima di proporre la sua soluzione, invece di rispondere alla cieca
// in un'unica chiamata come prima. Le tool_calls di SCRITTURA (edit_file/
// run_terminal_command) vengono solo raccolte come proposta, MAI eseguite qui:
// solo il candidato vincente le esegue davvero, dopo il voto.
async function generateCandidate(userPrompt: string, systemPrompt: string, model: string, judgeId: number, mainWindow: BrowserWindow, cwd: string, runId?: string) {
  broadcastAgentStream(mainWindow, { type: 'status', message: `[Giudice ${judgeId} sta elaborando la soluzione...]` }, runId)

  const tools = [FileEditorToolDefinition, TerminalToolDefinition, ReadFileToolDefinition, SearchToolDefinition, RepoMapToolDefinition, DiagnosticsToolDefinition]
  const messages: any[] = [
    { role: 'system', content: systemPrompt + '\nATTENZIONE: Sei un membro della Supreme Court. Investiga il codice reale (read_file/search_codebase/get_repo_map/get_diagnostics) prima di proporre una soluzione. Cerca la soluzione più robusta.' },
    { role: 'user', content: userPrompt }
  ]

  let iterations = 0
  while (iterations < CANDIDATE_MAX_ITERATIONS) {
    iterations++
    await compactMessagesIfNeeded(messages, model, mainWindow, runId)
    const result = await chatCompletion({
      model,
      messages,
      tools,
      temperature: 0.7 + (judgeId * 0.1) // Diversifica le risposte
    })
    const assistantMessage = result.message
    messages.push(assistantMessage)

    const toolCalls = assistantMessage.tool_calls || []
    const writeCalls = toolCalls.filter((tc: any) => !INVESTIGATIVE_TOOL_NAMES.has(tc.function.name))
    const investigativeCalls = toolCalls.filter((tc: any) => INVESTIGATIVE_TOOL_NAMES.has(tc.function.name))

    if (toolCalls.length === 0 || writeCalls.length > 0) {
      // Il candidato ha finito di investigare: o risponde a testo, o propone
      // un'azione di scrittura (raccolta ma non eseguita — decide il voto dopo).
      return { judgeId, content: assistantMessage.content, tool_calls: writeCalls.length > 0 ? writeCalls : undefined }
    }

    for (const call of investigativeCalls) {
      const args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments
      let toolResult = ''
      if (call.function.name === 'read_file') toolResult = await executeReadFile(args, cwd)
      else if (call.function.name === 'search_codebase') toolResult = await executeSearch(args, cwd)
      else if (call.function.name === 'get_repo_map') toolResult = await executeGetRepoMap(args, cwd)
      else if (call.function.name === 'get_diagnostics') toolResult = await executeGetDiagnostics(args, cwd)
      messages.push({ role: 'tool', name: call.function.name, content: toolResult })
    }
  }

  return { judgeId, content: messages[messages.length - 1]?.content || '(limite di investigazioni raggiunto senza una proposta finale)', tool_calls: undefined }
}

async function evaluateCandidates(candidates: any[], userPrompt: string, systemPrompt: string, model: string) {
  const prompt = `Sei il Giudice Supremo. Devi valutare 3 soluzioni per questo problema:\n\nProblema: ${userPrompt}\n\n`
    + candidates.map(c => `Soluzione ${c.judgeId}:\nMessaggio: ${c.content}\nStrumenti usati: ${JSON.stringify(c.tool_calls)}\n`).join('\n')
    + `\nScegli la migliore. Rispondi SOLO con il numero del giudice (1, 2, o 3).`

  const result = await chatCompletion({
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1 // Massima precisione
  })

  const answer = result.message?.content?.trim()

  let bestId = 1
  if (answer && answer.includes('2')) bestId = 2
  if (answer && answer.includes('3')) bestId = 3

  return candidates.find(c => c.judgeId === bestId) || candidates[0]
}

async function executeBestTool(toolCall: any, cwd: string, mainWindow: BrowserWindow, runId?: string) {
  const functionName = toolCall.function.name
  let parsedArgs = typeof toolCall.function.arguments === 'string' ? JSON.parse(toolCall.function.arguments) : toolCall.function.arguments

  const permissionCheck = checkToolCallAllowed(cwd, functionName, parsedArgs)
  if (!permissionCheck.allowed) {
    broadcastAgentStream(mainWindow, { type: 'status', message: `[🚫 Permesso negato: ${permissionCheck.reason}]` }, runId)
    return
  }

  if (functionName === 'edit_file') {
    broadcastAgentStream(mainWindow, { type: 'status', message: `[📝 Scrittura file: ${parsedArgs.filePath}]` }, runId)
    mainWindow.webContents.send('agent-file-write', { filePath: parsedArgs.filePath, cwd, phase: 'start', runId })
    if (runId) snapshotFileIfNeeded(cwd, runId, parsedArgs.filePath)
    await executeFileEditor(parsedArgs, cwd)
    mainWindow.webContents.send('agent-file-write', { filePath: parsedArgs.filePath, cwd, phase: 'done', content: parsedArgs.content, runId })
  } else if (functionName === 'run_terminal_command') {
    broadcastAgentStream(mainWindow, { type: 'status', message: `[🖥️ Comando: ${parsedArgs.command}]` }, runId)
    await executeTerminalCommand(parsedArgs, cwd, mainWindow)
  }
}

const MCTS_NUM_BRANCHES = 4
const MCTS_REFINE_TOP_N = 2
const MCTS_SCORE_PER_ERROR = 12
const MCTS_SCORE_NO_EDIT = 55 // punteggio neutro: nessuna modifica TS/JS da valutare (es. solo comando terminale)

interface MctsNode {
  judgeId: number
  content: string
  tool_calls?: any[]
  score: number
  diagnosticsSummary: string
  refined?: boolean
}

/**
 * "Simulazione" reale (non testuale/LLM) di un candidato: applica DAVVERO ogni
 * edit_file proposto, al percorso reale del progetto, e ci gira la vera
 * diagnostica di tipo (get_diagnostics / TS Compiler API) — poi ripristina
 * SEMPRE lo stato originale nel blocco finally, qualunque cosa succeda. Solo
 * il nodo vincente finale scriverà per davvero (via executeBestTool), a
 * differenza di questa fase che è puramente di misurazione. Il punteggio è a
 * "partial credit": non un semplice valido/non valido, ma quanti problemi di
 * tipo reali introduce ciascun candidato — la differenza sostanziale rispetto
 * al solo screening sintattico usato dalla Supreme Court.
 */
async function simulateAndScore(candidate: { judgeId: number, content: string, tool_calls?: any[] }, cwd: string): Promise<MctsNode> {
  if (!candidate.tool_calls || candidate.tool_calls.length === 0) {
    return { ...candidate, score: MCTS_SCORE_NO_EDIT, diagnosticsSummary: '(nessuna modifica proposta da valutare — solo risposta testuale o comando terminale)' }
  }

  const editCalls = candidate.tool_calls.filter((c: any) => c.function?.name === 'edit_file')
  if (editCalls.length === 0) {
    return { ...candidate, score: MCTS_SCORE_NO_EDIT, diagnosticsSummary: '(nessuna edit_file da valutare — es. solo run_terminal_command)' }
  }

  let totalScore = 0
  let scored = 0
  const summaries: string[] = []

  for (const call of editCalls) {
    let args: any
    try {
      args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments
    } catch {
      summaries.push('⚠️ Argomenti di edit_file non parsabili — penalità massima.')
      totalScore += 0
      scored++
      continue
    }
    if (!args.filePath || typeof args.content !== 'string') continue
    if (!SYNTAX_CHECKABLE_EXT.test(args.filePath)) {
      // Linguaggi non coperti da get_diagnostics: nessun segnale reale disponibile, punteggio neutro
      summaries.push(`${args.filePath}: linguaggio non coperto da diagnostica reale (punteggio neutro)`)
      totalScore += MCTS_SCORE_NO_EDIT
      scored++
      continue
    }

    const targetPath = path.isAbsolute(args.filePath) ? args.filePath : path.join(cwd, args.filePath)
    const existedBefore = fs.existsSync(targetPath)
    const original = existedBefore ? fs.readFileSync(targetPath, 'utf-8') : null

    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true })
      fs.writeFileSync(targetPath, args.content, 'utf-8')
      const diagResult = await executeGetDiagnostics({ filePath: args.filePath }, cwd)
      const errorMatch = diagResult.match(/⚠️\s*(\d+)\s*problema/i)
      const errCount = errorMatch ? parseInt(errorMatch[1], 10) : (diagResult.startsWith('✅') ? 0 : 1)
      totalScore += Math.max(0, 100 - errCount * MCTS_SCORE_PER_ERROR)
      scored++
      summaries.push(`${args.filePath}: ${diagResult.split('\n')[0]}`)
    } finally {
      // Ripristino incondizionato: la simulazione non deve MAI lasciare il
      // filesystem reale in uno stato diverso da quello di partenza.
      if (existedBefore) fs.writeFileSync(targetPath, original as string, 'utf-8')
      else fs.rmSync(targetPath, { force: true })
    }
  }

  const avgScore = scored > 0 ? totalScore / scored : MCTS_SCORE_NO_EDIT
  return { ...candidate, score: avgScore, diagnosticsSummary: summaries.join('\n') || '(nessun file valutabile)' }
}

// Nodo figlio dell'albero: raffina un candidato promettente ma imperfetto
// alla luce del feedback REALE ottenuto dalla simulazione (non un'opinione
// LLM, ma l'esito vero della diagnostica di tipo) — questo è ciò che rende
// l'esplorazione un vero albero a più livelli invece di un voto piatto a un
// solo round come la Supreme Court.
async function refineCandidate(node: MctsNode, userPrompt: string, systemPrompt: string, model: string): Promise<{ judgeId: number, content: string, tool_calls?: any[] }> {
  const tools = [FileEditorToolDefinition, TerminalToolDefinition]
  const messages: any[] = [
    { role: 'system', content: systemPrompt + '\nSei in una fase di RAFFINAMENTO all\'interno di una ricerca ad albero (MCTS). La tua proposta precedente è stata applicata realmente in una simulazione e sottoposta a una vera diagnostica di tipo.' },
    { role: 'user', content: userPrompt },
    { role: 'assistant', content: node.content || '', tool_calls: node.tool_calls },
    { role: 'user', content: `Risultato REALE della diagnostica di tipo sulla tua proposta:\n${node.diagnosticsSummary}\n\nSe ci sono errori, forniscici una versione corretta usando di nuovo 'edit_file' con il contenuto COMPLETO e corretto del file. Se non ci sono errori, ripeti esattamente la stessa proposta.` }
  ]

  const result = await chatCompletion({ model, messages, tools, temperature: 0.3 })
  const toolCalls = result.message.tool_calls
  return { judgeId: node.judgeId, content: result.message.content, tool_calls: toolCalls && toolCalls.length > 0 ? toolCalls : node.tool_calls }
}

/**
 * Vero Monte Carlo Tree Search a due livelli, non più un placeholder:
 *  1. ESPANSIONE: N "rami" indipendenti generano una proposta ciascuno (come
 *     la Supreme Court, con investigazione reale del codice).
 *  2. SIMULAZIONE: ogni proposta viene applicata DAVVERO (in modo transitorio
 *     e sempre ripristinato) e valutata con una vera diagnostica di tipo —
 *     punteggio a partial-credit, non un giudizio testuale.
 *  3. RAFFINAMENTO (secondo livello dell'albero): i migliori rami vengono
 *     rigenerati alla luce del feedback reale ricevuto, poi ri-simulati.
 *  4. SELEZIONE: vince il nodo (originale o raffinato) con il punteggio più
 *     alto in assoluto; le sue tool_calls vengono finalmente scritte per davvero.
 */
export async function runMCTSTask(
  mainWindow: BrowserWindow,
  userPrompt: string,
  systemPrompt: string,
  cwd: string,
  model: string,
  runId?: string
) {
  broadcastAgentStream(mainWindow, { type: 'status', message: `[🌳 MCTS: espansione di ${MCTS_NUM_BRANCHES} rami indipendenti...]` }, runId)

  if (runId) beginCheckpoint(runId, userPrompt.slice(0, 100))

  const branchPromises = []
  for (let i = 0; i < MCTS_NUM_BRANCHES; i++) {
    branchPromises.push(generateCandidate(userPrompt, systemPrompt, model, i + 1, mainWindow, cwd, runId))
  }
  const candidates = await Promise.all(branchPromises)

  broadcastAgentStream(mainWindow, { type: 'status', message: `[🌳 MCTS: simulazione reale (diagnostica di tipo applicata e ripristinata) di ogni ramo...]` }, runId)

  // La simulazione scrive transitoriamente sui percorsi reali del progetto:
  // DEVE girare in sequenza, mai in parallelo, altrimenti due rami che toccano
  // lo stesso file si sovrascriverebbero a vicenda durante la misurazione.
  const simulatedNodes: MctsNode[] = []
  for (const candidate of candidates) {
    const node = await simulateAndScore(candidate, cwd)
    simulatedNodes.push(node)
    broadcastAgentStream(mainWindow, { type: 'status', message: `[🌳 Ramo ${node.judgeId}: punteggio ${node.score.toFixed(0)}/100 — ${node.diagnosticsSummary.split('\n')[0]}]` }, runId)
  }

  simulatedNodes.sort((a, b) => b.score - a.score)
  const toRefine = simulatedNodes.filter(n => n.score < 100).slice(0, MCTS_REFINE_TOP_N)

  if (toRefine.length > 0) {
    broadcastAgentStream(mainWindow, { type: 'status', message: `[🌳 MCTS: raffinamento dei ${toRefine.length} rami più promettenti in base al feedback reale...]` }, runId)

    for (const node of toRefine) {
      const refined = await refineCandidate(node, userPrompt, systemPrompt, model)
      const refinedScored = await simulateAndScore(refined, cwd)
      refinedScored.refined = true
      broadcastAgentStream(mainWindow, { type: 'status', message: `[🌳 Ramo ${node.judgeId} raffinato: punteggio ${node.score.toFixed(0)} → ${refinedScored.score.toFixed(0)}]` }, runId)
      simulatedNodes.push(refinedScored)
    }
  }

  simulatedNodes.sort((a, b) => b.score - a.score)
  const bestNode = simulatedNodes[0]

  broadcastAgentStream(mainWindow, { type: 'status', message: `[🌳 MCTS: nodo vincente Ramo ${bestNode.judgeId}${bestNode.refined ? ' (raffinato)' : ''} con punteggio ${bestNode.score.toFixed(0)}/100. Applicazione in corso...]` }, runId)

  if (bestNode.tool_calls) {
    for (const toolCall of bestNode.tool_calls) {
      await executeBestTool(toolCall, cwd, mainWindow, runId)
    }
  }

  if (runId) {
    const fileCount = finalizeCheckpoint(cwd, runId)
    if (fileCount > 0) mainWindow.webContents.send('agent-checkpoint-ready', { runId, fileCount, taskSummary: userPrompt.slice(0, 100) })
  }

  broadcastAgentStream(mainWindow, { type: 'done', message: bestNode.content || 'Task completato con successo tramite Monte Carlo Tree Search.' }, runId)
}
