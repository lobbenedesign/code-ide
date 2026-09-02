import * as fs from 'fs'
import { resolveTargetPath } from './fileWriteUtils'

export const CreateFolderToolDefinition = {
  type: 'function' as const,
  function: {
    name: 'create_folder',
    description: "Crea una cartella (e le eventuali cartelle padre mancanti, come 'mkdir -p') nel progetto. Nota: 'edit_file' crea già da solo le cartelle padre necessarie per il file che scrive — usa 'create_folder' solo quando ti serve una cartella VUOTA o prima di scrivere più file al suo interno.",
    parameters: {
      type: 'object',
      properties: {
        folderPath: { type: 'string', description: 'Percorso assoluto o relativo al progetto della cartella da creare.' }
      },
      required: ['folderPath']
    }
  }
}

export async function executeCreateFolder(args: { folderPath: string }, cwd: string): Promise<string> {
  try {
    const targetPath = resolveTargetPath(cwd, args.folderPath)
    if (fs.existsSync(targetPath)) {
      return fs.statSync(targetPath).isDirectory()
        ? `ℹ️ La cartella esiste già: ${args.folderPath}`
        : `❌ '${args.folderPath}' esiste già come FILE, non può diventare una cartella.`
    }
    fs.mkdirSync(targetPath, { recursive: true })
    return `📁 Cartella creata: ${args.folderPath}`
  } catch (error: any) {
    return `❌ Errore durante la creazione della cartella: ${error.message}`
  }
}
