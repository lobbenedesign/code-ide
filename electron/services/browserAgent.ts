import { BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

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

function getAgentWindow(): BrowserWindow {
  if (agentWindow && !agentWindow.isDestroyed()) return agentWindow

  agentWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: { offscreen: false }
  })

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

export function closeBrowserAgent() {
  if (agentWindow && !agentWindow.isDestroyed()) {
    agentWindow.close()
  }
}
