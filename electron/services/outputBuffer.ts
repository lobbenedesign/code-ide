import { BrowserWindow } from 'electron'

const MAX_CHARS = 4000

let terminalBuffer = ''
let agentBuffer = ''

function appendBounded(current: string, chunk: string): string {
  const next = current + chunk
  return next.length > MAX_CHARS ? next.slice(next.length - MAX_CHARS) : next
}

export function appendTerminalOutput(data: string) {
  terminalBuffer = appendBounded(terminalBuffer, data)
}

export function appendAgentEvent(message: string) {
  agentBuffer = appendBounded(agentBuffer, `${message}\n`)
}

/**
 * Invia l'evento 'agent-stream' al renderer E lo registra nel buffer letto da /output.
 * 'runId' identifica univocamente l'esecuzione (desktop Agent Mode o task remoto da
 * bot): permette ai listener di sapere a quale run appartiene l'evento, così due run
 * concorrenti (es. uno dalla chat desktop, uno da un messaggio Telegram) non si
 * mischiano e una risposta non finisce mai nella chat sbagliata.
 */
export function broadcastAgentStream(mainWindow: BrowserWindow | null, payload: { type: string; message: string }, runId?: string) {
  mainWindow?.webContents.send('agent-stream', { ...payload, runId })
  appendAgentEvent(payload.message)
}

export function getRecentOutput(): string {
  const parts: string[] = []
  if (terminalBuffer.trim()) parts.push(`--- Terminale (ultime righe) ---\n${terminalBuffer.trim()}`)
  if (agentBuffer.trim()) parts.push(`--- Agente (ultimi eventi) ---\n${agentBuffer.trim()}`)
  return parts.length > 0 ? parts.join('\n\n') : '(nessun output recente)'
}
