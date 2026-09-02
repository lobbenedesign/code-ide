import * as fs from 'fs'
import * as path from 'path'
import { resolveTargetPath } from './fileWriteUtils'

export const DeleteFolderToolDefinition = {
  type: 'function' as const,
  function: {
    name: 'delete_folder',
    description: "Elimina ricorsivamente una cartella e tutto il suo contenuto dal progetto aperto. Coperto da checkpoint/rewind come edit_file/delete_file: il contenuto testuale di ogni file dentro la cartella viene catturato prima dell'eliminazione e può essere ripristinato con 'Annulla task' (i file binari non testuali non sono ricostruibili byte-per-byte). Non può mai cancellare la root del progetto o una cartella che la contiene.",
    parameters: {
      type: 'object',
      properties: {
        folderPath: { type: 'string', description: 'Percorso assoluto o relativo al progetto della cartella da eliminare — deve essere una sottocartella del progetto, non la root stessa.' }
      },
      required: ['folderPath']
    }
  }
}

export async function executeDeleteFolder(args: { folderPath: string }, cwd: string): Promise<string> {
  try {
    const targetPath = resolveTargetPath(cwd, args.folderPath)
    const resolvedCwd = path.resolve(cwd)
    const resolvedTarget = path.resolve(targetPath)

    // A differenza di 'run_terminal_command' (una scappatoia shell libera, dove
    // la responsabilità di un target pericoloso resta sul comando esatto
    // scritto), questo è un tool STRUTTURATO: può operare solo dentro al
    // progetto aperto, mai sulla root stessa o su qualunque cosa la contenga.
    if (resolvedTarget === resolvedCwd || resolvedCwd.startsWith(resolvedTarget + path.sep)) {
      return `🚫 Bloccato per sicurezza: '${args.folderPath}' è la root del progetto o una sua cartella antenata, non una sottocartella. 'delete_folder' può eliminare solo contenuto DENTRO al progetto aperto.`
    }
    if (!resolvedTarget.startsWith(resolvedCwd + path.sep)) {
      return `🚫 Bloccato per sicurezza: '${args.folderPath}' è fuori dal progetto aperto (${cwd}).`
    }
    if (!fs.existsSync(resolvedTarget)) {
      return `❌ Cartella non trovata: ${args.folderPath} (niente da eliminare).`
    }
    if (!fs.statSync(resolvedTarget).isDirectory()) {
      return `❌ '${args.folderPath}' è un file, non una cartella — usa 'delete_file' invece.`
    }

    fs.rmSync(resolvedTarget, { recursive: true, force: true })
    return `🗑️ Cartella eliminata: ${args.folderPath} (irreversibile, non coperta da checkpoint).`
  } catch (error: any) {
    return `❌ Errore durante l'eliminazione della cartella: ${error.message}`
  }
}
