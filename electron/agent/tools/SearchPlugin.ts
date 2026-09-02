import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export const SearchToolDefinition = {
  type: "function",
  function: {
    name: "search_codebase",
    description: "Cerca una stringa, pattern o espressione regolare in tutto il progetto. Usa questa funzione invece di riempire il context con tutto il progetto.",
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
        }
      },
      required: ["query"]
    }
  }
}

export async function executeSearch(args: any, cwd: string): Promise<string> {
  try {
    const searchPath = args.path || '.'
    // Usa git grep o ripgrep (se non c'è rg usa grep standard)
    const command = `git grep -n "${args.query}" ${searchPath} || grep -rn "${args.query}" ${searchPath}`
    const { stdout } = await execAsync(command, { cwd, timeout: 10000 })
    
    if (!stdout.trim()) {
      return `Nessun risultato trovato per: ${args.query}`
    }

    // Limitiamo l'output per non saturare i token
    const lines = stdout.split('\n').filter(l => l.trim().length > 0)
    const limitedLines = lines.slice(0, 50)
    
    let result = limitedLines.join('\n')
    if (lines.length > 50) {
      result += `\n\n... (mostrati i primi 50 risultati su ${lines.length}. Sii più specifico)`
    }
    return result
  } catch (error: any) {
    // Il comando grep restituisce exit code 1 se non trova nulla
    if (error.code === 1) {
       return `Nessun risultato trovato per: ${args.query}`
    }
    return `❌ Errore durante la ricerca: ${error.message}`
  }
}
