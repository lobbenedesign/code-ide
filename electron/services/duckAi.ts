import { BrowserWindow, session, app } from 'electron'
import { discoverDuckAiModels, getCachedOrDefaultModels, type DuckAiModel } from './duckAiDiscovery'

let duckWindow: BrowserWindow | null = null
let isPageReady = false
let pendingInit: Promise<void> | null = null
let isChallengeTriggered = false

const DUCKAI_PARTITION = 'persist:duckai'

function logToUI(level: 'info' | 'warn' | 'error' | 'net' | 'success', message: string, details?: any) {
  try {
    const allWins = BrowserWindow.getAllWindows()
    const mainWin = allWins.find(w => w !== duckWindow && !w.isDestroyed())
    if (mainWin) {
      mainWin.webContents.send('app-debug-log', {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: new Date().toLocaleTimeString(),
        level,
        category: 'DuckAI',
        message,
        details
      })
    }
  } catch {}
}

export function getDuckAiWindow(): BrowserWindow {
  if (!duckWindow || duckWindow.isDestroyed()) {
    isPageReady = false
    isChallengeTriggered = false
    const ses = session.fromPartition(DUCKAI_PARTITION)
    
    // User-Agent desktop autentico
    ses.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')

    // Intercetta a livello di rete per rilevare infallibilmente il 418 ERR_CHALLENGE
    ses.webRequest.onCompleted((details) => {
      if (details.url.includes('duckchat/v1/chat')) {
        console.log('[DuckAi Net]', details.statusCode, details.method, details.url)
        if (details.statusCode === 418) {
          isChallengeTriggered = true
          console.log('[DuckAi Net] ⚠️ Rilevato 418 ERR_CHALLENGE: verifica anti-bot richiesta!')
          logToUI('warn', '⚠️ Ricevuto HTTP 418 ERR_CHALLENGE da DuckDuckGo: richiesta verifica anti-bot (selezione anatre).')
        } else if (details.statusCode === 200) {
          isChallengeTriggered = false
          console.log('[DuckAi Net] ✅ Richiesta chat completata con successo (200 OK)')
          logToUI('net', '✅ Connessione stream DuckDuckGo stabilita con successo (HTTP 200 OK).')
        } else {
          logToUI('net', `HTTP ${details.statusCode} su ${details.url}`)
        }
      }
    })

    duckWindow = new BrowserWindow({
      show: false,
      width: 860,
      height: 740,
      title: 'Duck.ai Session Bridge',
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        contextIsolation: true
      }
    })

    logToUI('info', 'Inizializzazione sessione e caricamento di https://duck.ai...')
    duckWindow.loadURL('https://duck.ai')

    duckWindow.webContents.on('did-finish-load', () => {
      injectNetworkInterceptor(duckWindow!)
      isPageReady = true
      console.log('[DuckAi] Pagina duck.ai caricata e pronta.')
      logToUI('info', 'Pagina duck.ai caricata e bridge di rete pronto.')
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

function injectNetworkInterceptor(win: BrowserWindow) {
  win.webContents.executeJavaScript(`
    if (!window.__duckAiHooked) {
      window.__duckAiHooked = true;
      window.__duckAiLastResponse = '';
      window.__duckAiDelta = '';
      window.__duckAiIsDone = false;
      window.__duckAiError = null;

      const origFetch = window.fetch;
      window.fetch = async function(...args) {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        const res = await origFetch.apply(this, args);
        if (url.includes('duckchat/v1/chat')) {
          if (res.status === 200) {
            window.__duckAiLastResponse = '';
            window.__duckAiDelta = '';
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
                          window.__duckAiDelta += parsed.message;
                        } else if (parsed.action === 'error') {
                          window.__duckAiError = parsed.type || 'ERR_DUCKAI';
                        }
                      } catch (e) {}
                    }
                  }
                } catch (e) {
                  console.error('[DuckAi] Stream read error:', e);
                } finally {
                  window.__duckAiIsDone = true;
                }
              })();
            }
          }
        }
        return res;
      };
    }
  `).catch(() => {})
}

async function ensureDuckAiReady(): Promise<BrowserWindow> {
  const win = getDuckAiWindow()
  if (isPageReady) {
    injectNetworkInterceptor(win)
    return win
  }

  if (!pendingInit) {
    pendingInit = new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        pendingInit = null
        resolve()
      }, 15000)

      win.webContents.once('did-finish-load', () => {
        clearTimeout(timeout)
        injectNetworkInterceptor(win)
        isPageReady = true
        pendingInit = null
        resolve()
      })
    })
  }

  await pendingInit
  return win
}

