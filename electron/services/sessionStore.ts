import { app } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'

// Le sessioni vivono in userData (non nella cartella del progetto): sono dati
// personali della conversazione dell'utente, non qualcosa da versionare col
// codice come .code-ide/hooks.json — evita anche di finire per sbaglio in un
// commit/push (vedi il blocco file-sensibili in GitHubPlugin.ts).
function getSessionsDir(projectRoot: string): string {
  const projectHash = createHash('sha256').update(projectRoot).digest('hex').slice(0, 16)
  const dir = path.join(app.getPath('userData'), 'sessions', projectHash)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export interface StoredMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  images?: string[]
  isPlan?: boolean
  planApproved?: boolean
}

export interface SessionData {
  id: string
  projectRoot: string
  title: string
  model: string
  messages: StoredMessage[]
  createdAt: number
  updatedAt: number
}

export interface SessionSummary {
  id: string
  title: string
  model: string
  messageCount: number
  updatedAt: number
}

function sessionFilePath(projectRoot: string, sessionId: string): string {
  // sessionId è generato da noi (randomUUID lato renderer/main), mai da input
  // utente diretto — comunque igienizzato per sicurezza contro path traversal.
  const safeId = sessionId.replace(/[^a-zA-Z0-9-]/g, '')
  return path.join(getSessionsDir(projectRoot), `${safeId}.json`)
}

export function saveSession(data: SessionData): void {
  data.updatedAt = Date.now()
  fs.writeFileSync(sessionFilePath(data.projectRoot, data.id), JSON.stringify(data, null, 2), 'utf-8')
}

export function loadSession(projectRoot: string, sessionId: string): SessionData | null {
  const filePath = sessionFilePath(projectRoot, sessionId)
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

export function listSessions(projectRoot: string): SessionSummary[] {
  const dir = getSessionsDir(projectRoot)
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
  const summaries: SessionSummary[] = []

  for (const file of files) {
    try {
      const data: SessionData = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'))
      summaries.push({
        id: data.id,
        title: data.title,
        model: data.model,
        messageCount: data.messages.length,
        updatedAt: data.updatedAt
      })
    } catch {
      // File corrotto/parziale: ignoralo invece di far fallire l'intera lista
    }
  }

  return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function deleteSession(projectRoot: string, sessionId: string): void {
  const filePath = sessionFilePath(projectRoot, sessionId)
  fs.rmSync(filePath, { force: true })
}
