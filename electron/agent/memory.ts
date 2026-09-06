import * as path from 'path'
import { createRequire } from 'node:module'

// better-sqlite3 usa __dirname internamente (per localizzare il suo binario
// nativo .node precompilato) — un global CJS che non esiste nello scope ESM
// del main process. Un import statico crashava con "ReferenceError: __dirname
// is not defined" alla PRIMA chiamata reale dell'harness (getProjectMemories,
// eseguito a ogni singolo task Agent Mode) — trovato con un vero test dal
// vivo dell'app, non dalla sola lettura del codice: l'Agent Mode restava
// bloccato per sempre su "Avvio..." senza alcun errore visibile, perché
// l'eccezione veniva solo loggata in console dal main process (vedi il fix
// gemello in main.ts per notificare comunque il renderer). Stesso pattern già
// usato per node-pty/typescript: caricamento a runtime via createRequire
// invece che import statico, per bypassare il bundling.
const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

const MEMORY_DB_PATH = path.join(process.env.HOME || process.env.USERPROFILE || '', '.code-ide-memory.db')

let db: Database.Database | null = null

export function initMemoryDB() {
  if (db) return db
  
  db = new Database(MEMORY_DB_PATH)
  
  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project_path, key)
    )
  `)
  
  return db
}

export function saveMemory(projectPath: string, key: string, value: string) {
  const database = initMemoryDB()
  const stmt = database.prepare(`
    INSERT INTO memories (project_path, key, value) 
    VALUES (?, ?, ?) 
    ON CONFLICT(project_path, key) DO UPDATE SET value = excluded.value
  `)
  stmt.run(projectPath, key, value)
}

export function getProjectMemories(projectPath: string): { key: string, value: string }[] {
  const database = initMemoryDB()
  const stmt = database.prepare(`SELECT key, value FROM memories WHERE project_path = ?`)
  return stmt.all(projectPath) as { key: string, value: string }[]
}

// Prima non esisteva alcun modo, per l'agente o per l'utente, di rimuovere
// una memoria dopo averla salvata — solo save_memory, mai un dual "dimentica
// questo". Una regola che smette di valere (uno stack cambiato, una
// preferenza superata) restava iniettata per sempre in ogni prompt futuro,
// senza che nessuno potesse correggerla se non cancellando a mano il file
// .code-ide-memory.db intero (perdendo TUTTE le memorie di TUTTI i progetti).
export function deleteMemory(projectPath: string, key: string): boolean {
  const database = initMemoryDB()
  const stmt = database.prepare(`DELETE FROM memories WHERE project_path = ? AND key = ?`)
  const result = stmt.run(projectPath, key)
  return result.changes > 0
}
