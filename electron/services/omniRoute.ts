import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import { randomBytes } from 'crypto'
import { BrowserWindow } from 'electron'

const execAsync = promisify(exec)

export const OMNIROUTE_PORT = 20128
export const OMNIROUTE_ROOT_URL = `http://localhost:${OMNIROUTE_PORT}`
export const OMNIROUTE_API_URL = `${OMNIROUTE_ROOT_URL}/v1`

let ready = false
let ensureInFlight: Promise<void> | null = null

export function isOmniRouteReady(): boolean {
  return ready
}

/** Ritorna la base URL dell'API OpenAI-compatibile se OmniRoute è pronto, altrimenti null. */
export function getOmniRouteBaseUrl(): string | null {
  return ready ? OMNIROUTE_API_URL : null
}

async function pingOmniRoute(timeoutMs = 1500): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(OMNIROUTE_ROOT_URL, { signal: controller.signal })
    clearTimeout(timer)
    // Qualunque risposta HTTP (anche 4xx) significa che il server sta rispondendo.
    return res.status < 500
  } catch {
    return false
  }
}

async function isOmniRouteInstalled(): Promise<boolean> {
  try {
    await execAsync('omniroute --version')
    return true
  } catch {
    return false
  }
}

function sendStatus(win: BrowserWindow | null, status: string, detail?: string) {
  win?.webContents.send('omniroute-status', { status, detail })
  console.log(`[OmniRoute] ${status}${detail ? ': ' + detail : ''}`)
}

/**
 * Verifica in background se OmniRoute è raggiungibile; se manca lo installa
 * (npm install -g omniroute) e lo avvia come processo separato, con fallback
 * silenzioso a Ollama locale se qualsiasi passaggio fallisce. Non blocca mai
 * l'avvio della finestra: va chiamata senza await da main.ts.
 */
export function ensureOmniRoute(win: BrowserWindow | null): Promise<void> {
  if (ensureInFlight) return ensureInFlight

  ensureInFlight = (async () => {
    try {
      sendStatus(win, 'checking')

      if (await pingOmniRoute()) {
        ready = true
        sendStatus(win, 'ready', 'Gateway già in esecuzione')
        return
      }

      if (!(await isOmniRouteInstalled())) {
        sendStatus(win, 'installing', 'npm install -g omniroute')
        try {
          await execAsync('npm install -g omniroute', { timeout: 180000 })
        } catch (err: any) {
          sendStatus(win, 'unavailable', `Installazione OmniRoute fallita, uso fallback su Ollama locale (${err.message})`)
          return
        }
      }

      sendStatus(win, 'starting')
      // Password iniziale sicura per il primo login dashboard: senza INITIAL_PASSWORD
      // OmniRoute usa di default la stringa insicura 'CHANGEME' (nota anche per un bug
      // della sua UI che mostra "123456" invece del default reale — vedi issue #1148
      // github.com/diegosouzapw/OmniRoute). Rilevante solo alla primissima
      // inizializzazione di una istanza ~/.omniroute vuota; se esiste già non ha effetto.
      const initialPassword = randomBytes(9).toString('base64url')
      const child = spawn('omniroute', [], {
        detached: true,
        stdio: 'ignore',
        shell: true,
        env: { ...process.env, PORT: String(OMNIROUTE_PORT), INITIAL_PASSWORD: initialPassword }
      })
      child.unref()
      child.on('error', (err) => {
        console.error('[OmniRoute] Errore avvio processo:', err)
      })

      // Polling fino a 30s in attesa che il gateway risponda
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        if (await pingOmniRoute()) {
          ready = true
          sendStatus(win, 'ready', `Gateway avviato. Se richiesta al primo accesso su http://localhost:${OMNIROUTE_PORT}, la password iniziale è: ${initialPassword} (cambiala subito in Configurazione → Sicurezza)`)
          return
        }
      }

      sendStatus(win, 'unavailable', 'Timeout in avvio, uso fallback su Ollama locale')
    } catch (err: any) {
      sendStatus(win, 'unavailable', `Errore imprevisto, uso fallback su Ollama locale (${err.message})`)
    }
  })()

  return ensureInFlight
}

/** Forza un nuovo tentativo di provisioning (usato dal pulsante "Riprova" nelle Impostazioni). */
export function retryOmniRoute(win: BrowserWindow | null): Promise<void> {
  ensureInFlight = null
  ready = false
  return ensureOmniRoute(win)
}
