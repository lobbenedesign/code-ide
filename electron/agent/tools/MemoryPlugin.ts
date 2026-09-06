import { saveMemory, deleteMemory, getProjectMemories } from '../memory'

export const MemoryToolDefinition = {
  type: "function",
  function: {
    name: "save_memory",
    description: "Salva permanentemente una preferenza, una regola o un contesto per il progetto corrente. Questa memoria sarà sempre iniettata nei prompt futuri.",
    parameters: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "La chiave della memoria (es. 'stile_css', 'regole_typescript')."
        },
        value: {
          type: "string",
          description: "Il contenuto o la regola da memorizzare."
        }
      },
      required: ["key", "value"]
    }
  }
}

// Controparte di save_memory, prima assente: una regola salvata poteva solo
// essere sovrascritta (stessa chiave) o restare per sempre, mai rimossa
// davvero. Usala quando l'utente dice esplicitamente che una regola/preferenza
// non vale più, o quando una memoria si rivela sbagliata/obsoleta durante il task.
export const ForgetMemoryToolDefinition = {
  type: "function",
  function: {
    name: "forget_memory",
    description: "Rimuove definitivamente una memoria di progetto salvata in precedenza con save_memory, per chiave esatta. Usalo quando l'utente chiede di dimenticare/rimuovere una regola, o quando scopri che una memoria salvata è ormai sbagliata o superata.",
    parameters: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "La chiave esatta della memoria da rimuovere (vedi l'elenco '[MEMORIE DI PROGETTO]' nel system prompt per le chiavi correnti)."
        }
      },
      required: ["key"]
    }
  }
}

export async function executeMemorySave(args: any, cwd: string): Promise<string> {
  try {
    saveMemory(cwd, args.key, args.value)
    return `✅ Memoria '${args.key}' salvata con successo per il progetto corrente.`
  } catch (error: any) {
    return `❌ Errore durante il salvataggio della memoria: ${error.message}`
  }
}

export async function executeForgetMemory(args: any, cwd: string): Promise<string> {
  try {
    const removed = deleteMemory(cwd, args.key)
    if (!removed) {
      const existing = getProjectMemories(cwd).map(m => m.key)
      return `⚠️ Nessuna memoria con chiave '${args.key}' trovata per questo progetto.` + (existing.length > 0 ? ` Chiavi esistenti: ${existing.join(', ')}.` : ' Non ci sono memorie salvate per questo progetto.')
    }
    return `✅ Memoria '${args.key}' rimossa: non verrà più iniettata nei prompt futuri.`
  } catch (error: any) {
    return `❌ Errore durante la rimozione della memoria: ${error.message}`
  }
}
