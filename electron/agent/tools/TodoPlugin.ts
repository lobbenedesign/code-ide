import { BrowserWindow } from 'electron'

// Equivalente del tool TodoWrite di Claude Code: non tocca mai il filesystem,
// serve solo a far dichiarare all'agente il proprio piano di lavoro in corso
// (visibile all'utente in tempo reale) durante un task multi-step — invece di
// lasciare l'utente a intuire cosa sta facendo dal solo log testuale.
export const TodoToolDefinition = {
  type: 'function' as const,
  function: {
    name: 'write_todos',
    description: "Dichiara/aggiorna la tua lista di passi (todo list) per il task multi-step corrente, visibile in tempo reale all'utente. Usalo SUBITO quando un task richiede 3+ passi distinti, per pianificarli esplicitamente, e poi RI-chiamalo per aggiornare lo stato (pending → in_progress → completed) man mano che procedi — un solo passo alla volta in 'in_progress'. Non serve per task banali a un solo passo.",
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: "L'intera lista aggiornata dei passi (sostituisce quella precedente, non la accoda).",
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Descrizione breve e concreta del passo.' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Stato attuale del passo.' }
            },
            required: ['content', 'status']
          }
        }
      },
      required: ['todos']
    }
  }
}

export async function executeWriteTodos(args: { todos: { content: string, status: string }[] }, mainWindow: BrowserWindow, runId?: string): Promise<string> {
  if (!Array.isArray(args.todos)) {
    return "❌ Errore: 'todos' deve essere un array di { content, status }."
  }

  const sanitized = args.todos
    .filter(t => t && typeof t.content === 'string')
    .map(t => ({
      content: t.content,
      status: ['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending'
    }))

  mainWindow.webContents.send('agent-todos', { todos: sanitized, runId })

  const summary = sanitized.map(t => {
    const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜'
    return `${icon} ${t.content}`
  }).join('\n')

  return `📋 Todo list aggiornata (${sanitized.length} passi):\n${summary}`
}
