import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import * as dotenv from 'dotenv'
import { initTelegramBot, sendTelegramMessage } from './bots/telegram'
import { initWhatsAppBot, sendWhatsAppMessage } from './bots/whatsapp'
import { runAgenticTask } from './agent/harness'
import { resetChatCallCounter } from './agent/llmClient'
import { saveSession, loadSession, listSessions, deleteSession, type SessionData } from './services/sessionStore'
import { getUsage, resetUsage } from './services/usageTracker'
import { listCheckpoints, revertCheckpoint } from './services/checkpointStore'
import { getMcpServerStatuses, reloadMcpServers, ensureMcpServersConnected } from './services/mcpClient'
import { loadCommandDefinitions, loadAgentDefinitions } from './services/definitionLoader'
import { ensureOmniRoute, retryOmniRoute, isOmniRouteReady, getOmniRouteBaseUrl } from './services/omniRoute'
import { appendTerminalOutput, getRecentOutput, broadcastAgentStream } from './services/outputBuffer'
import { executeGetRepoMap, RepoMapToolDefinition } from './agent/tools/RepoMapPlugin'
import { executeReadFile, ReadFileToolDefinition } from './agent/tools/ReadFilePlugin'
import { executeSearch, SearchToolDefinition } from './agent/tools/SearchPlugin'
import { executeGetDiagnostics, DiagnosticsToolDefinition } from './agent/tools/DiagnosticsPlugin'
import { executeOcrImage, OcrToolDefinition } from './agent/tools/OcrPlugin'
import { BrowserToolDefinitions, executeBrowserTool } from './agent/tools/BrowserAgentPlugin'
import { closeBrowserAgent } from './services/browserAgent'
import { closeStealthBrowserAgent } from './services/stealthBrowserAgent'
import { stopInvokeAI } from './services/invokeAIService'
import { extractDocumentText } from './services/documentExtract'

dotenv.config()

const require = createRequire(import.meta.url)
const pty = require('node-pty')

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.js
// │
process.env.DIST = path.join(__dirname, '../dist')
process.env.VITE_PUBLIC = app.isPackaged ? process.env.DIST : path.join(process.env.DIST, '../public')


let win: BrowserWindow | null
// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']

function createWindow() {
  win = new BrowserWindow({
    icon: path.join(process.env.VITE_PUBLIC, 'favicon.svg'),
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.mjs'),
      nodeIntegration: true,
      contextIsolation: true,
    },
  })

  // Inizializza i bot in background
  initTelegramBot(win)
  initWhatsAppBot(win)

  // Verifica/installa/avvia OmniRoute in background, senza bloccare l'avvio della finestra.
  // Se non riesce (offline, npm senza permessi, timeout) l'harness ricade su Ollama locale.
  ensureOmniRoute(win)

  // Test active push message to Renderer-process.
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', (new Date).toLocaleString())
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
    // win.webContents.openDevTools()
  } else {
    // win.loadFile('dist/index.html')
    win.loadFile(path.join(process.env.DIST, 'index.html'))
  }
}

// Percorso radice DELL'APP stessa (non del progetto aperto nell'explorer): usato
// per trovare src/skills in modo affidabile sia in dev che pacchettizzata, dove
// process.cwd() non è prevedibile (funzionava solo per coincidenza in dev, dato
// che lì cwd combacia con la root del progetto code-ide).
ipcMain.handle('get-app-root', () => {
  return { success: true, data: app.getAppPath() }
})

