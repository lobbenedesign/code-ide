import * as fs from 'node:fs'
import * as path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// Client MCP reale (protocollo JSON-RPC 2.0 su stdio, via l'SDK ufficiale
// @modelcontextprotocol/sdk — non un client fatto a mano): permette a code-ide
// di connettersi a QUALSIASI server MCP di terze parti (filesystem, database,
// API esterne, ecc.) invece di avere solo i tool cablati a mano nel codice.
// Config per-progetto in <cwd>/.code-ide/mcp.json, stesso schema di Claude Code:
// { "mcpServers": { "nome": { "command": "...", "args": [...], "env": {...} } } }

interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
}

interface McpConfig {
  mcpServers?: Record<string, McpServerConfig>
}

interface ConnectedServer {
  client: Client
  tools: { name: string; description: string; inputSchema: any }[]
  status: 'ready' | 'error'
  error?: string
}

export interface McpServerStatus {
  name: string
  status: 'ready' | 'error'
  error?: string
  toolCount: number
  toolNames: string[]
}

// Connessioni vive tenute in cache per progetto (cwd): connettersi a ogni
// singolo task dell'agente sarebbe lento (spawn di processo + handshake per
// ogni server a ogni messaggio) — si connette una volta e si riusa, con un
// reload esplicito quando l'utente modifica mcp.json.
const connectionsByProject = new Map<string, Map<string, ConnectedServer>>()

function getMcpConfigPath(cwd: string): string {
  return path.join(cwd, '.code-ide', 'mcp.json')
}

function loadMcpConfig(cwd: string): McpConfig {
  const configPath = getMcpConfigPath(cwd)
  if (!fs.existsSync(configPath)) return {}
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  } catch (err: any) {
    throw new Error(`.code-ide/mcp.json non è un JSON valido: ${err.message}`)
  }
}

// Default SDK per una richiesta bloccata (DEFAULT_REQUEST_TIMEOUT_MSEC) è 60s:
// un server MCP mal configurato o che non risponde mai all'handshake 'initialize'
// farebbe attendere fino a un minuto il PRIMO task dell'agente su quel progetto,
// senza alcun segnale di progresso. Un timeout più corto (configurabile) fa
// fallire velocemente quel singolo server (gli altri restano indipendenti)
// invece di lasciare l'utente a chiedersi se l'app si sia bloccata.
const CONNECT_TIMEOUT_MS = Number(process.env.MCP_CONNECT_TIMEOUT_MS) || 15000

async function connectServer(name: string, config: McpServerConfig, cwd: string): Promise<ConnectedServer> {
  try {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env: { ...process.env as Record<string, string>, ...(config.env || {}) },
      cwd
    })

    const client = new Client({ name: 'code-ide', version: '1.0.0' }, { capabilities: {} })
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS })

    const toolsResult = await client.listTools()
    const tools = toolsResult.tools.map(t => ({ name: t.name, description: t.description || '', inputSchema: t.inputSchema }))

    return { client, tools, status: 'ready' }
  } catch (err: any) {
    const isTimeout = /timeout/i.test(err.message)
    return { client: null as any, tools: [], status: 'error', error: isTimeout ? `Timeout dopo ${CONNECT_TIMEOUT_MS / 1000}s (server '${name}' non ha risposto all'handshake in tempo)` : err.message }
  }
}

/** Connette tutti i server configurati per il progetto (se non già connessi). Sicuro da chiamare più volte: riusa le connessioni esistenti. */
export async function ensureMcpServersConnected(cwd: string): Promise<void> {
  if (connectionsByProject.has(cwd)) return

  const config = loadMcpConfig(cwd)
  const serverEntries = Object.entries(config.mcpServers || {})
  if (serverEntries.length === 0) {
    connectionsByProject.set(cwd, new Map())
    return
  }

  const connections = new Map<string, ConnectedServer>()
  // In parallelo: server MCP indipendenti, nessuna ragione di serializzare la connessione.
  await Promise.all(serverEntries.map(async ([name, serverConfig]) => {
    connections.set(name, await connectServer(name, serverConfig, cwd))
  }))

  connectionsByProject.set(cwd, connections)
}

/** Disconnette e ricrea tutte le connessioni per il progetto — usato dopo una modifica a mcp.json. */
export async function reloadMcpServers(cwd: string): Promise<McpServerStatus[]> {
  const existing = connectionsByProject.get(cwd)
  if (existing) {
    for (const conn of existing.values()) {
      try { await conn.client?.close() } catch { /* già chiuso/mai connesso */ }
    }
  }
  connectionsByProject.delete(cwd)
  await ensureMcpServersConnected(cwd)
  return getMcpServerStatuses(cwd)
}

export function getMcpServerStatuses(cwd: string): McpServerStatus[] {
  const connections = connectionsByProject.get(cwd)
  if (!connections) return []
  return Array.from(connections.entries()).map(([name, conn]) => ({
    name,
    status: conn.status,
    error: conn.error,
    toolCount: conn.tools.length,
    toolNames: conn.tools.map(t => t.name)
  }))
}

// Prefisso che identifica un tool come proveniente da un server MCP (stesso
// stile mcp__<server>__<tool> usato dai tool MCP di questa stessa sessione
// Claude — riconoscibile e senza rischio di collisione con i tool nativi).
const MCP_TOOL_PREFIX = 'mcp__'

export function isMcpToolName(functionName: string): boolean {
  return functionName.startsWith(MCP_TOOL_PREFIX)
}

/** Espone i tool scoperti dai server MCP connessi nel formato di funzione usato dall'harness. */
export function getMcpToolDefinitions(cwd: string): any[] {
  const connections = connectionsByProject.get(cwd)
  if (!connections) return []

  const defs: any[] = []
  for (const [serverName, conn] of connections.entries()) {
    if (conn.status !== 'ready') continue
    for (const tool of conn.tools) {
      defs.push({
        type: 'function',
        function: {
          name: `${MCP_TOOL_PREFIX}${serverName}__${tool.name}`,
          description: `[MCP: ${serverName}] ${tool.description}`,
          parameters: tool.inputSchema || { type: 'object', properties: {} }
        }
      })
    }
  }
  return defs
}

export async function executeMcpTool(cwd: string, functionName: string, args: any): Promise<string> {
  const withoutPrefix = functionName.slice(MCP_TOOL_PREFIX.length)
  const separatorIdx = withoutPrefix.indexOf('__')
  if (separatorIdx === -1) return `❌ Nome tool MCP non valido: ${functionName}`

  const serverName = withoutPrefix.slice(0, separatorIdx)
  const toolName = withoutPrefix.slice(separatorIdx + 2)

  const connections = connectionsByProject.get(cwd)
  const conn = connections?.get(serverName)
  if (!conn || conn.status !== 'ready') {
    return `❌ Server MCP '${serverName}' non connesso${conn?.error ? ` (${conn.error})` : ''}.`
  }

  try {
    const result = await conn.client.callTool({ name: toolName, arguments: args })
    const content = result.content as any[] | undefined
    if (!content || content.length === 0) return '(nessun contenuto restituito)'

    return content.map(part => {
      if (part.type === 'text') return part.text
      if (part.type === 'image') return `[immagine ${part.mimeType || ''}, non visualizzabile come testo]`
      return JSON.stringify(part)
    }).join('\n')
  } catch (err: any) {
    return `❌ Errore chiamando ${toolName} su ${serverName}: ${err.message}`
  }
}
