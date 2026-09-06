import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'

// N-03 dell'audit: ricerca ibrida (semantica + grep, non l'una al posto
// dell'altra — search_codebase resta il default per stringhe/regex esatte).
// Interamente locale, nessuna dipendenza nuova pesante: 'nomic-embed-text'
// è già installabile via Ollama (già un requisito del progetto), il TS
// Compiler API per i confini dei chunk è già usato da get_diagnostics/
// get_repo_map, better-sqlite3 è già una dipendenza (usata da memory.ts,
// stesso pattern createRequire riusato qui). Nessun servizio esterno,
// nessun codice che lascia la macchina — a differenza dell'indice
// vettoriale di Cursor (Turbopuffer, sul loro server), che risolve lo
// stesso problema ma rompe la promessa locale-first di questo progetto.
const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
const ts = require('typescript') as typeof import('typescript')

const SEMANTIC_DB_PATH = path.join(process.env.HOME || process.env.USERPROFILE || '', '.code-ide-semantic-index.db')
const EMBEDDING_MODEL = 'nomic-embed-text'
const OLLAMA_EMBEDDINGS_URL = 'http://localhost:11434/api/embeddings'

const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-electron', 'build', '.code-ide-backups', 'release', 'coverage', '.next', '.venv', '__pycache__'])
const INDEXABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.md', '.css', '.html'])
const AST_CHUNK_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx'])

// File enormi (bundle generati, dati) farebbero esplodere il tempo di
// indicizzazione in embedding-per-chunk — oltre questa soglia si salta il
// file invece di bloccare l'indicizzazione dell'intero progetto per uno solo.
const MAX_FILE_SIZE_BYTES = 512 * 1024

let db: InstanceType<typeof Database> | null = null

function getDB() {
  if (db) return db
  db = new Database(SEMANTIC_DB_PATH)
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding BLOB NOT NULL,
      file_mtime INTEGER NOT NULL,
      content_hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_project_file ON chunks(project_path, file_path);
  `)
  return db
}

export interface CodeChunk {
  startLine: number // 1-indicizzata, inclusiva
  endLine: number
  text: string
}

// Confini dei chunk via AST invece di finestre di righe fisse per TS/JS: una
// funzione/classe/interfaccia intera è un'unità semantica molto più sensata
// da confrontare con una query in linguaggio naturale di un blocco arbitrario
// di N righe che potrebbe tagliarla a metà. Fallback a finestre scorrevoli
// quando l'AST non produce nulla di utile (file con solo import/export, o
// tutto dentro un'unica funzione enorme) o per estensioni non-TS/JS.
function chunkWithAst(content: string, filePath: string): CodeChunk[] {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true)
  const chunks: CodeChunk[] = []

  const isChunkableNode = (node: ts.Node): boolean =>
    ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) ||
    (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))))

  sourceFile.forEachChild(node => {
    if (!isChunkableNode(node)) return
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1
    const text = content.split('\n').slice(start - 1, end).join('\n')
    if (text.trim().length > 0) chunks.push({ startLine: start, endLine: end, text })
  })

  return chunks
}

const WINDOW_LINES = 60
const WINDOW_OVERLAP = 15

function chunkBySlidingWindow(content: string): CodeChunk[] {
  const lines = content.split('\n')
  if (lines.length === 0) return []
  const chunks: CodeChunk[] = []
  let start = 0
  while (start < lines.length) {
    const end = Math.min(start + WINDOW_LINES, lines.length)
    const text = lines.slice(start, end).join('\n')
    if (text.trim().length > 0) chunks.push({ startLine: start + 1, endLine: end, text })
    if (end >= lines.length) break
    start += WINDOW_LINES - WINDOW_OVERLAP
  }
  return chunks
}

export function chunkFile(filePath: string, content: string): CodeChunk[] {
  const ext = path.extname(filePath)
  if (AST_CHUNK_EXTENSIONS.has(ext)) {
    try {
      const astChunks = chunkWithAst(content, filePath)
      // Meno di 2 chunk (import/export soltanto, o un parse fallito che
      // produce comunque un SourceFile "vuoto" senza eccezioni) non vale la
      // AST — meglio le finestre scorrevoli che coprono comunque il file.
      if (astChunks.length >= 2) return astChunks
    } catch {
      // Parse fallito (sintassi non standard, file troncato, ecc.): fallback sotto
    }
  }
  return chunkBySlidingWindow(content)
}

export async function getEmbedding(text: string): Promise<Float32Array> {
  const res = await fetch(OLLAMA_EMBEDDINGS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // nomic-embed-text tronca oltre una certa lunghezza comunque — limitare
    // qui evita di mandare un intero file enorme come un solo embedding
    // indistinto quando il chunking sopra ha comunque fallito nel dividerlo.
    body: JSON.stringify({ model: EMBEDDING_MODEL, prompt: text.slice(0, 8000) })
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Ollama non ha generato l'embedding (${res.status}): ${errText.slice(0, 200)} — verifica che 'ollama pull ${EMBEDDING_MODEL}' sia stato eseguito.`)
  }
  const data = await res.json()
  if (!Array.isArray(data.embedding)) {
    throw new Error(`Risposta embedding inattesa da Ollama: ${JSON.stringify(data).slice(0, 200)}`)
  }
  return new Float32Array(data.embedding)
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

