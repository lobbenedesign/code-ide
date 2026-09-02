import { spawn, exec } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import net from 'net'

// Servizio InvokeAI (generazione immagini locale, Stable Diffusion) — stesso
// pattern collaudato del vecchio Voice Agent (Moshi, poi rimosso perché non
// capiva l'italiano), con una differenza deliberata: qui l'installazione/avvio
// sono LAZY (solo al primo uso reale del tool 'generate_image'), non forzati
// all'avvio dell'app. Il Voice Agent forzava un download/caricamento pesante
// (~15GB su GPU) a ogni singolo avvio dell'app anche per chi non lo usa mai — un vero kernel panic
// verificato oggi ha dimostrato quanto sia rischioso farlo senza controllo.
// InvokeAI non ha bisogno di caricare un modello pesante solo per avviarsi (i
// modelli si scaricano quando l'utente ne sceglie uno dalla sua UI), quindi il
// rischio è più contenuto — ma restiamo comunque lazy per non installare mai
// alcun GB di roba a chi non genera mai un'immagine.

function waitForPort(port: number, timeoutMs: number, host = '127.0.0.1'): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const socket = net.connect(port, host)
      socket.once('connect', () => { socket.end(); resolve() })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timeout: nessun servizio in ascolto su ${host}:${port} dopo ${Math.round(timeoutMs / 1000)}s`))
        } else {
          setTimeout(tryConnect, 1000)
        }
      })
    }
    tryConnect()
  })
}

function isPortOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect(port, host)
    socket.once('connect', () => { socket.end(); resolve(true) })
    socket.once('error', () => { socket.destroy(); resolve(false) })
  })
}

function runCommand(cmd: string, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd, maxBuffer: 20 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

const basePath = path.join(os.homedir(), '.code-ide-data')
const venvPath = path.join(basePath, 'invokeai-venv')
export const INVOKEAI_PORT = 9090
export const INVOKEAI_BASE_URL = `http://127.0.0.1:${INVOKEAI_PORT}`

let invokeProcess: any = null
let starting = false
let lastError: string | null = null

// Stesso identico problema già risolto per il Voice Agent: il 'python3' di
// sistema può puntare a una versione troppo recente per avere wheel
// compatibili per pacchetti ML pesanti (verificato: Python 3.14 falliva con
// moshi_mlx con ResolutionImpossible). Python 3.12 è confermato compatibile.
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
  console.log('[InvokeAI] Nessun Python compatibile trovato, installo python@3.12 via Homebrew...')
  await runCommand('brew install python@3.12')
  return 'python3.12'
}

async function setupPythonEnv(): Promise<void> {
  const pythonBin = await findCompatiblePython()

  if (fs.existsSync(venvPath)) {
    const venvPythonVersion = await runCommand(`"${path.join(venvPath, 'bin', 'python')}" --version`).catch(() => '')
    if (!/3\.(11|12|13)\./.test(venvPythonVersion)) {
      console.log(`[InvokeAI] Venv esistente con Python incompatibile (${venvPythonVersion.trim() || 'sconosciuto'}), lo ricreo con ${pythonBin}...`)
      fs.rmSync(venvPath, { recursive: true, force: true })
    }
  }

  if (!fs.existsSync(venvPath)) {
    console.log('[InvokeAI] Creo il virtualenv Python...')
    fs.mkdirSync(basePath, { recursive: true })
    await runCommand(`${pythonBin} -m venv "${venvPath}"`)
  }

  const pipPath = path.join(venvPath, 'bin', 'pip')
  console.log('[InvokeAI] Installo InvokeAI (alcuni GB, può richiedere diversi minuti al primo avvio)...')
  await runCommand(`"${pipPath}" install --upgrade pip`)
  // --no-cache-dir: trovato un vero bug oggi con una wheel diversa (av, per il
  // Voice Agent) corrotta in cache pip in uno stato parzialmente estratto —
  // il sintomo era un crash a runtime, non un errore di installazione, quindi
  // passava inosservato. Stessa precauzione qui per sicurezza.
  await runCommand(`"${pipPath}" install --no-cache-dir invokeai`)
}

/**
 * Assicura che InvokeAI sia installato e in esecuzione. Se non lo è, avvia
 * l'installazione/avvio in BACKGROUND e ritorna subito con ready:false — una
 * singola chiamata del tool 'generate_image' non deve bloccarsi per minuti al
 * primo utilizzo. L'agente può ritentare la chiamata più tardi (nello stesso
 * task, in iterazioni successive, o in un task successivo).
 */
export async function ensureInvokeAIRunning(): Promise<{ ready: boolean; message: string }> {
  if (await isPortOpen(INVOKEAI_PORT)) {
    return { ready: true, message: 'InvokeAI già in esecuzione.' }
  }

  if (starting) {
    return { ready: false, message: 'Installazione/avvio di InvokeAI già in corso in background — riprova tra qualche minuto.' }
  }

  if (invokeProcess) {
    // Processo avviato ma la porta non risponde ancora: probabilmente sta
    // ancora inizializzando (non è pesante da caricare come il Voice Agent,
    // ma un margine di attesa breve evita falsi negativi).
    try {
      await waitForPort(INVOKEAI_PORT, 15000)
      return { ready: true, message: 'InvokeAI pronto.' }
    } catch {
      return { ready: false, message: 'InvokeAI si sta ancora avviando — riprova tra poco.' }
    }
  }

  starting = true
  lastError = null;

  // Fire-and-forget deliberato: il chiamante non aspetta l'intera installazione.
  (async () => {
    try {
      await setupPythonEnv()
      const invokeBin = path.join(venvPath, 'bin', 'invokeai-web')
      console.log('[InvokeAI] Avvio invokeai-web...')
      invokeProcess = spawn(invokeBin, [], { detached: true })
      invokeProcess.stdout?.on('data', (d: any) => console.log(`[InvokeAI] ${d}`))
      invokeProcess.stderr?.on('data', (d: any) => console.error(`[InvokeAI] ${d}`))
      invokeProcess.on('exit', () => { invokeProcess = null })
      await waitForPort(INVOKEAI_PORT, 10 * 60 * 1000)
      console.log('[InvokeAI] Pronto su ' + INVOKEAI_BASE_URL)
    } catch (err: any) {
      console.error('[InvokeAI] Errore installazione/avvio:', err)
      lastError = err.message || String(err)
      invokeProcess = null
    } finally {
      starting = false
    }
  })()

  return { ready: false, message: "InvokeAI non è installato/in esecuzione: ho avviato l'installazione automatica in background (Python 3.12 isolato + pip install invokeai — alcuni GB, può richiedere diversi minuti la prima volta). Riprova questo strumento tra qualche minuto." }
}

export function getInvokeAILastError(): string | null {
  return lastError
}

export function stopInvokeAI(): void {
  if (!invokeProcess || invokeProcess.killed) return
  try {
    process.kill(-invokeProcess.pid, 'SIGTERM')
  } catch {
    try { invokeProcess.kill('SIGTERM') } catch { /* già morto */ }
  }
  const proc = invokeProcess
  setTimeout(() => {
    try {
      if (!proc.killed) process.kill(-proc.pid, 'SIGKILL')
    } catch {
      try { if (!proc.killed) proc.kill('SIGKILL') } catch { /* già morto */ }
    }
  }, 5000)
  invokeProcess = null
  console.log('[InvokeAI] Terminato.')
}
