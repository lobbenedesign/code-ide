import { createRequire } from 'node:module'
import * as fs from 'fs'
import * as path from 'path'
import { smartLocateInBrowser, type ElementDescriptor } from './adaptiveSelector'

// Backend "davvero" anti-bot del Browser Agent, attivato con browser_navigate
// stealthy:true — a differenza di browserAgent.ts (una BrowserWindow di
// Electron, stesso motore Chromium dell'app host) questo lancia un vero
// processo Chromium SEPARATO via 'patchright' (fork di Playwright con le
// stesse patch anti-detection CDP di patchright-python, usato realmente da
// D4Vinci/Scrapling — qui in versione Node, npm 'patchright', stessa API di
// Playwright). Verificato dal vivo: navigator.webdriver risulta false (con
// Playwright liscio sarebbe true), la patch è quindi davvero attiva.
//
// patchright è CJS puro (nessun "type":"module" nel suo package.json) —
// createRequire() basta, stesso pattern di node-pty/better-sqlite3, non serve
// il trucco @vite-ignore usato per i pacchetti ESM-puri come ppu-paddle-ocr.
const require = createRequire(import.meta.url)

let browserPromise: Promise<any> | null = null
let pagePromise: Promise<any> | null = null

// Un vero browser Chrome installato (channel 'chrome') è un fingerprint più
// convincente del Chromium di test bundlato con patchright — se l'utente ha
// Chrome installato lo si usa, altrimenti si ricade sul Chromium scaricato da
// 'npx patchright install chromium'. Headless: un browser headed sarebbe più
// stealth ancora, ma questo tool gira in background durante run autonomi
// dell'agente — aprire una finestra visibile a sorpresa sarebbe un'esperienza
// intrusiva, scelta consapevole a favore dell'headless "new" (già patchato
// per non essere distinguibile a livello CDP, verificato: navigator.webdriver = false).
async function getBrowser(): Promise<any> {
  if (!browserPromise) {
    browserPromise = (async () => {
      const patchright = require('patchright') as typeof import('patchright')
      try {
        return await patchright.chromium.launch({ headless: true, channel: 'chrome' })
      } catch {
        // Chrome non installato sulla macchina: ricadi sul Chromium bundlato.
        return await patchright.chromium.launch({ headless: true })
      }
    })().catch(err => {
      browserPromise = null
      throw err
    })
  }
  return browserPromise
}

// L'headless "new" di Chromium/Chrome è già patchato da patchright a livello
// CDP (verificato: navigator.webdriver = false), ma lo User-Agent di default
// contiene comunque il token "HeadlessChrome" — un segnale testuale gratuito
// che un vero browser non manda mai, tolto qui esattamente come già si fa
// per la BrowserWindow di Electron in browserAgent.ts.
const REALISTIC_CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

async function getPage(): Promise<any> {
  if (!pagePromise) {
    pagePromise = (async () => {
      const browser = await getBrowser()
      const page = await browser.newPage({ userAgent: REALISTIC_CHROME_UA })
      return page
    })().catch(err => {
      pagePromise = null
      throw err
    })
  }
  return pagePromise
}

export async function navigateStealthBrowser(url: string): Promise<string> {
  try {
    const page = await getPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    const title = await page.title()
    return `✅ Navigazione stealth completata su ${url} (titolo pagina: "${title}") — browser Chromium separato con patch anti-detection (patchright), non la BrowserWindow di Electron.`
  } catch (error: any) {
    return `❌ Navigazione stealth fallita su ${url}: ${error.message}`
  }
}

const SCREENSHOT_DIR_NAME = '.code-ide-screenshots'

export async function screenshotStealthBrowser(cwd: string): Promise<string> {
  try {
    const page = await getPage()
    const buffer = await page.screenshot()
    const dir = path.join(cwd, SCREENSHOT_DIR_NAME)
    fs.mkdirSync(dir, { recursive: true })
    const fileName = `screenshot-stealth-${Date.now()}.png`
    const filePath = path.join(dir, fileName)
    fs.writeFileSync(filePath, buffer)
    return `✅ Screenshot (stealth) salvato in ${SCREENSHOT_DIR_NAME}/${fileName}`
  } catch (error: any) {
    return `❌ Screenshot stealth fallito: ${error.message}`
  }
}

export async function evalInStealthBrowser(js: string): Promise<string> {
  try {
    const page = await getPage()
    const result = await page.evaluate(js)
    const serialized = typeof result === 'string' ? result : JSON.stringify(result)
    return `✅ Risultato: ${(serialized ?? 'undefined').toString().substring(0, 2000)}`
  } catch (error: any) {
    return `❌ Errore eval JS stealth: ${error.message}`
  }
}

export async function clickInStealthBrowser(x: number, y: number): Promise<string> {
  try {
    const page = await getPage()
    await page.mouse.click(x, y)
    return `✅ Click stealth eseguito su (${x}, ${y})`
  } catch (error: any) {
    return `❌ Click stealth fallito: ${error.message}`
  }
}

export async function smartLocateStealthBrowser(descriptor: ElementDescriptor): Promise<string> {
  const page = await getPage()
  const result = await smartLocateInBrowser((script) => page.evaluate(script), descriptor)
  if (!result.found) return `❌ ${result.message}`
  return `✅ ${result.message}\nSelettore: ${result.selector}\nBounding box: x=${Math.round(result.boundingBox!.x)}, y=${Math.round(result.boundingBox!.y)}, w=${Math.round(result.boundingBox!.width)}, h=${Math.round(result.boundingBox!.height)}\nHTML: ${result.outerHTMLSnippet}`
}

// Stessa tecnica di clic euristico sulla checkbox Turnstile di
// browserAgent.ts (studiata dal codice reale di Scrapling), ma qui gira su un
// browser che DAVVERO non espone i segnali CDP che tradiscono l'automazione
// — la combinazione delle due cose (patch CDP + click umanizzato) è il
// tentativo più fedele possibile a Scrapling stesso senza Python.
export async function solveCloudflareTurnstileStealthBrowser(): Promise<string> {
  try {
    const page = await getPage()
    const iframeRect = await page.evaluate(`
      (function () {
        var iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
        if (!iframe) return null;
        var r = iframe.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })();
    `)
    if (!iframeRect) {
      return 'ℹ️ Nessuna sfida Cloudflare Turnstile rilevata nella pagina attuale (stealth).'
    }
    const x = iframeRect.x + 20 + Math.random() * 10
    const y = iframeRect.y + iframeRect.height / 2 + (Math.random() * 6 - 3)
    await new Promise(r => setTimeout(r, 100 + Math.random() * 100))
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.up()
    return `✅ Sfida Cloudflare rilevata (stealth), tentato il click sulla checkbox Turnstile (${Math.round(x)}, ${Math.round(y)}). Verifica con browser_screenshot se è stata superata.`
  } catch (error: any) {
    return `❌ Errore durante il tentativo Cloudflare (stealth): ${error.message}`
  }
}

export async function closeStealthBrowserAgent(): Promise<void> {
  try {
    if (browserPromise) {
      const browser = await browserPromise
      await browser.close()
    }
  } catch {
    // già chiuso o mai avviato — niente da fare
  } finally {
    browserPromise = null
    pagePromise = null
  }
}
