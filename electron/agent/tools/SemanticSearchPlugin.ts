import { semanticSearch } from '../../services/semanticIndex'

// N-03 dell'audit: complemento a search_codebase (stringhe/regex esatte), non
// un sostituto — una query concettuale ("dove gestiamo il timeout del
// terminale in background") spesso non contiene nessuna stringa letterale
// presente nel codice, mentre trovare "TERMINAL_TIMEOUT_MS" con grep è
// istantaneo e search_codebase resta la scelta giusta per quello.
export const SemanticSearchToolDefinition = {
  type: 'function' as const,
  function: {
    name: 'semantic_search',
    description: "Cerca codice per SIGNIFICATO invece che per stringa esatta, usando embedding locali (nomic-embed-text via Ollama, nessun servizio esterno). Usalo per query concettuali che 'search_codebase' (grep/regex) non troverebbe — es. 'dove gestiamo la disconnessione del terminale' invece di dover indovinare il nome esatto di una funzione o costante. Indicizza automaticamente i file nuovi/modificati alla prima chiamata su un progetto (può richiedere qualche secondo la prima volta, poi solo le modifiche incrementali). Richiede Ollama in esecuzione con il modello 'nomic-embed-text' installato.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Query in linguaggio naturale che descrive cosa stai cercando concettualmente.' },
        topK: { type: 'number', description: 'Numero massimo di risultati da restituire (default 8, max 15).' }
      },
      required: ['query']
    }
  }
}

export async function executeSemanticSearch(args: { query: string, topK?: number }, cwd: string): Promise<string> {
  try {
    const topK = Math.max(1, Math.min(15, args.topK || 8))
    const { results, indexStats } = await semanticSearch(cwd, args.query, topK)

    if (results.length === 0) {
      return `Nessun file indicizzabile trovato nel progetto (0 chunk nell'indice) — verifica che il progetto contenga file di codice supportati.`
    }

    const indexNote = indexStats.filesIndexed > 0
      ? ` (indice aggiornato: ${indexStats.filesIndexed} file ri-processati, ${indexStats.filesSkippedUnchanged} invariati${indexStats.filesRemoved > 0 ? `, ${indexStats.filesRemoved} rimossi` : ''})`
      : ''

    const formatted = results.map((r, i) => {
      const relPath = r.filePath.startsWith(cwd) ? r.filePath.slice(cwd.length + 1) : r.filePath
      const snippet = r.text.length > 500 ? r.text.slice(0, 500) + '\n... (troncato)' : r.text
      return `${i + 1}. ${relPath}:${r.startLine}-${r.endLine} (similarità ${(r.score * 100).toFixed(1)}%)\n\`\`\`\n${snippet}\n\`\`\``
    }).join('\n\n')

    return `Risultati ricerca semantica per "${args.query}"${indexNote}:\n\n${formatted}`
  } catch (error: any) {
    return `❌ Errore durante la ricerca semantica: ${error.message}`
  }
}
