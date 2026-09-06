import { chatCompletion } from '../llmClient'
import { ReadFileToolDefinition, executeReadFile } from './ReadFilePlugin'
import { SearchToolDefinition, executeSearch } from './SearchPlugin'
import { SemanticSearchToolDefinition, executeSemanticSearch } from './SemanticSearchPlugin'
import { RepoMapToolDefinition, executeGetRepoMap } from './RepoMapPlugin'
import { DiagnosticsToolDefinition, executeGetDiagnostics } from './DiagnosticsPlugin'
import { BrowserToolDefinitions, executeBrowserTool } from './BrowserAgentPlugin'
import { OcrToolDefinition, executeOcrImage } from './OcrPlugin'
import { findAgentDefinition } from '../../services/definitionLoader'

export const SubagentToolDefinition = {
  type: 'function',
  function: {
    name: 'invoke_subagent',
    description: "Spawns a specialized sub-agent to perform a specific sub-task in a new LLM context. The sub-agent can read files, search the codebase and get a repo map on its own — but CANNOT write/patch files or run terminal commands (read-only): only the parent agent decides what actually gets written to disk. Returns the sub-agent final analysis/response. Prefer 'agentName' when a matching PERSISTENT sub-agent is listed in the system prompt (defined in .code-ide/agents/*.md, reusable across sessions); use 'agentRole' for a one-off persona with no saved definition.",
    parameters: {
      type: 'object',
      properties: {
        agentName: {
          type: 'string',
          description: "Name of a PERSISTENT sub-agent defined in .code-ide/agents/<name>.md (see the list in the system prompt, if any). Takes precedence over agentRole when both are given."
        },
        agentRole: {
          type: 'string',
          description: 'The role or persona of an AD-HOC sub-agent (e.g., "Senior Python Developer", "Security Auditor") — only used when agentName is not provided.'
        },
        taskPrompt: {
          type: 'string',
          description: 'The specific task for the sub-agent to perform.'
        }
      },
      required: ['taskPrompt']
    }
  }
}

// Tool di SOLA LETTURA per il sub-agente: può investigare il codice da solo
// (leggere file, cercare, farsi una repo-map, controllare diagnostica di tipo,
// ispezionare visivamente un'app in esecuzione) invece di dipendere solo da ciò
// che il modello principale gli incolla nel prompt — ma non può mai
// scrivere/eseguire nulla. browser_click è escluso perché simula un'interazione
// (non è puramente osservativo). Solo l'agente principale decide cosa finisce
// davvero sul disco: mantiene una linea di responsabilità chiara anche
// annidando una delega dentro un agente già completamente autonomo — utile per
// ruoli come "QA Tester" (browser_navigate/screenshot/eval) o "Type Checker"
// (get_diagnostics).
const SUBAGENT_TOOLS = [
  ReadFileToolDefinition, SearchToolDefinition, SemanticSearchToolDefinition, RepoMapToolDefinition, DiagnosticsToolDefinition, OcrToolDefinition,
  BrowserToolDefinitions[0], // browser_navigate
  BrowserToolDefinitions[1], // browser_screenshot
  BrowserToolDefinitions[2], // browser_eval
  BrowserToolDefinitions[4]  // browser_smart_locate
]
const SUBAGENT_MAX_ITERATIONS = 5

export async function executeSubagent(
  args: { agentName?: string, agentRole?: string, taskPrompt: string },
  model: string = 'qwen2.5-coder:latest',
  cwd: string = process.cwd()
): Promise<string> {
  const { taskPrompt } = args

  // Sub-agente PERSISTENTE (.code-ide/agents/<nome>.md), riusabile tra sessioni,
  // invece di una persona sempre reinventata al volo dal modello — la persona
  // (system prompt del sub-agente) è il corpo del file Markdown.
  let agentRole = args.agentRole
  let personaPrompt: string | null = null
  if (args.agentName) {
    const definition = findAgentDefinition(cwd, args.agentName)
    if (definition) {
      agentRole = args.agentName
      personaPrompt = definition.body
    } else {
      agentRole = args.agentName // il modello ha usato un nome inesistente: procedi comunque, ad-hoc, invece di fallire il task
    }
  }
  if (!agentRole) agentRole = 'Assistente generico'

  const systemPrompt = personaPrompt
    ? `${personaPrompt}\n\nConcentrati SOLO sul task assegnato. Hai a disposizione tool di sola lettura (read_file, search_codebase, semantic_search, get_repo_map, get_diagnostics, ocr_image, browser_navigate, browser_screenshot, browser_eval) per investigare il codice reale invece di indovinare. Non puoi scrivere né eseguire nulla: quando hai finito di investigare, fornisci la tua analisi/soluzione finale a testo.`
    : `Sei un sub-agente specializzato. Il tuo ruolo è: ${agentRole}.
Concentrati SOLO sul task assegnato. Hai a disposizione tool di sola lettura (read_file, search_codebase, semantic_search, get_repo_map, get_diagnostics, ocr_image, browser_navigate, browser_screenshot, browser_eval) per investigare il codice reale e ispezionare visivamente un'app in esecuzione invece di indovinare — usali quando ti serve vedere qualcosa che non ti è stato passato nel prompt. Non puoi scrivere né eseguire nulla: quando hai finito di investigare, fornisci la tua analisi/soluzione finale a testo.`

  const messages: any[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: taskPrompt }
  ]

  let iterations = 0
  try {
    while (iterations < SUBAGENT_MAX_ITERATIONS) {
      iterations++
      const result = await chatCompletion({ model, messages, tools: SUBAGENT_TOOLS })
      const assistantMessage = result.message
      messages.push(assistantMessage)

      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        return `SUB-AGENT (${agentRole}) RESPONSE:\n\n${assistantMessage.content}`
      }

      for (const toolCall of assistantMessage.tool_calls) {
        const functionName = toolCall.function.name
        const parsedArgs = typeof toolCall.function.arguments === 'string' ? JSON.parse(toolCall.function.arguments) : toolCall.function.arguments

        let toolResult = ''
        if (functionName === 'read_file') {
          toolResult = await executeReadFile(parsedArgs, cwd)
        } else if (functionName === 'search_codebase') {
          toolResult = await executeSearch(parsedArgs, cwd)
        } else if (functionName === 'semantic_search') {
          toolResult = await executeSemanticSearch(parsedArgs, cwd)
        } else if (functionName === 'get_repo_map') {
          toolResult = await executeGetRepoMap(parsedArgs, cwd)
        } else if (functionName === 'get_diagnostics') {
          toolResult = await executeGetDiagnostics(parsedArgs, cwd)
        } else if (functionName === 'ocr_image') {
          toolResult = await executeOcrImage(parsedArgs, cwd)
        } else if (functionName.startsWith('browser_')) {
          toolResult = await executeBrowserTool(functionName, parsedArgs, cwd)
        } else {
          toolResult = `Strumento non disponibile per i sub-agenti (sola lettura): ${functionName}`
        }

        messages.push({ role: 'tool', name: functionName, content: toolResult })
      }
    }

    return `SUB-AGENT (${agentRole}) RESPONSE (limite di ${SUBAGENT_MAX_ITERATIONS} investigazioni raggiunto, risposta parziale):\n\n${messages[messages.length - 1]?.content || '(nessuna risposta testuale prodotta)'}`
  } catch (err: any) {
    return `Error invoking sub-agent: ${err.message}`
  }
}
