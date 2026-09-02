import * as fs from 'fs'
import * as path from 'path'
import { summarizeDiff, backupFile, resolveTargetPath } from './fileWriteUtils'

export const FileEditorToolDefinition = {
  type: "function",
  function: {
    name: "edit_file",
    description: "Crea un file nuovo, oppure RISCRIVE INTERAMENTE un file esistente. Per modificare una porzione di un file GIÀ ESISTENTE (specialmente se grande, centinaia/migliaia di righe) usa 'patch_file' invece: è molto più affidabile perché non richiede di riscrivere le parti non toccate.",
    parameters: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "Il percorso assoluto o relativo al progetto del file da modificare."
        },
        content: {
          type: "string",
          description: "L'intero contenuto del file da scrivere."
        }
      },
      required: ["filePath", "content"]
    }
  }
}

export async function executeFileEditor(args: any, cwd: string): Promise<string> {
  try {
    const targetPath = resolveTargetPath(cwd, args.filePath)

    // Crea le cartelle genitori se non esistono
    const dir = path.dirname(targetPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    let diffSummary = ''
    if (fs.existsSync(targetPath)) {
      const oldContent = fs.readFileSync(targetPath, 'utf-8')
      diffSummary = summarizeDiff(oldContent, args.content)

      // Backup automatico prima di sovrascrivere: l'harness scrive file in piena
      // autonomia (anche innescato da bot remoti senza conferma umana), quindi
      // serve un modo per tornare indietro se una modifica risulta sbagliata.
      backupFile(cwd, args.filePath, oldContent)
    }

    fs.writeFileSync(targetPath, args.content, 'utf-8')

    const diffNote = diffSummary ? ` (${diffSummary}, backup del precedente contenuto salvato)` : ' (nuovo file)'
    return `✅ File ${args.filePath} salvato con successo${diffNote}.`
  } catch (error: any) {
    return `❌ Errore durante il salvataggio del file: ${error.message}`
  }
}
