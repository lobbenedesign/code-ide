import { BrowserWindow } from 'electron'

// Selettori "adattivi": tecnica studiata dal codice REALE di D4Vinci/Scrapling
// (scrapling/parser.py, relocate()/__calculate_similarity_score()) — non dal
// solo README. È l'unica parte di quel progetto genuinamente portabile: un
// algoritmo puro di string-similarity (Ratcliff/Obershelp, lo stesso di
// Python difflib.SequenceMatcher), senza browser stealth né dipendenze
// pesanti. Qui gira DIRETTAMENTE nella pagina reale già caricata nel Browser
// Agent (via webContents.executeJavaScript) invece che su un parser HTML
// separato (cheerio/jsdom) — più semplice e più fedele, perché legge il DOM
// renderizzato per davvero (incluse modifiche fatte da JS), non solo l'HTML
// statico iniziale.
//
// Uso concreto: un selettore CSS che l'agente usava prima ('#submit-btn')
// può smettere di combaciare dopo un hot-reload dell'app che sta sviluppando
// — invece di far fallire browser_click/browser_eval, 'browser_smart_locate'
// prova prima il selettore originale (scorciatoia veloce, come relocate() fa
// in Scrapling), e solo se non combacia più cerca l'elemento più simile nel
// DOM attuale confrontando tag/testo/attributi.

export interface ElementDescriptor {
  tagName?: string
  text?: string
  attributes?: Record<string, string>
  previousSelector?: string
}

export interface SmartLocateResult {
  found: boolean
  selector?: string
  score?: number
  boundingBox?: { x: number; y: number; width: number; height: number }
  outerHTMLSnippet?: string
  message: string
}

