import * as fs from 'fs'
import { summarizeDiff, backupFile, resolveTargetPath } from './fileWriteUtils'

export const PatchFileToolDefinition = {
  type: 'function' as const,
  function: {
    name: 'patch_file',
    description: "Sostituisce UNA porzione precisa e univoca di un file ESISTENTE, senza riscrivere il resto. Usalo SEMPRE al posto di 'edit_file' quando modifichi un file già esistente (soprattutto se grande — centinaia o migliaia di righe): riscrivere l'intero file per cambiare poche righe è lento, spreca token e rischia di corrompere parti non toccate. Prima usa 'read_file' per vedere il testo esatto. 'oldString' deve comparire ESATTAMENTE UNA VOLTA nel file: se il testo che vuoi cambiare non è univoco (es. compare più volte), includi righe di contesto sopra/sotto finché non lo diventa. IMPORTANTE: 'oldString' deve coprire l'INTERO blocco logico che stai sostituendo (es. l'intera funzione/if/loop, non solo la riga di apertura) — se includi solo la firma di una funzione e nel tuo 'newString' scrivi già il corpo, il corpo originale sottostante resterà duplicato/orfano nel file, perché tu stai sostituendo solo la riga che hai indicato, non indovinando dove finisce il blocco.",
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Percorso assoluto o relativo alla root del progetto del file da modificare.' },
        oldString: { type: 'string', description: "Il testo esatto (spazi/indentazione inclusi) da sostituire — deve comparire una sola volta nel file E includere per intero ogni blocco logico che stai riscrivendo (es. l'intera funzione, non solo la sua firma)." },
        newString: { type: 'string', description: 'Il testo completo che sostituisce oldString (rimpiazza tutto ciò che era in oldString, incluso il corpo di eventuali blocchi).' }
      },
      required: ['filePath', 'oldString', 'newString']
    }
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let pos = 0
  while (true) {
    const idx = haystack.indexOf(needle, pos)
    if (idx === -1) break
    count++
    pos = idx + needle.length
  }
  return count
}

export async function executePatchFile(args: { filePath: string; oldString: string; newString: string }, cwd: string): Promise<string> {
  try {
    const targetPath = resolveTargetPath(cwd, args.filePath)

    if (!fs.existsSync(targetPath)) {
      return `❌ File non trovato: ${args.filePath}. Per creare un file nuovo usa 'edit_file', non 'patch_file'.`
    }

    const oldContent = fs.readFileSync(targetPath, 'utf-8')
    const occurrences = countOccurrences(oldContent, args.oldString)

    if (occurrences === 0) {
      return `❌ Testo non trovato in ${args.filePath}. Verifica di aver copiato 'oldString' esattamente (spazi/indentazione inclusi) — usa 'read_file' per vedere il contenuto reale, non fidarti della memoria.`
    }
    if (occurrences > 1) {
      return `❌ Il testo compare ${occurrences} volte in ${args.filePath}, non è univoco. Aggiungi più righe di contesto sopra/sotto a 'oldString' finché non identifica un unico punto.`
    }

    const newContent = oldContent.replace(args.oldString, args.newString)

    backupFile(cwd, args.filePath, oldContent)
    fs.writeFileSync(targetPath, newContent, 'utf-8')

    const diffSummary = summarizeDiff(oldContent, newContent)
    return `✅ ${args.filePath} modificato con successo (${diffSummary}, backup del precedente contenuto salvato).`
  } catch (error: any) {
    return `❌ Errore durante la modifica del file: ${error.message}`
  }
}
