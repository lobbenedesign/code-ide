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

// delete_folder è irreversibile su disco quanto delete_file, ma tocca N file
// invece di uno: prima di eliminare la cartella camminiamo l'intero albero e
// catturiamo OGNI file al suo path relativo, riusando esattamente lo stesso
// meccanismo di snapshot/revert di edit_file — nessuna nuova infrastruttura,
// solo N chiamate a snapshotFileIfNeeded invece di una.
export function snapshotFolderIfNeeded(cwd: string, runId: string, folderPath: string): void {
  const pending = pendingByRunId.get(runId)
  if (!pending) return

  const absFolder = resolvePath(cwd, folderPath)
  if (!fs.existsSync(absFolder) || !fs.statSync(absFolder).isDirectory()) return

  const walk = (absDir: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const absEntryPath = path.join(absDir, entry.name)
      if (entry.isDirectory()) {
        walk(absEntryPath)
      } else if (entry.isFile()) {
        // Lo store salva solo testo UTF-8: un binario (immagine, font, ...)
        // "ripristinato" da bytes letti come UTF-8 sarebbe corrotto, il che è
        // peggio che non coprirlo affatto. Rileviamo un binario con
        // l'euristica standard (byte nullo nei primi 8KB) e lo saltiamo: verrà
        // comunque eliminato, solo non sarà ricostruibile con "Annulla task".
        try {
          const fd = fs.openSync(absEntryPath, 'r')
          const buf = Buffer.alloc(8192)
          const bytesRead = fs.readSync(fd, buf, 0, 8192, 0)
          fs.closeSync(fd)
          if (buf.subarray(0, bytesRead).includes(0)) continue
        } catch {
          continue
        }
        const relPath = path.relative(cwd, absEntryPath)
        snapshotFileIfNeeded(cwd, runId, relPath)
      }
    }
  }
  walk(absFolder)
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
