import { BrowserWindow, session, app } from 'electron'
import { discoverDuckAiModels, getCachedOrDefaultModels, type DuckAiModel } from './duckAiDiscovery'

let duckWindow: BrowserWindow | null = null
let isPageReady = false
let pendingInit: Promise<void> | null = null

const DUCKAI_PARTITION = 'persist:duckai'

export function getDuckAiWindow(): BrowserWindow {
  if (!duckWindow || duckWindow.isDestroyed()) {
    isPageReady = false
    const ses = session.fromPartition(DUCKAI_PARTITION)
    
    // User-Agent desktop autentico
    ses.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')

    duckWindow = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      width: 780,
      height: 680,
      title: 'Duck.ai Session Bridge',
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        contextIsolation: true
      }
    })

    duckWindow.loadURL('https://duck.ai')

    duckWindow.webContents.on('did-finish-load', () => {
      // Inietta l'intercettore di rete non appena la pagina è caricata
      duckWindow?.webContents.executeJavaScript(`
        if (!window.__duckAiHooked) {
          window.__duckAiHooked = true;
          window.__duckAiLastResponse = '';
          window.__duckAiIsDone = false;
          window.__duckAiError = null;

          const origFetch = window.fetch;
          window.fetch = async function(...args) {
            const res = await origFetch.apply(this, args);
            const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
            if (url.includes('duckchat/v1/chat')) {
              window.__duckAiLastResponse = '';
              window.__duckAiIsDone = false;
              window.__duckAiError = null;

              const clone = res.clone();
              const reader = clone.body ? clone.body.getReader() : null;
              if (reader) {
                const decoder = new TextDecoder();
                (async () => {
                  try {
                    let buffer = '';
                    while (true) {
                      const { done, value } = await reader.read();
                      if (done) break;
                      buffer += decoder.decode(value, { stream: true });
                      const lines = buffer.split('\\n');
                      buffer = lines.pop() || '';
                      for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed || !trimmed.startsWith('data:')) continue;
                        const dataStr = trimmed.slice(5).trim();
                        if (dataStr === '[DONE]') {
                          window.__duckAiIsDone = true;
                          continue;
                        }
                        try {
                          const parsed = JSON.parse(dataStr);
                          if (parsed.message) {
                            window.__duckAiLastResponse += parsed.message;
                          } else if (parsed.action === 'error') {
                            window.__duckAiError = parsed.type || 'ERR_DUCKAI';
                          }
                        } catch (e) {}
                      }
                    }
                  } catch (e) {
                    console.error('Fetch intercept error:', e);
                  } finally {
                    window.__duckAiIsDone = true;
                  }
                })();
              }
            }
            return res;
          };
        }
      `).catch(() => {})

      isPageReady = true
    })

    duckWindow.on('close', (e) => {
      if (!app.isQuitting) {
        e.preventDefault()
        duckWindow?.hide()
      }
    })
  }
  return duckWindow
}

async function ensureDuckAiReady(): Promise<BrowserWindow> {
  const win = getDuckAiWindow()
  if (isPageReady) return win

  if (!pendingInit) {
    pendingInit = new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        pendingInit = null
        resolve()
      }, 15000)

      win.webContents.once('did-finish-load', () => {
        clearTimeout(timeout)
        isPageReady = true
        pendingInit = null
        resolve()
      })
    })
  }

  await pendingInit
  return win
}

export interface DuckAiChatOptions {
  model: string
  messages: Array<{ role: string, content: string | any[] }>
  tools?: any[]
  onChunk?: (token: string) => void
}

function preparePrompt(messages: Array<{ role: string, content: string | any[] }>, tools?: any[]): string {
  let prompt = ''

  if (tools && tools.length > 0) {
    const toolListStr = tools.map(t => {
      const fn = t.function || t
      return `- ${fn.name}: ${fn.description || ''}\n  Parameters: ${JSON.stringify(fn.parameters || {})}`
    }).join('\n')

    prompt += `[ISTRUZIONI DI SISTEMA PER GLI STRUMENTI]\nHai a disposizione i seguenti strumenti per eseguire il task:\n${toolListStr}\n\n` +
      `Quando decidi di invocare uno strumento, rispondi ESCLUSIVAMENTE con un blocco JSON in questo formato:\n` +
      `\`\`\`json\n{\n  "name": "nome_strumento",\n  "arguments": { ... }\n}\n\`\`\`\n` +
      `Se non devi usare strumenti, rispondi direttamente all'utente.\n[FINE ISTRUZIONI]\n\n`
  }

  for (const m of messages) {
    const roleTag = m.role === 'user' ? 'Utente' : m.role === 'assistant' ? 'Assistente' : 'Sistema'
    const textContent = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((c: any) => c.text || JSON.stringify(c)).join(' ')
        : String(m.content || '')
    
    prompt += `${roleTag}: ${textContent}\n\n`
  }

  prompt += 'Assistente: '
  return prompt
}

