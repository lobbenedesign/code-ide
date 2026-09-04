import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export const GitToolDefinition = {
  type: "function",
  function: {
    name: "manage_git",
    description: "Esegue operazioni Git LOCALI di sola lettura o commit sul repository: 'status', 'diff', 'commit'. NON supporta push/pull/branch/log — per pubblicare su GitHub (creare repo remota + push) usa lo strumento 'publish_to_github' separato.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "diff", "commit"],
          description: "L'operazione Git da eseguire (solo status/diff/commit — nessuna operazione remota)."
        },
        commit_message: {
          type: "string",
          description: "Obbligatorio solo se action è 'commit'. Il messaggio del commit."
        }
      },
      required: ["action"]
    }
  }
}

export async function executeGit(args: any, cwd: string): Promise<string> {
  try {
    if (args.action === 'status') {
      const { stdout } = await execFileAsync('git', ['status', '-s'], { cwd })
      return stdout || "Nessun file modificato (working tree clean)."
    } else if (args.action === 'diff') {
      const { stdout } = await execFileAsync('git', ['diff'], { cwd, maxBuffer: 10 * 1024 * 1024 })
      return stdout.substring(0, 5000) || "Nessuna differenza non stagiata."
    } else if (args.action === 'commit') {
      if (!args.commit_message) {
        return "❌ Errore: commit_message mancante."
      }
      await execFileAsync('git', ['add', '.'], { cwd })
      // D-01 dell'audit: execFile con argomenti come array, non più una
      // stringa di comando con la shell — il messaggio (testo dell'LLM,
      // potenzialmente prompt-injected) arriva come UN argv, non come testo
      // che sh possa reinterpretare (niente $(...) o backtick da espandere).
      const { stdout } = await execFileAsync('git', ['commit', '-m', args.commit_message], { cwd })
      return `✅ Commit creato:\n${stdout}`
    }
    
    return `❌ Azione Git non supportata: ${args.action}`
  } catch (error: any) {
    return `❌ Errore Git: ${error.message}\nStderr:\n${error.stderr}`
  }
}
