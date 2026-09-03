import { navigateBrowser, screenshotBrowser, evalInBrowser, clickInBrowser, smartLocateBrowser, solveCloudflareTurnstile } from '../../services/browserAgent'
import { navigateStealthBrowser, screenshotStealthBrowser, evalInStealthBrowser, clickInStealthBrowser, smartLocateStealthBrowser, solveCloudflareTurnstileStealthBrowser } from '../../services/stealthBrowserAgent'

// Quale dei due backend rispondono agli altri tool browser_* (screenshot/
// eval/click/smart_locate/solve_cloudflare) dopo l'ultimo browser_navigate —
// deciso lì da 'stealthy', non da un parametro ripetuto su ogni chiamata
// successiva: il modello naviga una volta e poi opera sulla STESSA sessione,
// esattamente come già succede con la BrowserWindow singola di browserAgent.ts.
let activeBackend: 'electron' | 'stealth' = 'electron'

export const BrowserToolDefinitions = [
  {
    type: 'function' as const,
    function: {
      name: 'browser_navigate',
      description: "Apre un URL in un vero browser — usalo per testare visivamente l'app web su cui stai lavorando, es. 'http://localhost:3000' del suo server di sviluppo, oppure per navigare un sito esterno. Poi usa 'browser_screenshot' per vedere il risultato, 'browser_eval' per ispezionare il DOM, 'browser_click' per interagire: tutti operano sull'ultima pagina aperta con questo tool, nella stessa sessione. Imposta stealthy:true SOLO se il sito è protetto da anti-bot/Cloudflare e sospetti che una finestra Electron normale verrebbe rilevata — usa un browser Chromium/Chrome SEPARATO con patch anti-detection reali (patchright, la stessa tecnica di D4Vinci/Scrapling), più lento da avviare la prima volta.",
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL completo da aprire.' },
          stealthy: { type: 'boolean', description: "true per usare il backend anti-bot (Chromium/Chrome separato con patch CDP reali) invece della finestra Electron normale. Resta attivo per tutte le chiamate browser_* successive finché non richiami browser_navigate senza stealthy o con stealthy:false.", default: false }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_screenshot',
      description: "Cattura uno screenshot reale della pagina attualmente caricata nel browser (dopo 'browser_navigate') e lo salva come prova visiva nel progetto (cartella .code-ide-screenshots/). Usalo per verificare che una modifica UI abbia davvero l'effetto voluto, non solo che il codice compili.",
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_eval',
      description: "Esegue JavaScript nella pagina attualmente caricata nel browser e ne restituisce il risultato — usalo per leggere testo/attributi del DOM, verificare lo stato di un elemento, o controllare errori in console senza uno screenshot.",
      parameters: {
        type: 'object',
        properties: { code: { type: 'string', description: "Espressione JavaScript da valutare nella pagina (es. \"document.querySelector('h1').textContent\")." } },
        required: ['code']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_click',
      description: "Simula un click del mouse in coordinate pixel precise sulla pagina attualmente caricata nel browser. Usa 'browser_screenshot' prima per capire dove cliccare.",
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Coordinata X in pixel.' },
          y: { type: 'number', description: 'Coordinata Y in pixel.' }
        },
        required: ['x', 'y']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_smart_locate',
      description: "Ritrova un elemento nella pagina anche se il selettore CSS usato prima non combacia più (es. dopo un hot-reload che ha cambiato l'HTML) — algoritmo di similarità (tag/testo/attributi) studiato da D4Vinci/Scrapling, non un semplice retry del selettore. Usalo quando 'browser_eval'/'browser_click' con un vecchio selettore falliscono inaspettatamente, invece di rifare uno 'browser_screenshot' e indovinare nuove coordinate a mano.",
      parameters: {
        type: 'object',
        properties: {
          previousSelector: { type: 'string', description: 'Il selettore CSS che funzionava prima e ora sospetti non funzioni più (provato per primo come scorciatoia).' },
          tagName: { type: 'string', description: "Tag HTML atteso dell'elemento (es. 'button'), se noto." },
          text: { type: 'string', description: "Testo visibile atteso dell'elemento, se noto." },
          attributes: { type: 'object', description: "Attributi attesi come coppie chiave/valore (es. {\"class\": \"btn-primary\", \"data-testid\": \"submit\"}), se noti." }
        }
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_solve_cloudflare',
      description: "Tenta di superare una sfida Cloudflare Turnstile (la checkbox 'Verifica che sei un umano') sulla pagina attualmente caricata, cliccandola con un ritardo/offset casuali — tecnica studiata da D4Vinci/Scrapling. Non garantita: Cloudflare può comunque bloccare in base ad altri segnali di rischio, soprattutto se l'ultimo browser_navigate non ha usato stealthy:true (una finestra Electron normale è più facilmente rilevata a monte, prima ancora che questo tool clicchi qualcosa). Usa 'browser_screenshot' dopo per verificare l'esito.",
      parameters: { type: 'object', properties: {} }
    }
  }
]

export async function executeBrowserTool(functionName: string, args: any, cwd: string): Promise<string> {
  switch (functionName) {
    case 'browser_navigate':
      activeBackend = args.stealthy ? 'stealth' : 'electron'
      return activeBackend === 'stealth' ? navigateStealthBrowser(args.url) : navigateBrowser(args.url)
    case 'browser_screenshot':
      return activeBackend === 'stealth' ? screenshotStealthBrowser(cwd) : screenshotBrowser(cwd)
    case 'browser_eval':
      return activeBackend === 'stealth' ? evalInStealthBrowser(args.code) : evalInBrowser(args.code)
    case 'browser_click':
      return activeBackend === 'stealth' ? clickInStealthBrowser(args.x, args.y) : clickInBrowser(args.x, args.y)
    case 'browser_smart_locate': {
      const descriptor = { previousSelector: args.previousSelector, tagName: args.tagName, text: args.text, attributes: args.attributes }
      return activeBackend === 'stealth' ? smartLocateStealthBrowser(descriptor) : smartLocateBrowser(descriptor)
    }
    case 'browser_solve_cloudflare':
      return activeBackend === 'stealth' ? solveCloudflareTurnstileStealthBrowser() : solveCloudflareTurnstile()
    default:
      return `Strumento browser non riconosciuto: ${functionName}`
  }
}
