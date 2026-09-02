import { exec } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'

// Installazione automatica di Scrapling (D4Vinci/Scrapling) — prima
// 'fetch_webpage' si limitava a controllare se 'scrapling' fosse già sul PATH
// e, in caso contrario, rifiutava con "l'utente deve eseguire manualmente pip
// install...". Stesso pattern LAZY già collaudato per InvokeAI (services/
// invokeAIService.ts): installazione in un venv Python isolato, avviata in
// background solo al primo uso reale del tool, mai forzata all'avvio
// dell'app — Scrapling non è pesante come un modello ML, ma resta comunque
// un download non richiesto per chi non usa mai lo scraping.
function runCommand(cmd: string, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd, maxBuffer: 20 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

const basePath = path.join(os.homedir(), '.code-ide-data')
const venvPath = path.join(basePath, 'scrapling-venv')

export function getScraplingBinPath(): string {
  return path.join(venvPath, 'bin', 'scrapling')
}

let starting = false
let lastError: string | null = null

async function isVenvScraplingInstalled(): Promise<boolean> {
  try {
    await runCommand(`"${getScraplingBinPath()}" --version`)
    return true
  } catch {
    return false
  }
}

async function isGlobalScraplingInstalled(): Promise<boolean> {
  try {
    await runCommand('scrapling --version')
    return true
  } catch {
    return false
  }
}

// Stesso problema già risolto per InvokeAI/Voice Agent: il 'python3' di
// sistema può puntare a una versione troppo recente senza wheel compatibili
// per dipendenze con componenti nativi (qui: i fetcher browser di Scrapling).
async function findCompatiblePython(): Promise<string> {
  const candidates = ['python3.12', 'python3.11', 'python3.13']
  for (const candidate of candidates) {
    try {
      await runCommand(`which ${candidate}`)
      return candidate
    } catch {
      // non installato, prova il prossimo
    }
  }
  console.log('[Scrapling] Nessun Python compatibile trovato, installo python@3.12 via Homebrew...')
  await runCommand('brew install python@3.12')
  return 'python3.12'
}

async function installScrapling(): Promise<void> {
  const pythonBin = await findCompatiblePython()

  if (!fs.existsSync(venvPath)) {
    console.log('[Scrapling] Creo il virtualenv Python...')
    fs.mkdirSync(basePath, { recursive: true })
    await runCommand(`${pythonBin} -m venv "${venvPath}"`)
  }

  const pipPath = path.join(venvPath, 'bin', 'pip')
  console.log('[Scrapling] Installo scrapling[fetchers] (può richiedere qualche minuto la prima volta)...')
  await runCommand(`"${pipPath}" install --upgrade pip`)
  // --no-cache-dir: stessa precauzione già presa per InvokeAI/Voice Agent — una
  // wheel corrotta in cache pip causa fallimenti a runtime silenziosi, non in
  // fase di installazione.
  await runCommand(`"${pipPath}" install --no-cache-dir "scrapling[fetchers]"`)
  console.log('[Scrapling] Scarico i browser necessari (scrapling install)...')
  await runCommand(`"${getScraplingBinPath()}" install`)
}

/**
 * Assicura che Scrapling sia installato, in un venv dedicato o già presente
 * globalmente sul sistema. Se manca, avvia l'installazione in BACKGROUND e
 * ritorna subito ready:false — una singola chiamata di 'fetch_webpage' non
 * deve bloccarsi per minuti al primo utilizzo. Ritorna il percorso del
 * binario da usare (venv se installato lì, altrimenti 'scrapling' globale).
 */
export async function ensureScraplingReady(): Promise<{ ready: boolean; message: string; binPath: string }> {
  if (await isGlobalScraplingInstalled()) {
    return { ready: true, message: 'Scrapling già installato globalmente.', binPath: 'scrapling' }
  }
  if (await isVenvScraplingInstalled()) {
    return { ready: true, message: 'Scrapling pronto.', binPath: getScraplingBinPath() }
  }

  if (starting) {
    return { ready: false, message: 'Installazione di Scrapling già in corso in background — riprova tra qualche minuto.', binPath: getScraplingBinPath() }
  }

  starting = true
  lastError = null;

  // Fire-and-forget deliberato, stesso schema di InvokeAI.
  (async () => {
    try {
      await installScrapling()
      console.log('[Scrapling] Installazione completata.')
    } catch (err: any) {
      console.error('[Scrapling] Errore installazione:', err)
      lastError = err.message || String(err)
    } finally {
      starting = false
    }
  })()

  return {
    ready: false,
    message: "Scrapling non è installato: ho avviato l'installazione automatica in background (Python isolato + scrapling[fetchers] + download browser — può richiedere qualche minuto la prima volta). Riprova questo strumento tra poco.",
    binPath: getScraplingBinPath()
  }
}

export function getScraplingLastError(): string | null {
  return lastError
}