function walkProjectFiles(root: string): { filePath: string, mtimeMs: number }[] {
  const results: { filePath: string, mtimeMs: number }[] = []
  function walk(dir: string) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.code-ide') continue
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) walk(fullPath)
      } else if (INDEXABLE_EXTENSIONS.has(path.extname(entry.name))) {
        try {
          const stat = fs.statSync(fullPath)
          if (stat.size <= MAX_FILE_SIZE_BYTES) results.push({ filePath: fullPath, mtimeMs: stat.mtimeMs })
        } catch {
          // file sparito tra readdir e stat: raro, ignoralo
        }
      }
    }
  }
  walk(root)
  return results
}

function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex')
}

export interface IndexUpdateResult {
  filesIndexed: number
  filesSkippedUnchanged: number
  filesRemoved: number
  totalChunks: number
}

/**
 * Porta l'indice semantico di un progetto allo stato attuale del disco:
 * re-indicizza solo i file nuovi o modificati (per mtime, poi confermato per
 * hash — evita di ri-embeddare un file il cui mtime è cambiato ma il
 * contenuto no, es. dopo un git checkout), e rimuove i file non più presenti.
 * Chiamata automaticamente da semanticSearch: niente job in background da
 * gestire, il costo dell'aggiornamento lo paga solo la prima ricerca dopo una modifica.
 */
export async function ensureIndexUpToDate(projectRoot: string): Promise<IndexUpdateResult> {
  const database = getDB()
  const onDisk = walkProjectFiles(projectRoot)
  const onDiskPaths = new Set(onDisk.map(f => f.filePath))

  const indexedRows = database.prepare(
    `SELECT DISTINCT file_path, file_mtime, content_hash FROM chunks WHERE project_path = ?`
  ).all(projectRoot) as { file_path: string, file_mtime: number, content_hash: string }[]
  const indexedByPath = new Map(indexedRows.map(r => [r.file_path, r]))

  const deleteChunksForFile = database.prepare(`DELETE FROM chunks WHERE project_path = ? AND file_path = ?`)
  const insertChunk = database.prepare(`
    INSERT INTO chunks (project_path, file_path, start_line, end_line, content, embedding, file_mtime, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)

  let filesIndexed = 0
  let filesSkippedUnchanged = 0

  for (const file of onDisk) {
    const existing = indexedByPath.get(file.filePath)
    if (existing && existing.file_mtime === file.mtimeMs) {
      filesSkippedUnchanged++
      continue
    }

    let content: string
    try {
      content = fs.readFileSync(file.filePath, 'utf-8')
    } catch {
      continue // binario mascherato da estensione testuale, o permessi: salta invece di far fallire tutto l'indice
    }
    const hash = hashContent(content)
    if (existing && existing.content_hash === hash) {
      // mtime cambiato (es. checkout, touch) ma contenuto identico: aggiorna
      // solo il mtime registrato, senza ri-pagare gli embedding.
      database.prepare(`UPDATE chunks SET file_mtime = ? WHERE project_path = ? AND file_path = ?`).run(file.mtimeMs, projectRoot, file.filePath)
      filesSkippedUnchanged++
      continue
    }

    const chunks = chunkFile(file.filePath, content)
    if (chunks.length === 0) continue

    deleteChunksForFile.run(projectRoot, file.filePath)
    for (const chunk of chunks) {
      const embedding = await getEmbedding(chunk.text)
      insertChunk.run(projectRoot, file.filePath, chunk.startLine, chunk.endLine, chunk.text, Buffer.from(embedding.buffer), file.mtimeMs, hash)
    }
    filesIndexed++
  }

  let filesRemoved = 0
  for (const row of indexedRows) {
    if (!onDiskPaths.has(row.file_path)) {
      deleteChunksForFile.run(projectRoot, row.file_path)
      filesRemoved++
    }
  }

  const totalChunks = (database.prepare(`SELECT COUNT(*) as c FROM chunks WHERE project_path = ?`).get(projectRoot) as { c: number }).c
  return { filesIndexed, filesSkippedUnchanged, filesRemoved, totalChunks }
}

export interface SemanticSearchResult {
  filePath: string
  startLine: number
  endLine: number
  text: string
  score: number
}

export async function semanticSearch(projectRoot: string, query: string, topK = 8): Promise<{ results: SemanticSearchResult[], indexStats: IndexUpdateResult }> {
  const indexStats = await ensureIndexUpToDate(projectRoot)
  const database = getDB()
  const rows = database.prepare(
    `SELECT file_path, start_line, end_line, content, embedding FROM chunks WHERE project_path = ?`
  ).all(projectRoot) as { file_path: string, start_line: number, end_line: number, content: string, embedding: Buffer }[]

  if (rows.length === 0) {
    return { results: [], indexStats }
  }

  const queryEmbedding = await getEmbedding(query)
  const scored = rows.map(row => {
    const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4)
    return {
      filePath: row.file_path,
      startLine: row.start_line,
      endLine: row.end_line,
      text: row.content,
      score: cosineSimilarity(queryEmbedding, vec)
    }
  })

  scored.sort((a, b) => b.score - a.score)
  return { results: scored.slice(0, topK), indexStats }
}
