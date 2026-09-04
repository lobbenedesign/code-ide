import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

// D-01 dell'audit: la versione precedente interpolava args.query (testo
// dell'LLM, quindi potenzialmente prompt-injected da un file letto
// dall'agente) dentro una stringa passata a exec() con una shell vera.
// Un escaping delle virgolette non basta — dentro doppi apici sh espande
// comunque $(...) e i backtick, verificato eseguendolo davvero:
//   echo "x $(whoami)"  ->  stampa l'utente reale, non la stringa letterale.
// execFile() con argomenti come ARRAY non passa mai per una shell: la query
// arriva al processo figlio come argv, non come testo da (ri)interpretare.
export const SearchToolDefinition = {
  type: "function",
  function: {
    name: "search_codebase",
    description: "Cerca una stringa, pattern o espressione regolare in tutto il progetto (ripgrep se disponibile, altrimenti git grep, altrimenti grep). Usa questa funzione invece di riempire il context con tutto il progetto.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "La stringa o regex da cercare."
        },
        path: {
          type: "string",
          description: "La cartella specifica in cui cercare (opzionale, default: '.'). Usa '.' per cercare in tutto il progetto."
        },
        caseInsensitive: {
          type: "boolean",
          description: "true per ignorare maiuscole/minuscole (opzionale, default: false)."
        },
        contextLines: {
          type: "number",
          description: "Righe di contesto da mostrare sopra e sotto ogni match (opzionale, default: 0, max: 5)."
        },
        filePattern: {
          type: "string",
          description: "Glob per limitare la ricerca a certi file, es. '*.ts' o '*.{ts,tsx}' (opzionale, solo con ripgrep — ignorato nei fallback)."
        }
      },
      required: ["query"]
    }
  }
}

const MAX_LINES = 50
const MAX_BUFFER = 10 * 1024 * 1024

function formatResult(stdout: string, query: string): string {
  const lines = stdout.split('\n').filter(l => l.trim().length > 0)
  if (lines.length === 0) return `Nessun risultato trovato per: ${query}`
  const limited = lines.slice(0, MAX_LINES)
  let result = limited.join('\n')
  if (lines.length > MAX_LINES) {
    result += `\n\n... (mostrati i primi ${MAX_LINES} risultati su ${lines.length}. Sii più specifico)`
  }
  return result
}

export async function executeSearch(args: any, cwd: string): Promise<string> {
  const searchPath = args.path || '.'
  const contextLines = Math.max(0, Math.min(5, Number(args.contextLines) || 0))
  const query: string = args.query

  // 1) ripgrep — rispetta .gitignore da solo, il più veloce, supporta glob e contesto nativamente.
  try {
    const rgArgs = ['-n', '--no-heading', '--color=never']
    if (args.caseInsensitive) rgArgs.push('-i')
    if (contextLines > 0) rgArgs.push('-C', String(contextLines))
    if (args.filePattern) rgArgs.push('-g', args.filePattern)
    rgArgs.push('--', query, searchPath)
    const { stdout } = await execFileAsync('rg', rgArgs, { cwd, timeout: 10000, maxBuffer: MAX_BUFFER })
    return formatResult(stdout, query)
  } catch (rgError: any) {
    if (rgError.code === 1) return `Nessun risultato trovato per: ${query}` // rg: ricerca riuscita, zero match
    // rg non installato o altro errore reale (regex invalida per rg, ecc.): prova il prossimo livello
  }

  // 2) git grep — funziona solo dentro un repo git, ma è già la scelta storica del progetto.
  try {
    const gitArgs = ['grep', '-n']
    if (args.caseInsensitive) gitArgs.push('-i')
    if (contextLines > 0) gitArgs.push('-C', String(contextLines))
    gitArgs.push('-e', query, '--', searchPath)
    const { stdout } = await execFileAsync('git', gitArgs, { cwd, timeout: 10000, maxBuffer: MAX_BUFFER })
    return formatResult(stdout, query)
  } catch (gitError: any) {
    if (gitError.code === 1) return `Nessun risultato trovato per: ${query}`
    // non un repo git, o git non disponibile: prova l'ultimo livello
  }

  // 3) grep semplice — ultima spiaggia, sempre presente su macOS/Linux.
  try {
    const grepArgs = ['-rn']
    if (args.caseInsensitive) grepArgs.push('-i')
    if (contextLines > 0) grepArgs.push('-C', String(contextLines))
    grepArgs.push('-e', query, searchPath)
    const { stdout } = await execFileAsync('grep', grepArgs, { cwd, timeout: 10000, maxBuffer: MAX_BUFFER })
    return formatResult(stdout, query)
  } catch (error: any) {
    if (error.code === 1) return `Nessun risultato trovato per: ${query}`
    return `❌ Errore durante la ricerca: ${error.message}`
  }
}