/**
 * Controlla se a schermo è visibile la sfida visiva del captcha DuckDuckGo
 */
export async function isChallengeModalVisible(win: BrowserWindow): Promise<boolean> {
  try {
    return await win.webContents.executeJavaScript(`
      (() => {
        const text = document.body ? document.body.innerText : '';
        const hasChallengeText = text.includes('Sfortunatamente, anche i bot') || 
                                 text.includes('Seleziona tutti i riquadri') ||
                                 text.includes('Completa la seguente sfida');
        const hasDialog = !!document.querySelector('[role="dialog"]') && text.includes('anatra');
        return hasChallengeText || hasDialog;
      })()
    `)
  } catch {
    return false
  }
}

/**
 * Mostra la finestra di verifica per l'utente, mantenendola aperta finché non
 * risolve la selezione delle anatre e preme Invia.
 */
export async function openDuckAiVerification(win?: BrowserWindow): Promise<boolean> {
  const targetWin = win || await ensureDuckAiReady()
  console.log('[DuckAi] 🦆 Apertura finestra verifica anti-bot per l\'utente...')
  logToUI('warn', '🦆 Apertura finestra per la verifica anti-bot: seleziona i riquadri con le anatre e clicca Invia.')
  
  targetWin.show()
  targetWin.focus()
  targetWin.center()
  targetWin.setAlwaysOnTop(true, 'floating')
  setTimeout(() => {
    if (targetWin && !targetWin.isDestroyed()) targetWin.setAlwaysOnTop(false)
  }, 2500)
  targetWin.setTitle('🦆 Duck.ai: Risolvi la sfida (Seleziona le anatre e premi Invia - si chiuderà da sola)')

  return new Promise<boolean>((resolve) => {
    let checkTimer: NodeJS.Timeout | null = null

    const cleanup = () => {
      if (checkTimer) clearInterval(checkTimer)
    }

    checkTimer = setInterval(async () => {
      if (targetWin.isDestroyed()) {
        cleanup()
        resolve(false)
        return
      }

      // Se l'utente ha chiuso volontariamente la finestra
      if (!targetWin.isVisible()) {
        cleanup()
        logToUI('info', 'Finestra di verifica chiusa dall\'utente.')
        resolve(false)
        return
      }

      const active = await isChallengeModalVisible(targetWin)
      if (!active && !isChallengeTriggered) {
        console.log('[DuckAi] ✅ Sfida anti-bot risolta con successo!')
        logToUI('success', '✅ Sfida anti-bot risolta con successo! Finestra nascosta, ripresa chat in corso...')
        cleanup()
        setTimeout(() => {
          if (!targetWin.isDestroyed()) targetWin.hide()
        }, 1000)
        resolve(true)
      }
    }, 700)
  })
}

export interface DuckAiChatOptions {
  model: string
  messages: Array<{ role: string, content: string | any[] }>
  tools?: any[]
  onChunk?: (token: string) => void
}

function preparePrompt(messages: Array<{ role: string, content: string | any[] }>): string {
  // Prendi gli ultimi messaggi di conversazione (fino a 10) escludendo il dump di tool o repo-map
  const recent = messages.filter(m => m.role !== 'system').slice(-10)
  
  // Se c'è solo un messaggio utente, invialo pulito senza prefissi
  if (recent.length === 1 && recent[0].role === 'user') {
    const textContent = typeof recent[0].content === 'string'
      ? recent[0].content
      : Array.isArray(recent[0].content)
        ? recent[0].content.map((c: any) => c.text || JSON.stringify(c)).join(' ')
        : String(recent[0].content || '')
    return textContent.trim()
  }

  let prompt = ''
  for (const m of recent) {
    const roleTag = m.role === 'user' ? 'Utente' : 'Assistente'
    const textContent = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((c: any) => c.text || JSON.stringify(c)).join(' ')
        : String(m.content || '')
    
    if (textContent.trim()) {
      prompt += `${roleTag}: ${textContent.trim()}\n\n`
    }
  }

  prompt += 'Assistente: '
  return prompt.trim()
}

