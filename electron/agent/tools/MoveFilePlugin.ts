import * as fs from 'fs'
import * as path from 'path'
import { resolveTargetPath } from './fileWriteUtils'

export const MoveFileToolDefinition = {
  type: 'function' as const,
  function: {
    name: 'move_file',
    description: "Sposta o rinomina un singolo file (crea le cartelle padre della destinazione se mancano). Per spostare/rinominare un'intera cartella usa 'run_terminal_command' con 'mv'.",
    parameters: {
      type: 'object',
      properties: {
        sourcePath: { type: 'string', description: 'Percorso assoluto o relativo al progetto del file da spostare/rinominare.' },
        destinationPath: { type: 'string', description: 'Nuovo percorso (assoluto o relativo al progetto), file incluso — non solo la cartella.' }
      },
      required: ['sourcePath', 'destinationPath']
    }
  }
}

export async function executeMoveFile(args: { sourcePath: string, destinationPath: string }, cwd: string): Promise<string> {
  try {
    const sourceAbs = resolveTargetPath(cwd, args.sourcePath)
    const destAbs = resolveTargetPath(cwd, args.destinationPath)

    if (!fs.existsSync(sourceAbs)) {
      return `❌ File sorgente non trovato: ${args.sourcePath}`
    }
    if (fs.statSync(sourceAbs).isDirectory()) {
      return `❌ '${args.sourcePath}' è una cartella — 'move_file' sposta solo singoli file. Usa 'run_terminal_command' con 'mv' per una cartella.`
    }
    if (fs.existsSync(destAbs) && fs.statSync(destAbs).isDirectory()) {
      return `❌ La destinazione '${args.destinationPath}' è una cartella esistente — indica il percorso completo del file di destinazione, non solo la cartella.`
    }

    fs.mkdirSync(path.dirname(destAbs), { recursive: true })
    fs.renameSync(sourceAbs, destAbs)

    return `📦 File spostato: ${args.sourcePath} → ${args.destinationPath}`
  } catch (error: any) {
    return `❌ Errore durante lo spostamento: ${error.message}`
  }
}
