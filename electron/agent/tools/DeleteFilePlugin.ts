import * as fs from 'fs'
import { resolveTargetPath, backupFile } from './fileWriteUtils'

// Trovato un bug reale in produzione: l'agente non aveva alcun tool di
// cancellazione esplicito, quindi anche in Agent Mode con 'run_terminal_command'
// disponibile un modello poco incline a comporre i tool da solo rispondeva
// "Non ho tool di cancellazione. Usa il terminale: rm file.txt" invece di
// cancellarlo lui stesso — un'azione di scrittura di base mancante come
// capacità di primo livello, scoperta chiaramente elencata come le altre.
export const DeleteFileToolDefinition = {
  type: 'function' as const,
  function: {
    name: 'delete_file',
    description: "Elimina un file esistente dal progetto. Fa un backup automatico in '.code-ide-backups/' ed è coperto da checkpoint/rewind come edit_file/patch_file, quindi è annullabile con un click. Per cancellare intere cartelle o pattern multipli usa invece 'run_terminal_command' (es. rm -r).",
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Percorso assoluto o relativo al progetto del file da eliminare.' }
      },
      required: ['filePath']
    }
  }
}

export async function executeDeleteFile(args: { filePath: string }, cwd: string): Promise<string> {
  try {
    const targetPath = resolveTargetPath(cwd, args.filePath)

    if (!fs.existsSync(targetPath)) {
      return `❌ File non trovato: ${args.filePath} (niente da eliminare).`
    }
    if (fs.statSync(targetPath).isDirectory()) {
      return `❌ '${args.filePath}' è una cartella, non un file — 'delete_file' cancella solo singoli file. Usa 'run_terminal_command' con 'rm -r' per una cartella intera.`
    }

    const originalContent = fs.readFileSync(targetPath, 'utf-8')
    backupFile(cwd, args.filePath, originalContent)
    fs.unlinkSync(targetPath)

    return `🗑️ File eliminato: ${args.filePath} (backup salvato in .code-ide-backups/, annullabile con il checkpoint di questo run).`
  } catch (error: any) {
    return `❌ Errore durante l'eliminazione: ${error.message}`
  }
}