/**
 * Esegue una chat con Duck.ai all'interno della sessione di Electron
 */
export async function callDuckAiChat(options: DuckAiChatOptions): Promise<{ content: string }> {
  const win = await ensureDuckAiReady()
  const rawModel = options.model.replace(/^duckai:/, '')
  const fullPrompt = preparePrompt(options.messages)

  console.log(`[DuckAi] Avvio chat con modello: "${rawModel}", prompt: "${fullPrompt.slice(0, 80)}"`)
  logToUI('info', `Avvio richiesta per modello "${rawModel}" con prompt: "${fullPrompt.slice(0, 70)}..."`)

  // 0. Se c'è già una richiesta captcha bloccata sulla pagina, aprila all'utente
  if (isChallengeTriggered || await isChallengeModalVisible(win)) {
    options.onChunk?.('🦆 [Verifica anti-bot DuckDuckGo richiesta: completa la selezione nella finestra aperta sullo schermo...]\n')
    await openDuckAiVerification(win)
    await new Promise(r => setTimeout(r, 1200))
  }

  // 1. Inietta il prompt ed effettua il submit nel DOM di duck.ai
  const submitResult = await win.webContents.executeJavaScript(`
    (async () => {
      // 0. Accetta onboarding se presente
      const onboardingBtn = Array.from(document.querySelectorAll('button')).find(b => 
        b.innerText.includes('Accetta e continua') || b.innerText.includes('Agree and Continue') ||
        b.innerText.includes('Inizia') || b.innerText.includes('Get Started')
      );
      if (onboardingBtn) {
        onboardingBtn.click();
        await new Promise(r => setTimeout(r, 400));
      }

      // Attendi la presenza della textarea
      let textarea = null;
      for (let i = 0; i < 24; i++) {
        textarea = document.querySelector('textarea[name="user-prompt"]') || 
                   document.querySelector('textarea');
        if (textarea) break;
        await new Promise(r => setTimeout(r, 500));
      }

      if (!textarea) {
        return { error: "Impossibile trovare l'area di inserimento prompt su Duck.ai" };
      }

      // Seleziona il modello richiesto se presente. A differenza della
      // versione precedente, qui il risultato viene VERIFICATO (rileggendo
      // il testo del pulsante dopo il click) invece di essere dato per
      // scontato — un click che non ha colpito la voce di menu giusta
      // lasciava silenziosamente attivo il modello precedente, con l'utente
      // che vedeva risposte firmate da un modello diverso da quello scelto.
      let modelSwitch = { attempted: false, confirmed: false, keyword: '', buttonTextBefore: '', buttonTextAfter: '' };
      try {
        const targetModel = ${JSON.stringify(rawModel)};
        let keyword = '';
        if (targetModel.includes('5.4-mini')) keyword = '5.4 mini';
        else if (targetModel.includes('5.6-luna') || targetModel.includes('luna')) keyword = '5.6 Luna';
        else if (targetModel.includes('haiku')) keyword = 'Haiku';
        else if (targetModel.includes('mistral')) keyword = 'Mistral';
        else if (targetModel.includes('120b') || targetModel.includes('120B')) keyword = '120B';
        else if (targetModel.includes('gemma')) keyword = 'Gemma';
        modelSwitch.keyword = keyword;

        if (keyword) {
          const allButtons = Array.from(document.querySelectorAll('button'));
          const modelBtn = allButtons.find(b =>
            b.getAttribute('aria-haspopup') === 'menu' &&
            (b.innerText.includes('Luna') || b.innerText.includes('mini') ||
             b.innerText.includes('Mistral') || b.innerText.includes('120B') ||
             b.innerText.includes('Gemma') || b.innerText.includes('Haiku'))
          );
          modelSwitch.buttonTextBefore = modelBtn ? modelBtn.innerText : '(pulsante modello non trovato)';

          if (modelBtn && !modelBtn.innerText.toLowerCase().includes(keyword.toLowerCase())) {
            modelSwitch.attempted = true;
            modelBtn.click();
            await new Promise(r => setTimeout(r, 400));
            const menuItems = Array.from(document.querySelectorAll('[role="menuitemradio"], [role="menuitem"], button'));
            const targetItem = menuItems.find(m => m.innerText.toLowerCase().includes(keyword.toLowerCase()));
            if (targetItem) {
              targetItem.click();
              await new Promise(r => setTimeout(r, 400));
            }
            // Rilettura del pulsante DOPO il click: solo questo conferma che
            // il cambio sia riuscito davvero, non solo che sia stato tentato.
            // Verificato dal vivo: una lettura singola a 400ms può cadere in
            // uno stato transitorio del re-render (il pulsante esiste ma
            // il suo innerText è momentaneamente vuoto, non "sbagliato") —
            // quindi si ritenta per qualche centinaio di ms invece di
            // dichiarare fallimento sulla prima lettura vuota/non combaciante.
            let textAfter = '';
            for (let i = 0; i < 8; i++) {
              const btn = Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-haspopup') === 'menu');
              textAfter = btn ? btn.innerText : '';
              if (textAfter && textAfter.toLowerCase().includes(keyword.toLowerCase())) break;
              await new Promise(r => setTimeout(r, 250));
            }
            modelSwitch.buttonTextAfter = textAfter || '(pulsante modello vuoto o non trovato dopo il click, anche dopo aver riprovato per 2s)';
            modelSwitch.confirmed = textAfter.toLowerCase().includes(keyword.toLowerCase());
          } else if (modelBtn) {
            // Il modello giusto era già attivo: nessun click necessario, ma è comunque una conferma valida.
            modelSwitch.confirmed = true;
            modelSwitch.buttonTextAfter = modelBtn.innerText;
          }
        }
      } catch (e) {
        console.warn('[DuckAi] Errore selezione modello:', e);
      }

      // Resetta i buffer di risposta
      window.__duckAiLastResponse = '';
      window.__duckAiDelta = '';
      window.__duckAiIsDone = false;
      window.__duckAiError = null;

      // Imposta il valore nella textarea sincronizzando il tracker interno di React
      textarea.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(textarea, ${JSON.stringify(fullPrompt)});
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));

      // Attendi che il submit button sia abilitato da React
      const form = textarea.closest('form');
      let submitBtn = form ? form.querySelector('button[type="submit"]') : null;

      let waitCount = 0;
      while (submitBtn && submitBtn.disabled && waitCount < 30) {
        await new Promise(r => setTimeout(r, 100));
        waitCount++;
      }

      if (submitBtn && !submitBtn.disabled) {
        submitBtn.click();
        return { success: true, method: 'click', modelSwitch };
      } else {
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        return { success: true, method: 'enter_key', modelSwitch };
      }
    })()
  `)

  // Se il cambio modello era necessario ma non è stato confermato dal DOM,
  // meglio fermarsi qui con un errore chiaro che l'utente può notare e
  // segnalare, invece di procedere in silenzio e fargli leggere una
  // risposta firmata da un modello diverso da quello scelto — esattamente
  // il bug segnalato dal vivo (selezionato "gemma", risposta ancora firmata
  // "gpt-5.6-luna" perché lo switch non era mai realmente riuscito).
  const ms = submitResult.modelSwitch
  if (ms?.attempted && !ms.confirmed) {
    const msg = `Cambio modello non riuscito: richiesto "${ms.keyword}", il selettore mostrava ancora "${ms.buttonTextAfter}" dopo il click (era "${ms.buttonTextBefore}"). Duck.ai potrebbe aver cambiato la struttura del suo menu modelli.`
    console.warn('[DuckAi]', msg)
    logToUI('warn', msg)
    throw new Error(msg)
  }
  if (ms?.keyword) {
    logToUI('info', `Modello confermato attivo su Duck.ai: "${ms.buttonTextAfter || ms.buttonTextBefore}"`)
  }

  if (submitResult.error) {
    logToUI('error', `Errore inserimento prompt: ${submitResult.error}`)
    throw new Error(submitResult.error)
  }

  console.log('[DuckAi] Prompt inviato al form:', submitResult, 'inizio monitoraggio risposta...')
  logToUI('info', `Prompt inviato al form web Duck.ai (${submitResult.method}), in attesa della risposta...`)

  // 2. Monitora la risposta leggendo lo stream di rete o il messaggio reale nel DOM
  let lastText = ''
  let unchangedCount = 0
  const maxWaitMs = 120000
  const startTime = Date.now()

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise(resolve => setTimeout(resolve, 350))

    // Se si attiva la sfida anti-bot, apri subito la finestra all'utente
    if (isChallengeTriggered || await isChallengeModalVisible(win)) {
      options.onChunk?.('\n🦆 [Verifica anti-bot DuckDuckGo richiesta: completa la selezione nella finestra aperta sullo schermo...]\n')
      const solved = await openDuckAiVerification(win)
      console.log('[DuckAi] Risoluzione sfida completata:', solved)

      // Dopo la risoluzione attendi per dare tempo a Duck.ai di riprovare automaticamente
      await new Promise(r => setTimeout(r, 1200))

      // Se non sta generando, prova a ricliccare submit
      await win.webContents.executeJavaScript(`
        (() => {
          const isGenerating = !!document.querySelector('button[aria-label*="Interrompi"]') || 
                               !!document.querySelector('button[aria-label*="Stop"]');
          if (!isGenerating) {
            const form = document.querySelector('form');
            const submitBtn = form ? form.querySelector('button[type="submit"]') : null;
            if (submitBtn && !submitBtn.disabled) {
              submitBtn.click();
            }
          }
        })()
      `).catch(() => {})
    }

    const poll = await win.webContents.executeJavaScript(`
      (() => {
        // 1. Prova prima con il testo reale intercettato dallo stream di rete
        const netText = window.__duckAiLastResponse || '';
        const delta = window.__duckAiDelta || '';
        window.__duckAiDelta = '';

        if (netText && netText.trim().length > 0) {
          return {
            text: netText,
            delta,
            isDone: !!window.__duckAiIsDone,
            source: 'network'
          };
        }

        // Funzione per escludere categoricamente banner privacy o disclaimer legali
        const isPrivacyDisclaimer = (str) => {
          if (!str) return true;
          const s = str.toLowerCase();
          return s.includes('rende anonime') || s.includes('privacy policy') || 
                 s.includes('termini del servizio') || s.includes('anonymizes your chats') ||
                 s.includes('by clicking') || s.includes('terms of service') ||
                 s.includes('sfortunatamente, anche i bot') || s.includes('seleziona tutti i riquadri');
        };

        // 2. Fallback nel DOM: cerca i blocchi dell'assistente che seguono l'ultimo messaggio utente
        const userMessages = document.querySelectorAll('[data-testid="user-message"]');
        let domText = '';
        if (userMessages && userMessages.length > 0) {
          const lastUser = userMessages[userMessages.length - 1];
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
        
        return {
          text: domText,
          delta: '',
          isDone: !isGenerating && domText.length > 0,
          source: 'dom'
        };
      })()
    `)

    if (poll.text && poll.text !== lastText) {
      const delta = poll.delta || poll.text.slice(lastText.length)
      if (delta && options.onChunk) {
        options.onChunk(delta)
      }
      lastText = poll.text
      unchangedCount = 0

      // Se la finestra era visibile per la verifica, nascondila non appena i token arrivano
      if (win.isVisible()) {
        win.hide()
      }
    } else if (lastText.length > 0) {
      unchangedCount++
    }

    if (poll.isDone && lastText.length > 0 && unchangedCount >= 2) {
      console.log('[DuckAi] Generazione completata con successo, lunghezza:', lastText.length)
      logToUI('success', `Generazione completata con successo da Duck.ai (${lastText.length} caratteri).`)
      break
    }
  }

  if (win.isVisible()) {
    win.hide()
  }

  if (!lastText.trim()) {
    logToUI('error', 'Duck.ai non ha restituito alcuna risposta valida entro il timeout.')
    throw new Error('Duck.ai non ha restituito alcuna risposta valida. Verifica la connessione o riprova tra poco.')
  }

  return { content: lastText.trim() }
}
