import { app } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'

// Checkpoint/rewind: prima di ogni scrittura strutturata dell'agente (edit_file/
// patch_file) su un file MAI ancora toccato in questo run, ne salviamo il
// contenuto originale (o "non esisteva") — così l'intero task può essere
// annullato come UNITÀ ATOMICA con un click, invece di dover tornare indietro
// file per file a mano o affidarsi a un git diff manuale. Copre solo le scritture
// strutturate: run_terminal_command può modificare file in modi troppo vari
// (rm, mv, sed -i, redirect) per essere tracciato in modo affidabile senza una
// sandbox completa — limite dichiarato, non un bug nascosto.
function getCheckpointsDir(projectRoot: string): string {
  const projectHash = createHash('sha256').update(projectRoot).digest('hex').slice(0, 16)
  const dir = path.join(app.getPath('userData'), 'checkpoints', projectHash)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

interface FileSnapshot {
  filePath: string // relativo al progetto, così come passato dall'agente
  existedBefore: boolean
  originalContent: string | null
}

interface PendingCheckpoint {
  taskSummary: string
  files: Map<string, FileSnapshot> // keyed by filePath, primo tocco vince
}

interface StoredCheckpoint {
  runId: string
  projectRoot: string
  taskSummary: string
  files: FileSnapshot[]
  createdAt: number
}

export interface CheckpointSummary {
  runId: string
  taskSummary: string
  fileCount: number
  createdAt: number
}

const MAX_CHECKPOINTS_PER_PROJECT = 20

// In memoria per run attivo: evitiamo di leggere/scrivere su disco a ogni
// singolo file toccato durante un task, solo alla fine (finalizeCheckpoint).
const pendingByRunId = new Map<string, PendingCheckpoint>()

export function beginCheckpoint(runId: string, taskSummary: string): void {
  pendingByRunId.set(runId, { taskSummary, files: new Map() })
}

function resolvePath(cwd: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath)
}

export function snapshotFileIfNeeded(cwd: string, runId: string, filePath: string): void {
  const pending = pendingByRunId.get(runId)
  if (!pending) return // beginCheckpoint non chiamato (es. Plan Mode): niente da tracciare
  if (pending.files.has(filePath)) return // già catturato al primo tocco in questo run

  const absPath = resolvePath(cwd, filePath)
  const existedBefore = fs.existsSync(absPath)
  const originalContent = existedBefore ? fs.readFileSync(absPath, 'utf-8') : null
  pending.files.set(filePath, { filePath, existedBefore, originalContent })
}

function pruneOldCheckpoints(projectRoot: string): void {
  const dir = getCheckpointsDir(projectRoot)
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
  if (files.length <= MAX_CHECKPOINTS_PER_PROJECT) return

  const withTimes = files.map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
  withTimes.sort((a, b) => a.t - b.t)
  const toRemove = withTimes.slice(0, withTimes.length - MAX_CHECKPOINTS_PER_PROJECT)
  toRemove.forEach(({ f }) => fs.rmSync(path.join(dir, f), { force: true }))
}

/** Persiste il checkpoint SOLO se almeno un file è stato davvero toccato. Ritorna il numero di file coperti (0 = nessun checkpoint creato). */
export function finalizeCheckpoint(projectRoot: string, runId: string): number {
  const pending = pendingByRunId.get(runId)
  pendingByRunId.delete(runId)
  if (!pending || pending.files.size === 0) return 0

  const stored: StoredCheckpoint = {
    runId,
    projectRoot,
    taskSummary: pending.taskSummary,
    files: Array.from(pending.files.values()),
    createdAt: Date.now()
  }

  const filePath = path.join(getCheckpointsDir(projectRoot), `${runId.replace(/[^a-zA-Z0-9-]/g, '')}.json`)
  fs.writeFileSync(filePath, JSON.stringify(stored, null, 2), 'utf-8')
  pruneOldCheckpoints(projectRoot)
  return stored.files.length
}

export function listCheckpoints(projectRoot: string): CheckpointSummary[] {
  const dir = getCheckpointsDir(projectRoot)
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
  const summaries: CheckpointSummary[] = []

  for (const file of files) {
    try {
      const data: StoredCheckpoint = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'))
      summaries.push({ runId: data.runId, taskSummary: data.taskSummary, fileCount: data.files.length, createdAt: data.createdAt })
    } catch {
      // File corrotto: ignoralo
    }
  }

  return summaries.sort((a, b) => b.createdAt - a.createdAt)
}

/** Ripristina tutti i file del checkpoint al loro stato pre-task e lo elimina (revert una tantum, non ri-applicabile). */
export function revertCheckpoint(projectRoot: string, runId: string): { restoredFiles: string[] } {
  const filePath = path.join(getCheckpointsDir(projectRoot), `${runId.replace(/[^a-zA-Z0-9-]/g, '')}.json`)
  if (!fs.existsSync(filePath)) {
    throw new Error('Checkpoint non trovato (forse già annullato in precedenza).')
  }

  const data: StoredCheckpoint = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  const restoredFiles: string[] = []

  for (const snap of data.files) {
    const absPath = resolvePath(projectRoot, snap.filePath)
    if (snap.existedBefore) {
      fs.mkdirSync(path.dirname(absPath), { recursive: true })
      fs.writeFileSync(absPath, snap.originalContent as string, 'utf-8')
    } else {
      fs.rmSync(absPath, { force: true })
    }
    restoredFiles.push(snap.filePath)
  }

  fs.rmSync(filePath, { force: true })
  return { restoredFiles }
}
