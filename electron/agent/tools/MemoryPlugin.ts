import { saveMemory } from '../memory'

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

export async function executeMemorySave(args: any, cwd: string): Promise<string> {
  try {
    saveMemory(cwd, args.key, args.value)
    return `✅ Memoria '${args.key}' salvata con successo per il progetto corrente.`
  } catch (error: any) {
    return `❌ Errore durante il salvataggio della memoria: ${error.message}`
  }
}
