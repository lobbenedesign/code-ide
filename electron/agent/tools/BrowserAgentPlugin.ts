import { navigateBrowser, screenshotBrowser, evalInBrowser, clickInBrowser, smartLocateBrowser, solveCloudflareTurnstile } from '../../services/browserAgent'

export const BrowserToolDefinitions = [
  {
    type: 'function' as const,
    function: {
      name: 'browser_navigate',
      description: "Apre un URL in un vero browser (finestra Chromium nascosta) — usalo per testare visivamente l'app web su cui stai lavorando, es. 'http://localhost:3000' del suo server di sviluppo. Poi usa 'browser_screenshot' per vedere il risultato o 'browser_eval' per ispezionare il DOM.",
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'URL completo da aprire.' } },
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
      description: "Tenta di superare una sfida Cloudflare Turnstile (la checkbox 'Verifica che sei un umano') sulla pagina attualmente caricata, cliccandola con un ritardo/offset casuali — tecnica studiata da D4Vinci/Scrapling. Non garantita: Cloudflare può comunque bloccare in base ad altri segnali di rischio. Usa 'browser_screenshot' dopo per verificare l'esito.",
      parameters: { type: 'object', properties: {} }
    }
  }
]

export async function executeBrowserTool(functionName: string, args: any, cwd: string): Promise<string> {
  switch (functionName) {
    case 'browser_navigate':
      return navigateBrowser(args.url)
    case 'browser_screenshot':
      return screenshotBrowser(cwd)
    case 'browser_eval':
      return evalInBrowser(args.code)
    case 'browser_click':
      return clickInBrowser(args.x, args.y)
    case 'browser_smart_locate':
      return smartLocateBrowser({ previousSelector: args.previousSelector, tagName: args.tagName, text: args.text, attributes: args.attributes })
    case 'browser_solve_cloudflare':
      return solveCloudflareTurnstile()
    default:
      return `Strumento browser non riconosciuto: ${functionName}`
  }
}