/**
 * Esegue una chat con Duck.ai all'interno della sessione headless di Electron
 */
export async function callDuckAiChat(options: DuckAiChatOptions): Promise<{ content: string }> {
  const win = await ensureDuckAiReady()
  const rawModel = options.model.replace(/^duckai:/, '')
  const fullPrompt = preparePrompt(options.messages, options.tools)

  // 1. Inietta il prompt ed effettua il submit nel DOM di duck.ai
  const submitResult = await win.webContents.executeJavaScript(`
    (async () => {
      // 0. Verifica e gestisci eventuale consenso o onboarding iniziale
      const onboardingBtn = document.querySelector('[data-testid="DUCKAI_ONBOARDING_AGREE"]') ||
                            Array.from(document.querySelectorAll('button')).find(b => 
                              b.innerText.includes('Accetta e continua') || b.innerText.includes('Agree and Continue')
                            );
      if (onboardingBtn) {
        onboardingBtn.click();
        await new Promise(r => setTimeout(r, 400));
      }

      // Verifica se la pagina mostra un captcha anti-bot
      const isCaptcha = document.body.innerText.includes("anche i bot usano DuckDuckGo") ||
                        document.body.innerText.includes("Seleziona tutti i riquadri");
      if (isCaptcha) {
        return { needsCaptcha: true };
      }

      // Attendi che React completi il rendering e monti la textarea (fino a 12 secondi)
      let textarea = null;
      for (let i = 0; i < 24; i++) {
        textarea = document.querySelector('textarea[name="user-prompt"]') || 
                   document.querySelector('[data-testid="duckai-chat-input"] textarea') ||
                   document.querySelector('textarea');
        if (textarea) break;
        await new Promise(r => setTimeout(r, 500));
      }

      if (!textarea) {
        return { error: "Impossibile trovare l'area di inserimento prompt su Duck.ai (timeout caricamento React)" };
      }

      // Seleziona il modello richiesto se presente
      try {
        const targetModel = ${JSON.stringify(rawModel)};
        let keyword = '';
        if (targetModel.includes('5.4-mini')) keyword = '5.4 mini';
        else if (targetModel.includes('5.6-luna')) keyword = '5.6 Luna';
        else if (targetModel.includes('haiku')) keyword = 'Haiku';
        else if (targetModel.includes('mistral')) keyword = 'Mistral';
        else if (targetModel.includes('120b') || targetModel.includes('120B')) keyword = '120B';
        else if (targetModel.includes('gemma')) keyword = 'Gemma';

        if (keyword) {
          const allButtons = Array.from(document.querySelectorAll('button'));
          const modelBtn = allButtons.find(b => 
            b.innerText.includes('Luna') || b.innerText.includes('mini') || 
            b.innerText.includes('Haiku') || b.innerText.includes('Mistral') || 
            b.innerText.includes('120B') || b.innerText.includes('Gemma')
          );
          if (modelBtn && !modelBtn.innerText.includes(keyword)) {
            modelBtn.click();
            await new Promise(r => setTimeout(r, 350));
            const options = Array.from(document.querySelectorAll('button, [role="menuitem"], [role="option"], li'));
            const match = options.find(o => o.innerText.includes(keyword));
            if (match) {
              match.click();
              await new Promise(r => setTimeout(r, 350));
            }
          }
        }
      } catch (e) {
        console.warn('Errore selezione modello:', e);
      }

      // Resetta i buffer di risposta
      window.__duckAiLastResponse = '';
      window.__duckAiIsDone = false;
      window.__duckAiError = null;

      // Imposta il valore nella textarea sincronizzando il tracker interno di React 18
      textarea.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(textarea, ${JSON.stringify(fullPrompt)});
      if (textarea._valueTracker) {
        textarea._valueTracker.setValue("");
      }
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));

      // Clicca rigorosamente il submit button APPARTENENTE AL FORM della textarea
      await new Promise(r => setTimeout(r, 200));
      const form = textarea.closest('form');
      const submitBtn = form ? form.querySelector('button[type="submit"]') : null;

      if (submitBtn && !submitBtn.disabled) {
        submitBtn.click();
      } else {
        // Fallback robusto: invio da tastiera (Enter) sul campo
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      }

      return { success: true };
    })()
  `)

  if (submitResult.needsCaptcha) {
    win.show()
    win.focus()
    win.setTitle('Verifica di sicurezza DuckDuckGo (richiesta una sola volta - risolvi per continuare)')
    throw new Error(
      'DuckDuckGo ha richiesto una verifica anti-bot temporanea. La finestra è stata aperta sullo schermo: completa la selezione e rilancia il prompt.'
    )
  }

  if (submitResult.error) {
    throw new Error(submitResult.error)
  }

  // 2. Monitora la risposta leggendo lo stream di rete o il messaggio reale nel DOM
  let lastText = ''
  let unchangedCount = 0
  const maxWaitMs = 120000
  const startTime = Date.now()

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise(resolve => setTimeout(resolve, 350))

    const poll = await win.webContents.executeJavaScript(`
      (() => {
        // Controlla se compare il captcha
        if (document.body.innerText.includes("anche i bot usano DuckDuckGo")) {
          return { captcha: true };
        }

        // 1. Prova prima con il testo reale intercettato direttamente dallo stream di rete
        if (window.__duckAiLastResponse && window.__duckAiLastResponse.trim().length > 0) {
          return { text: window.__duckAiLastResponse, isDone: !!window.__duckAiIsDone };
        }

        // Funzione per escludere categoricamente banner privacy o disclaimer legali
        const isPrivacyDisclaimer = (str) => {
          if (!str) return true;
          const s = str.toLowerCase();
          return s.includes('rende anonime') || s.includes('privacy policy') || 
                 s.includes('termini del servizio') || s.includes('anonymizes your chats') ||
                 s.includes('by clicking') || s.includes('terms of service');
        };

        // 2. Fallback nel DOM: cerca i blocchi dell'assistente che seguono l'ultimo messaggio utente
        const userMessages = document.querySelectorAll('[data-testid="user-message"]');
        let domText = '';
        if (userMessages && userMessages.length > 0) {
          const lastUser = userMessages[userMessages.length - 1];
          // Cerca il contenitore o fratello successivo contenente la risposta dell'AI
          let el = lastUser.parentElement ? lastUser.parentElement.nextElementSibling : null;
          if (!el) el = lastUser.nextElementSibling;
          
          while (el) {
            const raw = el.innerText ? el.innerText.trim() : '';
            if (raw && !isPrivacyDisclaimer(raw)) {
              domText = raw;
              break;
            }
            el = el.nextElementSibling;
          }
        }

        // Se non ancora trovato dai fratelli, cerca blocchi con attributi tipici dell'assistente
        if (!domText) {
          const chatBlocks = Array.from(document.querySelectorAll('[data-testid="chat-message"], [class*="messageContent"]'));
          for (let i = chatBlocks.length - 1; i >= 0; i--) {
            const t = chatBlocks[i].innerText.trim();
            if (t && !isPrivacyDisclaimer(t) && !t.includes(${JSON.stringify(fullPrompt.slice(0, 30))})) {
              domText = t;
              break;
            }
          }
        }

        const isGenerating = !!document.querySelector('button[aria-label*="Interrompi"]') || 
                             !!document.querySelector('button[aria-label*="Stop"]');
        
        return { text: domText, isDone: !isGenerating && domText.length > 0 };
      })()
    `)

    if (poll.captcha) {
      win.show()
      win.setTitle('Verifica di sicurezza DuckDuckGo')
      throw new Error('Verifica anti-bot DuckDuckGo richiesta. Risolvila nella finestra aperta e riprova.')
    }

    if (poll.text && poll.text !== lastText) {
      const delta = poll.text.slice(lastText.length)
      if (delta && options.onChunk) {
        options.onChunk(delta)
      }
      lastText = poll.text
      unchangedCount = 0
    } else if (lastText.length > 0) {
      unchangedCount++
    }

    if (poll.isDone && lastText.length > 0 && unchangedCount >= 2) {
      break
    }
  }

  if (win.isVisible()) {
    win.hide()
  }

  // Se dopo tutto il polling non abbiamo ricevuto nulla o solo testo vuoto, lancia un errore esplicito
  if (!lastText.trim()) {
    throw new Error('Duck.ai non ha restituito alcuna risposta valida. Verifica la connessione o riprova tra poco.')
  }

  return { content: lastText.trim() }
}
