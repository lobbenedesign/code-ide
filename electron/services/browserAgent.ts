import { BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { smartLocateInBrowser, type ElementDescriptor } from './adaptiveSelector'

// Browser Agent per test visivi: una finestra Electron nascosta dedicata (Electron
// stesso è basato su Chromium, quindi è un vero browser) usata per navigare l'app
// che l'agente sta sviluppando/correggendo e verificarne il comportamento reale —
// non solo l'output di un test runner a riga di comando.
// Usiamo le API native di webContents (loadURL/capturePage/executeJavaScript/
// sendInputEvent) invece di parlare il protocollo CDP a basso livello via
// webContents.debugger: sono lo strato ufficiale e stabile che Electron espone
// sopra CDP, con lo stesso risultato pratico (navigazione, screenshot, eval, click)
// senza i rischi di compatibilità di versione del protocollo grezzo.

let agentWindow: BrowserWindow | null = null

// Questa BrowserWindow (stesso motore Chromium dell'app host, non un processo
// Chromium separato lanciabile con flag arbitrari) NON può ricevere le patch
// CDP reali di patchright — per quello serve un browser DAVVERO separato, che
// è esattamente cosa fa 'stealthBrowserAgent.ts' (browser_navigate con
// stealthy:true). Questa finestra resta il backend di default, più leggero e
// più rapido da avviare, per il caso comune: testare visivamente l'app che
// l'agente sta sviluppando in locale, dove l'anti-bot non è un problema.
// Quello che SI PUÒ fare qui a costo quasi zero è togliere il segnale più
// ovvio e gratuito che Electron regala di default: lo User-Agent include
// letteralmente il token "Electron/x.y.z", un'auto-denuncia che nessun vero
// browser manda mai.
const REALISTIC_CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function getAgentWindow(): BrowserWindow {
  if (agentWindow && !agentWindow.isDestroyed()) return agentWindow

  agentWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: { offscreen: false }
  })
  agentWindow.webContents.setUserAgent(REALISTIC_CHROME_UA)

  agentWindow.on('closed', () => { agentWindow = null })
  return agentWindow
}

export async function navigateBrowser(url: string): Promise<string> {
  const win = getAgentWindow()
  try {
    await win.loadURL(url)
    const title = win.webContents.getTitle()
    return `✅ Navigazione completata su ${url} (titolo pagina: "${title}")`
  } catch (error: any) {
    return `❌ Navigazione fallita su ${url}: ${error.message}`
  }
}

const SCREENSHOT_DIR_NAME = '.code-ide-screenshots'

export async function screenshotBrowser(cwd: string): Promise<string> {
  const win = getAgentWindow()
  try {
    const image = await win.webContents.capturePage()
    const dir = path.join(cwd, SCREENSHOT_DIR_NAME)
    fs.mkdirSync(dir, { recursive: true })
    const fileName = `screenshot-${Date.now()}.png`
    const filePath = path.join(dir, fileName)
    fs.writeFileSync(filePath, image.toPNG())
    return `✅ Screenshot salvato in ${SCREENSHOT_DIR_NAME}/${fileName}`
  } catch (error: any) {
    return `❌ Screenshot fallito: ${error.message}`
  }
}

export async function evalInBrowser(js: string): Promise<string> {
  const win = getAgentWindow()
  try {
    const result = await win.webContents.executeJavaScript(js)
    const serialized = typeof result === 'string' ? result : JSON.stringify(result)
    return `✅ Risultato: ${(serialized ?? 'undefined').toString().substring(0, 2000)}`
  } catch (error: any) {
    return `❌ Errore eval JS: ${error.message}`
  }
}

export async function clickInBrowser(x: number, y: number): Promise<string> {
  const win = getAgentWindow()
  try {
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    return `✅ Click eseguito su (${x}, ${y})`
  } catch (error: any) {
    return `❌ Click fallito: ${error.message}`
  }
}

export async function smartLocateBrowser(descriptor: ElementDescriptor): Promise<string> {
  const win = getAgentWindow()
  const result = await smartLocateInBrowser((script) => win.webContents.executeJavaScript(script), descriptor)
  if (!result.found) return `❌ ${result.message}`
  return `✅ ${result.message}\nSelettore: ${result.selector}\nBounding box: x=${Math.round(result.boundingBox!.x)}, y=${Math.round(result.boundingBox!.y)}, w=${Math.round(result.boundingBox!.width)}, h=${Math.round(result.boundingBox!.height)}\nHTML: ${result.outerHTMLSnippet}`
}

// Simulazione click per il pattern Cloudflare Turnstile studiato nel codice
// reale di Scrapling (_stealth.py: cerca l'iframe challenges.cloudflare.com,
// calcola il riquadro della checkbox, clicca con un ritardo casuale) — una
// tecnica di click-simulation genuina e a basso costo, indipendente dalle
// patch CDP che qui non possiamo replicare. Non garantisce di superare la
// sfida (dipende dal livello di rischio assegnato dalla telemetria di
// Cloudflare, che non controlliamo), ma è lo stesso tentativo che Scrapling
// stesso fa.
export async function solveCloudflareTurnstile(): Promise<string> {
  const win = getAgentWindow()
  try {
    const iframeRect = await win.webContents.executeJavaScript(`
      (function () {
        var iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
        if (!iframe) return null;
        var r = iframe.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })();
    `)
    if (!iframeRect) {
      return 'ℹ️ Nessuna sfida Cloudflare Turnstile rilevata nella pagina attuale.'
    }
    // Click vicino al centro-sinistra del riquadro (dove sta la checkbox nella
    // UI standard di Turnstile), con un piccolo offset e ritardo casuali per
    // non essere un click perfettamente deterministico.
    const x = iframeRect.x + 20 + Math.random() * 10
    const y = iframeRect.y + iframeRect.height / 2 + (Math.random() * 6 - 3)
    await new Promise(r => setTimeout(r, 100 + Math.random() * 100))
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    return `✅ Sfida Cloudflare rilevata, tentato il click sulla checkbox Turnstile (${Math.round(x)}, ${Math.round(y)}). Verifica con browser_screenshot se è stata superata.`
  } catch (error: any) {
    return `❌ Errore durante il tentativo Cloudflare: ${error.message}`
  }
}

export function closeBrowserAgent() {
  if (agentWindow && !agentWindow.isDestroyed()) {
    agentWindow.close()
  }
}
