import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// semanticIndex.ts calcola SEMANTIC_DB_PATH da process.env.HOME come COSTANTE
// DI MODULO (stesso pattern di memory.ts): va impostato PRIMA dell'import e il
// modulo va ricaricato (vi.resetModules) per ogni test, altrimenti tutti i
// test condividerebbero lo stesso ~/.code-ide-semantic-index.db reale.
//
// I test di ensureIndexUpToDate/semanticSearch chiamano Ollama per davvero
// (http://localhost:11434, modello nomic-embed-text) invece di mockare
// l'embedding: coerente con la regola di questa sessione di non dichiarare
// funzionante una feature senza verifica reale. Se Ollama non è in esecuzione
// o il modello non è installato, questi test vengono saltati (non falliti)
// per non rompere `npm test` su una macchina senza Ollama.
async function isOllamaEmbeddingReady(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:11434/api/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nomic-embed-text', prompt: 'ping' })
    })
    if (!res.ok) return false
    const data = await res.json()
    return Array.isArray(data.embedding)
  } catch {
    return false
  }
}

describe('semanticIndex: chunkFile (nessuna dipendenza da Ollama)', () => {
  let semanticIndexModule: typeof import('../electron/services/semanticIndex')

  beforeEach(async () => {
    vi.resetModules()
    semanticIndexModule = await import('../electron/services/semanticIndex')
  })

  it('divide un file TS con due funzioni top-level in due chunk AST distinti', () => {
    const { chunkFile } = semanticIndexModule
    const content = [
      'export function calculateTotal(items: number[]): number {',
      '  return items.reduce((a, b) => a + b, 0)',
      '}',
      '',
      'export function calculateAverage(items: number[]): number {',
      '  return calculateTotal(items) / items.length',
      '}',
      ''
    ].join('\n')

    const chunks = chunkFile('math.ts', content)

    expect(chunks.length).toBe(2)
    expect(chunks[0].text).toContain('calculateTotal')
    expect(chunks[1].text).toContain('calculateAverage')
    expect(chunks[0].startLine).toBe(1)
    expect(chunks[1].startLine).toBe(5)
  })

  it('usa il fallback a finestre scorrevoli per un file senza dichiarazioni chunkabili (solo import/export)', () => {
    const { chunkFile } = semanticIndexModule
    const content = "export { foo } from './bar'\n".repeat(3)
    const chunks = chunkFile('reexport.ts', content)
    // Meno di 2 nodi chunkabili → fallback: deve comunque produrre almeno un chunk che copre il file
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0].startLine).toBe(1)
  })

  it('usa la finestra scorrevole per estensioni non TS/JS (es. .py)', () => {
    const { chunkFile } = semanticIndexModule
    const content = 'def foo():\n    pass\n'
    const chunks = chunkFile('script.py', content)
    expect(chunks.length).toBe(1)
    expect(chunks[0].text).toContain('def foo')
  })
})

describe('semanticIndex: indicizzazione e ricerca reale (richiede Ollama + nomic-embed-text)', () => {
  let tmpHome: string
  let projectRoot: string
  let semanticIndexModule: typeof import('../electron/services/semanticIndex')
  let ollamaReady = false

  beforeEach(async () => {
    ollamaReady = await isOllamaEmbeddingReady()

    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'code-ide-semantic-test-'))
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-ide-semantic-project-'))
    fs.mkdirSync(path.join(projectRoot, 'src'))
    fs.writeFileSync(
      path.join(projectRoot, 'src', 'math.ts'),
      'export function calculateTotal(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0)\n}\n\nexport function calculateAverage(items: number[]): number {\n  return calculateTotal(items) / items.length\n}\n'
    )
    fs.writeFileSync(
      path.join(projectRoot, 'src', 'terminal.ts'),
      'export class TerminalManager {\n  spawnShell() {\n    // avvia un nuovo processo di shell interattivo\n  }\n\n  handleDisconnect() {\n    // chiude il processo shell e libera le risorse del terminale\n  }\n}\n'
    )

    vi.resetModules()
    vi.stubEnv('HOME', tmpHome)
    semanticIndexModule = await import('../electron/services/semanticIndex')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    fs.rmSync(tmpHome, { recursive: true, force: true })
    fs.rmSync(projectRoot, { recursive: true, force: true })
  })

  it('indicizza i file del progetto ed espone risultati di ricerca semantica ordinati per pertinenza', async () => {
    if (!ollamaReady) {
      console.warn('Ollama/nomic-embed-text non disponibile: test saltato.')
      return
    }
    const { semanticSearch } = semanticIndexModule

    const { results, indexStats } = await semanticSearch(projectRoot, 'come chiudere il processo shell del terminale', 3)

    expect(indexStats.filesIndexed).toBe(2)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].filePath).toContain('terminal.ts')
  })

  it('la seconda ricerca sullo stesso progetto non ri-indicizza nulla (cache per mtime/hash)', async () => {
    if (!ollamaReady) {
      console.warn('Ollama/nomic-embed-text non disponibile: test saltato.')
      return
    }
    const { semanticSearch } = semanticIndexModule

    await semanticSearch(projectRoot, 'qualsiasi query', 1)
    const { indexStats } = await semanticSearch(projectRoot, 'qualsiasi altra query', 1)

    expect(indexStats.filesIndexed).toBe(0)
    expect(indexStats.filesSkippedUnchanged).toBe(2)
  })

  it('rimuove dall\'indice i chunk di un file cancellato dal disco', async () => {
    if (!ollamaReady) {
      console.warn('Ollama/nomic-embed-text non disponibile: test saltato.')
      return
    }
    const { semanticSearch } = semanticIndexModule

    await semanticSearch(projectRoot, 'prima indicizzazione', 1)
    fs.rmSync(path.join(projectRoot, 'src', 'terminal.ts'))
    const { indexStats } = await semanticSearch(projectRoot, 'seconda indicizzazione dopo cancellazione', 1)

    expect(indexStats.filesRemoved).toBe(1)
  })
})