// Set up IPC handlers for file system
ipcMain.handle('read-dir', async (_event, dirPath: string) => {
  try {
    // Use the provided path or default to the user's workspace
    const targetDir = dirPath || process.cwd()
    const entries = await fs.readdir(targetDir, { withFileTypes: true })
    
    const files = entries.map(entry => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      path: path.join(targetDir, entry.name)
    })).sort((a, b) => {
      // Directories first
      if (a.isDirectory === b.isDirectory) {
        return a.name.localeCompare(b.name)
      }
      return a.isDirectory ? -1 : 1
    })
    
    return { success: true, data: files, path: targetDir }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

// Read whole project recursively (for LLM context)
ipcMain.handle('read-project', async (_event, dirPath: string) => {
  try {
    const targetPath = dirPath || process.cwd()
    let resultContext = ''
    
    const walk = async (dir: string) => {
      const files = await fs.readdir(dir, { withFileTypes: true })
      for (const file of files) {
        const res = path.resolve(dir, file.name)
        if (file.isDirectory()) {
          if (!['node_modules', '.git', 'dist', 'build', '.DS_Store'].includes(file.name)) {
            await walk(res)
          }
        } else {
          // Read only text files for context
          const ext = path.extname(res).toLowerCase()
          if (['.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.py', '.rs', '.html', '.css', '.txt'].includes(ext)) {
            try {
              const content = await fs.readFile(res, 'utf-8')
              resultContext += `\n--- File: ${res.replace(targetPath, '')} ---\n${content}\n`
            } catch (_e) {
              // Ignore read errors for individual files
            }
          }
        }
      }
    }
    
    await walk(targetPath)
    return { success: true, data: resultContext }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

// Mappa compatta dei simboli esportati (AST, non testo grezzo) — sostituisce
// 'read-project' come contesto di default iniettato nel system prompt: un progetto
// come questo (67 file) pesava ~122.000 token da solo, saturando al 100% la finestra
// di contesto di un modello locale ad OGNI messaggio, anche i più semplici. Riusa la
// stessa logica AST già validata per il tool 'get_repo_map' dell'harness agentico.
ipcMain.handle('get-repo-map', async (_event, dirPath: string) => {
  try {
    const data = await executeGetRepoMap({}, dirPath || process.cwd())
    return { success: true, data }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

// Elenco piatto dei percorsi file del progetto (qualunque estensione), per
// l'autocomplete @-mention in chat (ispirato a Cursor: pinnare esplicitamente
// un file come contesto, invece di affidarsi solo alla repo-map/ricerca automatica).
const MENTION_EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-electron', 'build', '.code-ide-backups', 'release'])
const MENTION_MAX_FILES = 500

ipcMain.handle('list-project-files', async (_event, dirPath: string) => {
  try {
    const root = dirPath || process.cwd()
    const out: string[] = []

    const walk = async (dir: string) => {
      if (out.length >= MENTION_MAX_FILES) return
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (out.length >= MENTION_MAX_FILES) return
        if (entry.isDirectory()) {
          if (!MENTION_EXCLUDED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
            await walk(path.join(dir, entry.name))
          }
        } else {
          out.push(path.relative(root, path.join(dir, entry.name)))
        }
      }
    }

    await walk(root)
    return { success: true, data: out }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

// Albero COMPLETO di cartelle e file (qualunque estensione, non solo TS/JS)
// per il contesto automatico della chat — prima il modello riceveva solo una
// mappa AST limitata ai simboli esportati di .ts/.tsx/.js/.jsx, quindi non
// aveva alcuna awareness di file di config, asset, altri linguaggi, o della
// struttura reale delle cartelle. Qui diamo solo i PERCORSI (nessun
// contenuto): il modello legge i singoli file rilevanti con 'read_file' —
// esattamente come già fa in Agent Mode, solo con un punto di partenza più
// completo per decidere cosa leggere.
const TREE_MAX_ENTRIES = 2000
const TREE_MAX_CHARS = 20000

async function buildProjectTree(root: string): Promise<string> {
  let entryCount = 0
  let truncated = false

  const walk = async (dir: string, prefix: string): Promise<string> => {
    if (truncated) return ''
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return ''
    }
    // Cartelle prima, poi ordine alfabetico: rende l'albero leggibile e
    // stabile invece che nell'ordine (spesso arbitrario) del filesystem.
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    let out = ''
    for (const entry of entries) {
      if (entryCount >= TREE_MAX_ENTRIES || out.length > TREE_MAX_CHARS) { truncated = true; return out }
      if (entry.name.startsWith('.')) continue // dotfile/dotdir: stesso criterio delle altre viste sul progetto

      if (entry.isDirectory()) {
        if (MENTION_EXCLUDED_DIRS.has(entry.name)) continue
        entryCount++
        out += `${prefix}${entry.name}/\n`
        out += await walk(path.join(dir, entry.name), prefix + '  ')
      } else {
        entryCount++
        out += `${prefix}${entry.name}\n`
      }
    }
    return out
  }

  let tree = await walk(root, '')
  if (tree.length > TREE_MAX_CHARS) tree = tree.slice(0, TREE_MAX_CHARS)
  if (truncated) tree += '\n... (albero troncato, progetto molto grande — usa get_repo_map con subPath o search_codebase per una sottocartella specifica)'
  return tree
}

ipcMain.handle('get-project-tree', async (_event, dirPath: string) => {
  try {
    const data = await buildProjectTree(dirPath || process.cwd())
    return { success: true, data }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

// Conteggio ESATTO di file/cartelle (non una stima dal testo dell'albero,
// eventualmente troncato oltre TREE_MAX_ENTRIES) — usato dalla chat per
// annunciare all'utente lo scope reale prima di iniziare una revisione a
// step multipli ("ci sono X file in Y cartelle").
async function countProjectEntries(root: string): Promise<{ files: number, folders: number }> {
  let files = 0
  let folders = 0
  const walk = async (dir: string): Promise<void> => {
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (MENTION_EXCLUDED_DIRS.has(entry.name)) continue
        folders++
        await walk(path.join(dir, entry.name))
      } else {
        files++
      }
    }
  }
  await walk(root)
  return { files, folders }
}

ipcMain.handle('get-project-entry-count', async (_event, dirPath: string) => {
  try {
    const data = await countProjectEntries(dirPath || process.cwd())
    return { success: true, data }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('read-file', async (_event, filePath: string) => {
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    return { success: true, data: content, path: filePath }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('save-file', async (_event, filePath: string, content: string, options?: { metadataRemoval?: 'all' | 'ai-only' | 'none' }) => {
  try {
    const { sanitizeAndFormatCode } = await import('./services/codeSanitizer')
    const finalContent = await sanitizeAndFormatCode(content, filePath, options?.metadataRemoval || 'none')
    await fs.writeFile(filePath, finalContent, 'utf-8')
    return { success: true }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon'
}

// 'read-file' legge sempre come UTF-8: per un binario come un PNG/JPEG questo
// mangia i byte non validi in U+FFFD, rendendo il file un muro di "�" invece
// di mostrare né l'immagine né i metadati testuali reali che contiene. Questo
// handler dedicato restituisce ENTRAMBE le viste: 'dataUrl' per il rendering
// vero e proprio, e 'rawText' (decodificato latin1 — 1 byte = 1 carattere,
// nessuna perdita) per la vista "codice" dove restano leggibili le stringhe
// di metadati incorporate (es. firme/provenienza degli strumenti di
// generazione AI: "http", "google", "gemini", ecc. viste dall'utente).
ipcMain.handle('read-image-file', async (_event, filePath: string) => {
  try {
    const buffer = await fs.readFile(filePath)
    const ext = filePath.split('.').pop()?.toLowerCase() || ''
    const mimeType = IMAGE_MIME_BY_EXT[ext] || 'application/octet-stream'
    return {
      success: true,
      dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
      rawText: buffer.toString('latin1')
    }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('reveal-in-folder', (_event, filePath: string) => {
  shell.showItemInFolder(filePath)
})

// Rimuove i chunk/marker di metadati testuali (PNG tEXt/zTXt/iTXt/eXIf/tIME,
// JPEG APP1/APP13/COM) da un'immagine — dove i generatori AI incorporano la
// loro firma/provenienza — sovrascrivendo il file. Pura manipolazione dei
// byte del contenitore, i pixel non vengono toccati/ricompressi.
ipcMain.handle('strip-image-metadata', async (_event, filePath: string, options?: { metadataRemoval?: 'all' | 'ai-only' }) => {
  try {
    const buffer = await fs.readFile(filePath)
    const { stripImageMetadata } = await import('./services/imageMetadata')
    const { output, removedChunks, format } = stripImageMetadata(buffer, options?.metadataRemoval || 'all')
    if (removedChunks.length === 0) {
      return { success: true, removedChunks: [], format, bytesRemoved: 0 }
    }
    await fs.writeFile(filePath, output)
    return { success: true, removedChunks, format, bytesRemoved: buffer.length - output.length }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

// Auto-discovery e chat per i modelli gratuiti di Duck.ai
ipcMain.handle('get-duckai-models', async () => {
  try {
    const { discoverDuckAiModels } = await import('./services/duckAiDiscovery')
    const models = await discoverDuckAiModels()
    return { success: true, data: models }
  } catch (error: any) {
    const { getCachedOrDefaultModels } = await import('./services/duckAiDiscovery')
    return { success: true, data: getCachedOrDefaultModels() }
  }
})

ipcMain.handle('duckai-chat', async (_event, payload: { model: string, messages: any[], tools?: any[] }) => {
  try {
    const { callDuckAiChat } = await import('./services/duckAi')
    const result = await callDuckAiChat({
      model: payload.model,
      messages: payload.messages,
      tools: payload.tools
    })
    return { success: true, data: result }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

// Gestione autenticazione e chat per Sakana AI (chat.sakana.ai)
ipcMain.handle('sakana-status', async () => {
  try {
    const { checkSakanaAuth } = await import('./services/sakanaAi')
    const authenticated = await checkSakanaAuth()
    return { success: true, authenticated }
  } catch (error: any) {
    return { success: false, authenticated: false, error: error.message }
  }
})

ipcMain.handle('sakana-open-login', async () => {
  try {
    const { openSakanaLogin } = await import('./services/sakanaAi')
    const success = await openSakanaLogin()
    return { success }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('sakana-chat', async (_event, payload: { model: string, messages: any[], tools?: any[] }) => {
  try {
    const { callSakanaChat } = await import('./services/sakanaAi')
    const result = await callSakanaChat({
      model: payload.model,
      messages: payload.messages,
      tools: payload.tools
    })
    return { success: true, data: result }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

// Persistenza delle sessioni di chat: vivono in userData (dati personali
// dell'utente), non nel progetto — la conversazione sopravvive alla chiusura
// dell'app, a differenza di prima quando viveva solo in uno useState di React.
ipcMain.handle('session.save', (_event, data: SessionData) => {
  try {
    saveSession(data)
    return { success: true }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('session.load', (_event, projectRoot: string, sessionId: string) => {
  try {
    const data = loadSession(projectRoot, sessionId)
    return data ? { success: true, data } : { success: false, error: 'Sessione non trovata' }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('session.list', (_event, projectRoot: string) => {
  try {
    return { success: true, data: listSessions(projectRoot) }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('session.delete', (_event, projectRoot: string, sessionId: string) => {
  try {
    deleteSession(projectRoot, sessionId)
    return { success: true }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

// Utilizzo cumulativo (token/chiamate per modello) — non un costo in $, vedi
// usageTracker.ts. Persistito in userData, sopravvive al riavvio dell'app.
ipcMain.handle('usage.get', () => {
  try {
    return { success: true, data: getUsage() }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('usage.reset', () => {
  try {
    resetUsage()
    return { success: true }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

// Checkpoint/rewind: annulla come unità atomica tutti i file toccati da un
// singolo run dell'agente, ripristinandone il contenuto pre-task.
ipcMain.handle('checkpoint.list', (_event, projectRoot: string) => {
  try {
    return { success: true, data: listCheckpoints(projectRoot) }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('checkpoint.revert', (_event, projectRoot: string, runId: string) => {
  try {
    return { success: true, data: revertCheckpoint(projectRoot, runId) }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

// MCP (Model Context Protocol): server di terze parti configurati in
// <progetto>/.code-ide/mcp.json, connessi via l'harness al primo utilizzo.
ipcMain.handle('mcp.status', async (_event, projectRoot: string) => {
  try {
    await ensureMcpServersConnected(projectRoot)
    return { success: true, data: getMcpServerStatuses(projectRoot) }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('mcp.reload', async (_event, projectRoot: string) => {
  try {
    return { success: true, data: await reloadMcpServers(projectRoot) }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

// Comandi slash (.code-ide/commands/*.md) e sub-agenti persistenti
// (.code-ide/agents/*.md) — riusabili tra sessioni invece che reinventati ogni volta.
ipcMain.handle('commands.list', (_event, projectRoot: string) => {
  try {
    return { success: true, data: loadCommandDefinitions(projectRoot) }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('agents.list', (_event, projectRoot: string) => {
  try {
    return { success: true, data: loadAgentDefinitions(projectRoot) }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

// Terminal integration
let ptyProcess: any = null

ipcMain.handle('terminal.spawn', (event, cwd?: string) => {
  if (ptyProcess) {
    ptyProcess.kill()
  }

  // Prima usava sempre '/bin/bash' — su macOS (Catalina+) quello è il vecchio
  // bash 3.2 di sistema tenuto solo per compatibilità, non la shell di login
  // reale dell'utente (zsh di default dal 2019): ogni apertura del terminale
  // stampava l'avviso "The default interactive shell is now zsh..." e non
  // caricava affatto .zshrc (alias, PATH di nvm/pyenv, ecc. configurati lì).
  // os.userInfo().shell legge la shell di login vera dal database utenti di
  // sistema (dscl su macOS) — affidabile anche quando l'app è lanciata dal
  // Dock/Finder, a differenza di process.env.SHELL che un processo GUI non
  // sempre eredita.
  const shell = os.platform() === 'win32' ? 'cmd.exe' : (os.userInfo().shell || process.env.SHELL || '/bin/zsh')

  // Prima era sempre process.cwd() (la cartella da cui è partito il processo
  // Electron), non la cartella progetto realmente aperta in ESPLORA RISORSE —
  // coincidevano per puro caso nello sviluppo (npm run dev parte dalla root
  // del repo, che è anche il primo progetto mostrato), ma aprendone un altro
  // il terminale restava nella cartella sbagliata, a differenza di VS Code/
  // Claude Code dove il terminale integrato segue sempre la root del progetto.
  ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-color',
    cols: 80,
    rows: 30,
    cwd: cwd || process.cwd(),
    env: process.env as any
  })

  ptyProcess.onData((data: string) => {
    event.sender.send('terminal.incomingData', data)
    appendTerminalOutput(data)
  })

  return { success: true }
})

ipcMain.on('terminal.keystroke', (_event, data: string) => {
  if (ptyProcess) {
    ptyProcess.write(data)
  }
})

ipcMain.on('terminal.resize', (_event, cols: number, rows: number) => {
  if (ptyProcess) {
    try {
      ptyProcess.resize(cols, rows)
    } catch (e) {
      console.error('Failed to resize terminal', e)
    }
  }
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  stopInvokeAI()
  closeBrowserAgent()
  closeStealthBrowserAgent()
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

// 'window-all-closed' da solo non basta: in modalità sviluppo vite-plugin-electron
// termina il vecchio processo Electron direttamente a ogni modifica ai file del
// main process, SENZA passare da quell'evento — questi handler garantiscono il
// cleanup di InvokeAI (e ora anche della BrowserWindow nascosta del Browser
// Agent e del Chromium/Chrome separato lanciato da patchright per il backend
// stealth: entrambi processi/finestre che altrimenti resterebbero orfani)
// qualunque sia il percorso di uscita del processo — lo stesso schema di
// rischio che, con il Voice Agent rimosso, aveva già causato un accumulo di
// processi orfani e un vero kernel panic verificato nei log di sistema.
app.on('before-quit', () => { stopInvokeAI(); closeBrowserAgent(); closeStealthBrowserAgent() })
process.on('SIGINT', () => { stopInvokeAI(); closeBrowserAgent(); closeStealthBrowserAgent(); process.exit(0) })
process.on('SIGTERM', () => { stopInvokeAI(); closeBrowserAgent(); closeStealthBrowserAgent(); process.exit(0) })

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

// Buffer di output (terminale + stream agente) per il comando /output dei bot remoti
ipcMain.handle('get-output-buffer', () => {
  return { success: true, data: getRecentOutput() }
})

// Stato/riprova OmniRoute per il pannello Impostazioni
ipcMain.handle('get-omniroute-status', () => {
  return { ready: isOmniRouteReady() }
})
ipcMain.handle('retry-omniroute', () => {
  retryOmniRoute(win)
  return { success: true }
})

// Chat testuale (non-Agent-Mode) verso OmniRoute — DEVE passare da qui invece
// che da un fetch() diretto nel renderer: verificato dal vivo (DevTools +
// curl) che OmniRoute risponde correttamente al preflight CORS (OPTIONS) ma
// NON include mai 'Access-Control-Allow-Origin' sulla risposta vera, nemmeno
// quando la chiamata riesce (200 OK) — Chromium blocca quindi sempre la
// lettura della risposta lato renderer, qualunque endpoint '/v1/*' si usi.
// Il fetch() del processo main, non essendo un browser, non è soggetto a CORS
// ed è la stessa via già usata con successo dall'Agent Mode (llmClient.ts).
ipcMain.handle('omniroute-chat-completion', async (_event, params: { model: string, messages: any[], tools?: any[] }) => {
  const baseUrl = getOmniRouteBaseUrl()
  if (!baseUrl) {
    throw new Error('OmniRoute non è pronto (badge in basso, o riprova dalle Impostazioni).')
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (process.env.OMNIROUTE_API_KEY) {
    headers['Authorization'] = `Bearer ${process.env.OMNIROUTE_API_KEY}`
  }
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: params.model, messages: params.messages, tools: params.tools, stream: false })
  })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`OmniRoute ha risposto con errore ${res.status}: ${errBody.slice(0, 300)}`)
  }
  const data = await res.json()
  const choice = data.choices?.[0]?.message
  return {
    content: choice?.content || '',
    resolvedModel: typeof data.model === 'string' ? data.model : undefined,
    tool_calls: choice?.tool_calls
  }
})

// Tool di SOLA LETTURA (leggere file, cercare nel codice, mappa repo,
// diagnostica TS) disponibili alla chat NORMALE (non-Agent-Mode) per QUALSIASI
// modello selezionato nel menu — prima solo l'Agent Mode poteva davvero
// "mettere mano" ai file: la chat normale riceveva solo l'albero dei percorsi
// (nomi, non contenuto), quindi un modello poteva solo indovinare cosa
// contenesse un file mai aperto/pinnato esplicitamente dall'utente. Girano da
// qui (processo main) perché richiedono accesso al filesystem/TypeScript
// Compiler API, non disponibile nel renderer. Stessa whitelist di sola
// lettura già usata dai sub-agenti (SubagentPlugin.ts) meno i tool browser,
// non rilevanti per la chat testuale.
// Tool del Browser Agent inclusi qui SOLO nelle varianti di sola lettura
// (navigate/screenshot/eval/smart_locate — guardare, non agire): browser_click
// e browser_solve_cloudflare restano esclusivi di Agent Mode, come nell'harness.
const READONLY_CHAT_TOOLS = [
  ReadFileToolDefinition, SearchToolDefinition, RepoMapToolDefinition, DiagnosticsToolDefinition, OcrToolDefinition,
  BrowserToolDefinitions[0], // browser_navigate
  BrowserToolDefinitions[1], // browser_screenshot
  BrowserToolDefinitions[2], // browser_eval
  BrowserToolDefinitions[4]  // browser_smart_locate
]

ipcMain.handle('get-readonly-chat-tools', () => READONLY_CHAT_TOOLS)

ipcMain.handle('run-readonly-tool', async (_event, params: { functionName: string, args: any, cwd: string }) => {
  const { functionName, args, cwd } = params
  if (functionName === 'read_file') return executeReadFile(args, cwd)
  if (functionName === 'search_codebase') return executeSearch(args, cwd)
  if (functionName === 'get_repo_map') return executeGetRepoMap(args, cwd)
  if (functionName === 'get_diagnostics') return executeGetDiagnostics(args, cwd)
  if (functionName === 'ocr_image') return executeOcrImage(args, cwd)
  if (functionName.startsWith('browser_')) return executeBrowserTool(functionName, args, cwd)
  return `Strumento non disponibile per la chat (sola lettura): ${functionName}`
})

// Estrazione testo da PDF/DOCX allegati in chat: pdf-parse/mammoth sono
// librerie Node (Buffer, fs) irraggiungibili dal renderer in modo affidabile,
// quindi il file grezzo arriva qui via IPC (ArrayBuffer) e il testo estratto
// torna indietro come stringa semplice, stesso trattamento di un file .txt.
ipcMain.handle('extract-document-text', async (_event, params: { fileName: string, buffer: ArrayBuffer }) => {
  try {
    const { text, warning } = await extractDocumentText(Buffer.from(params.buffer), params.fileName)
    return { ok: true, text, warning }
  } catch (error: any) {
    return { ok: false, error: error.message }
  }
})

// Bot Reply Handler
ipcMain.on('bot-reply', (event, replyData) => {
  const { source, chatId, text } = replyData
  if (source === 'telegram') {
    sendTelegramMessage(chatId, text)
  } else if (source === 'whatsapp') {
    sendWhatsAppMessage(chatId, text)
  }
})

// Agent Harness Handler: genera un runId di correlazione (crypto.randomUUID)
// e lo restituisce subito al chiamante, mentre l'harness gira in background.
// Ogni evento 'agent-stream' porta questo stesso runId (vedi outputBuffer.ts),
// così due run concorrenti (es. desktop + bot Telegram) non si mischiano mai.
ipcMain.handle('run-agent-task', (_event, data) => {
  const { userPrompt, systemPrompt, cwd, model, images, deepReasoning, planMode } = data
  const runId = randomUUID()
  if (win) {
    // Azzera il tetto di sicurezza sulle chiamate LLM (vedi llmClient.ts) a ogni
    // nuovo task: il limite protegge dal ciclo fuori controllo del singolo task,
    // non è un tetto per l'intera sessione dell'app. NB: due run concorrenti
    // (es. desktop + bot Telegram) condividono lo stesso contatore globale —
    // un limite noto, accettabile perché il rischio reale che si vuole coprire
    // è il singolo task che degenera, non la concorrenza tra task diversi.
    resetChatCallCounter()
    runAgenticTask(win, userPrompt, systemPrompt, cwd, model, images, deepReasoning, runId, planMode)
      .catch(err => {
        // Un errore che scoppia PRIMA che l'harness raggiunga il proprio blocco
        // try/catch interno (es. un crash nell'inizializzazione, come quello reale
        // trovato in getProjectMemories/better-sqlite3) veniva solo loggato qui,
        // MAI comunicato al renderer — la chat restava bloccata per sempre su
        // "Avvio..." senza alcun messaggio d'errore visibile. Trovato con un vero
        // test dal vivo dell'app, non dalla sola lettura del codice.
        console.error('[run-agent-task] Errore harness:', err)
        broadcastAgentStream(win, { type: 'error', message: `Errore critico nell'harness: ${err.message || err}` }, runId)
      })
  }
  return { runId }
})

app.whenReady().then(createWindow)
