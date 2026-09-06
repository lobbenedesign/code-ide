import { BrowserWindow } from 'electron'

// N-05 dell'audit: run paralleli dell'agente. L'harness (harness.ts) e il
// canale di streaming (outputBuffer.ts) erano già pensati per la concorrenza
// fin dall'inizio — ogni evento porta un runId di correlazione proprio per
// non mischiare due run diversi (desktop + bot Telegram, per esempio) — ma
// non esisteva alcun REGISTRO che tenesse traccia di quali run fossero
// attivi in un dato momento: ogni runId veniva generato, usato per instradare
// gli eventi, e poi dimenticato. Senza un registro non è possibile mostrare
// all'utente "hai 3 task in esecuzione in background" né lanciarne un
// secondo mentre il primo è ancora attivo con un minimo di visibilità su
// entrambi. Questo modulo aggiunge esattamente quel registro, in memoria,
// scope all'intero processo main (non per-finestra: un solo BrowserWindow
// in questa app).

export type RunStatus = 'running' | 'done' | 'error'

export interface RunInfo {
  id: string
  title: string
  cwd: string
  model: string
  status: RunStatus
  startedAt: number
  endedAt?: number
  lastMessage: string
}

const runs = new Map<string, RunInfo>()
let notifyWindow: BrowserWindow | null = null

// Evita crescita illimitata in una sessione lunga con molti task lanciati:
// tiene solo gli ultimi N run CONCLUSI (done/error) più tutti quelli ancora
// in esecuzione, che non vengono mai rimossi da qui.
const MAX_FINISHED_RUNS = 50

export function setRunRegistryWindow(win: BrowserWindow | null) {
  notifyWindow = win
}

function broadcast(run: RunInfo) {
  notifyWindow?.webContents.send('agent-run-registry-update', run)
}

export function registerRun(id: string, info: { title: string, cwd: string, model: string }): void {
  const run: RunInfo = {
    id,
    title: info.title,
    cwd: info.cwd,
    model: info.model,
    status: 'running',
    startedAt: Date.now(),
    lastMessage: ''
  }
  runs.set(id, run)
  broadcast(run)
  pruneFinishedRuns()
}

/**
 * Chiamata dal chokepoint condiviso broadcastAgentStream (outputBuffer.ts) per
 * ogni evento 'agent-stream' che porta un runId — così ogni punto
 * dell'harness/deepReasoning che già emette eventi aggiorna il registro
 * gratis, senza dover toccare uno per uno i chiamanti.
 */
export function updateRunFromStreamEvent(id: string, type: string, message: string): void {
  const run = runs.get(id)
  if (!run) return // run non registrato qui (es. runId generato altrove prima di questa feature): ignora senza crash
  run.lastMessage = message
  if (type === 'done' || type === 'plan') run.status = 'done'
  else if (type === 'error') run.status = 'error'
  if (run.status !== 'running' && run.endedAt === undefined) run.endedAt = Date.now()
  broadcast(run)
}

export function listRuns(): RunInfo[] {
  return Array.from(runs.values()).sort((a, b) => b.startedAt - a.startedAt)
}

export function pruneFinishedRuns(): void {
  const finished = listRuns().filter(r => r.status !== 'running')
  if (finished.length <= MAX_FINISHED_RUNS) return
  for (const r of finished.slice(MAX_FINISHED_RUNS)) runs.delete(r.id)
}
