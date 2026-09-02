import * as fs from 'fs'
import * as path from 'path'

export const ReadFileToolDefinition = {
  type: 'function' as const,
  function: {
    name: 'read_file',
    description: "Legge il contenuto REALE e completo di un file specifico del progetto. Usalo prima di 'edit_file' su un file già esistente, per sapere cosa c'è davvero dentro invece di indovinare — 'get_repo_map' dà solo le firme dei simboli, non il corpo del codice.",
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Percorso assoluto o relativo alla root del progetto del file da leggere.' }
      },
      required: ['filePath']
    }
  }
}

const MAX_CHARS = 15000

// I modelli locali più deboli sbagliano spesso il percorso esatto (maiuscole,
// slash mancante, cartella intermedia dimenticata) e, senza un modo di
// recuperare, si bloccano su un "file non trovato" secco o iniziano a
// inventare il contenuto. Se il file esatto non esiste, cerchiamo file dal
// nome simile nell'albero del progetto: se ce n'è uno solo, lo leggiamo
// direttamente (auto-correzione trasparente, dichiarata nel risultato); se ce
// ne sono più d'uno, diamo la lista invece di un vicolo cieco.
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-electron', 'build', '.code-ide-backups', 'release'])
const MAX_SIMILAR_RESULTS = 5

function findSimilarFiles(cwd: string, target: string): string[] {
  const targetBase = path.basename(target).toLowerCase()
  const matches: string[] = []

  function walk(dir: string) {
    if (matches.length >= MAX_SIMILAR_RESULTS * 4) return // basta per non scandire tutto un progetto enorme
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) walk(full)
      } else if (entry.name.toLowerCase() === targetBase || entry.name.toLowerCase().includes(targetBase)) {
        matches.push(path.relative(cwd, full))
      }
    }
  }

  walk(cwd)
  return matches.slice(0, MAX_SIMILAR_RESULTS)
}

function formatContent(displayPath: string, content: string, prefix = ''): string {
  if (content.length > MAX_CHARS) {
    return `${prefix}📄 ${displayPath} (troncato, ${content.length} caratteri totali):\n${content.slice(0, MAX_CHARS)}\n\n... (troncato: usa 'search_codebase' per cercare una sezione specifica invece di leggere tutto)`
  }
  return `${prefix}📄 ${displayPath}:\n${content}`
}

export async function executeReadFile(args: { filePath: string }, cwd: string): Promise<string> {
  try {
    const targetPath = path.isAbsolute(args.filePath) ? args.filePath : path.join(cwd, args.filePath)

    if (!fs.existsSync(targetPath)) {
      const similar = findSimilarFiles(cwd, args.filePath)

      if (similar.length === 1) {
        const correctedFull = path.join(cwd, similar[0])
        const content = fs.readFileSync(correctedFull, 'utf-8')
        return formatContent(similar[0], content, `⚠️ '${args.filePath}' non esisteva esattamente — letto invece '${similar[0]}' (unico file con nome simile trovato nel progetto).\n\n`)
      }
      if (similar.length > 1) {
        return `❌ File non trovato: ${args.filePath}. File con nome simile trovati nel progetto:\n${similar.map(s => `- ${s}`).join('\n')}\nRiprova con uno di questi percorsi esatti.`
      }
      return `❌ File non trovato: ${args.filePath}`
    }

    const content = fs.readFileSync(targetPath, 'utf-8')
    return formatContent(args.filePath, content)
  } catch (error: any) {
    return `❌ Errore lettura file: ${error.message}`
  }
}