// Iniettata come stringa e valutata dentro alla pagina: deve essere
// autosufficiente (nessuna closure esterna), perché executeJavaScript la
// esegue in un contesto V8 separato dal processo main.
function buildInjectedScript(descriptor: ElementDescriptor): string {
  const descriptorJson = JSON.stringify(descriptor)
  return `
(function () {
  var descriptor = ${descriptorJson};

  // Scorciatoia: se il selettore precedente combacia ANCORA con esattamente
  // un elemento, non serve alcuna ricerca — è il caso comune (la pagina non
  // è cambiata) ed evita il costo O(n) della scansione completa.
  if (descriptor.previousSelector) {
    try {
      var direct = document.querySelectorAll(descriptor.previousSelector);
      if (direct.length === 1) {
        var r = direct[0].getBoundingClientRect();
        return {
          found: true,
          selector: descriptor.previousSelector,
          score: 1,
          boundingBox: { x: r.x, y: r.y, width: r.width, height: r.height },
          outerHTMLSnippet: (direct[0].outerHTML || '').slice(0, 300),
          message: 'Il selettore originale combacia ancora — nessuna ricerca adattiva necessaria.'
        };
      }
    } catch (e) {
      // selettore non più valido come sintassi CSS (raro) — prosegui con la ricerca adattiva
    }
  }

  if (!descriptor.tagName && !descriptor.text && !descriptor.attributes) {
    return { found: false, message: "Il selettore originale non combacia più e non è stato fornito altro (tagName/text/attributes) per la ricerca adattiva." };
  }

  // Ratcliff/Obershelp (lo stesso algoritmo di Python difflib.SequenceMatcher.ratio):
  // trova la sottostringa comune più lunga, poi ricorre a sinistra e a destra di essa.
  function similarity(a, b) {
    a = (a || '').toString();
    b = (b || '').toString();
    if (a === b) return 1;
    if (!a.length || !b.length) return 0;

    function longestMatch(aStart, aEnd, bStart, bEnd) {
      var bestLen = 0, bestI = aStart, bestJ = bStart;
      for (var i = aStart; i < aEnd; i++) {
        for (var j = bStart; j < bEnd; j++) {
          var k = 0;
          while (i + k < aEnd && j + k < bEnd && a[i + k] === b[j + k]) k++;
          if (k > bestLen) { bestLen = k; bestI = i; bestJ = j; }
        }
      }
      return [bestI, bestJ, bestLen];
    }

    function matchLen(aStart, aEnd, bStart, bEnd) {
      if (aStart >= aEnd || bStart >= bEnd) return 0;
      var m = longestMatch(aStart, aEnd, bStart, bEnd);
      var i = m[0], j = m[1], k = m[2];
      if (k === 0) return 0;
      return k + matchLen(aStart, i, bStart, j) + matchLen(i + k, aEnd, j + k, bEnd);
    }

    // Limite di sicurezza: l'algoritmo naive è O(n*m) per finestra ricorsiva —
    // su testi molto lunghi (es. il body di una pagina intera) tronchiamo per
    // restare rapidi, la similarità resta comunque indicativa.
    var MAX_LEN = 400;
    if (a.length > MAX_LEN) a = a.slice(0, MAX_LEN);
    if (b.length > MAX_LEN) b = b.slice(0, MAX_LEN);

    var matches = matchLen(0, a.length, 0, b.length);
    return (2.0 * matches) / (a.length + b.length);
  }

  function buildSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var path = [];
    var node = el;
    while (node && node.nodeType === 1 && path.length < 6) {
      var part = node.tagName.toLowerCase();
      if (node.classList && node.classList.length > 0) {
        part += '.' + Array.prototype.slice.call(node.classList).map(function (c) { return CSS.escape(c); }).join('.');
      }
      var parent = node.parentElement;
      if (parent) {
        var siblings = Array.prototype.filter.call(parent.children, function (s) { return s.tagName === node.tagName; });
        if (siblings.length > 1) {
          var idx = siblings.indexOf(node) + 1;
          part += ':nth-of-type(' + idx + ')';
        }
      }
      path.unshift(part);
      node = parent;
    }
    return path.join(' > ');
  }

  // Pesi: tag (segnale binario forte quando noto), testo e attributi si
  // ripartiscono il resto. Solo i segnali forniti nel descriptor contano
  // davvero — niente bonus fissi per "avere un genitore" o simili, che non
  // distinguono un elemento dall'altro e falserebbero solo il punteggio.
  var hasTag = !!descriptor.tagName;
  var hasText = !!descriptor.text;
  var attrKeys = descriptor.attributes ? Object.keys(descriptor.attributes) : [];
  var hasAttrs = attrKeys.length > 0;
  var totalWeight = (hasTag ? 0.25 : 0) + (hasText ? 0.4 : 0) + (hasAttrs ? 0.35 : 0);
  if (totalWeight === 0) totalWeight = 1;

  var allElements = Array.prototype.slice.call(document.querySelectorAll('*'));
  var best = null;
  var bestScore = -1;

  for (var idx = 0; idx < allElements.length; idx++) {
    var el = allElements[idx];
    var score = 0;

    if (hasTag) {
      score += (el.tagName.toLowerCase() === descriptor.tagName.toLowerCase() ? 1 : 0) * (0.25 / totalWeight);
    }
    if (hasText) {
      score += similarity(el.textContent && el.textContent.trim(), descriptor.text) * (0.4 / totalWeight);
    }
    if (hasAttrs) {
      var attrWeight = (0.35 / totalWeight) / attrKeys.length;
      for (var k = 0; k < attrKeys.length; k++) {
        var key = attrKeys[k];
        score += similarity(el.getAttribute(key), descriptor.attributes[key]) * attrWeight;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }

  if (!best || bestScore < 0.4) {
    return { found: false, message: 'Nessun elemento sufficientemente simile trovato (soglia 40%, migliore trovato: ' + Math.round(bestScore * 100) + '%).' };
  }

  var rect = best.getBoundingClientRect();
  return {
    found: true,
    selector: buildSelector(best),
    score: Math.round(bestScore * 100) / 100,
    boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    outerHTMLSnippet: (best.outerHTML || '').slice(0, 300),
    message: 'Elemento ritrovato con similarità ' + Math.round(bestScore * 100) + '% (il selettore originale non combaciava più).'
  };
})();
`
}

export async function smartLocateInBrowser(win: BrowserWindow, descriptor: ElementDescriptor): Promise<SmartLocateResult> {
  if (!descriptor.tagName && !descriptor.text && !descriptor.attributes && !descriptor.previousSelector) {
    return { found: false, message: "Serve almeno uno tra tagName, text, attributes o previousSelector per cercare un elemento." }
  }
  try {
    const result = await win.webContents.executeJavaScript(buildInjectedScript(descriptor))
    return result as SmartLocateResult
  } catch (error: any) {
    return { found: false, message: `Errore durante la ricerca adattiva: ${error.message}` }
  }
}
