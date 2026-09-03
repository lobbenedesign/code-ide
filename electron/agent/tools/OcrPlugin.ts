import * as fs from 'fs'
import { resolveTargetPath } from './fileWriteUtils'

// ppu-paddle-ocr è un pacchetto ESM-puro ("type": "module" nel suo
// package.json) — createRequire() lo farebbe fallire a runtime con
// ERR_REQUIRE_ESM (il trucco usato per node-pty/better-sqlite3, entrambi
// CJS, non si applica qui). Serve invece un vero dynamic import(), ma con lo
// specifier costruito da variabile: rolldown (il bundler del processo main)
// tenta comunque di analizzare staticamente un import() con stringa
// letterale anche se il pacchetto è in rollupOptions.external, e fallisce
// aprendo un binario .node interno (@napi-rs/canvas) come se fosse testo
// UTF-8. Una stringa non letterale + /* @vite-ignore */ lo rende invisibile
// all'analisi statica, lasciandolo come vero import() dinamico a runtime.
const OCR_PACKAGE_NAME = 'ppu-paddle-ocr'
const DOCLAYOUT_PACKAGE_NAME = 'ppu-doclayout'

// OCR nativo (nessun subprocess Python, a differenza di Scrapling/InvokeAI):
// scelto dopo due passate di ricerca approfondita sul codice/licenze reali
// dei principali progetti OCR gratuiti su GitHub (PaddleOCR, EasyOCR, docTR,
// Surya, MinerU, olmOCR, Tesseract, ecc.) — 'ppu-paddle-ocr' (MIT, npm) è
// l'unico pacchetto che fa girare i modelli PP-OCRv6 di PaddleOCR
// direttamente via ONNX Runtime dentro Node/Electron, senza Python né un
// runtime GPU pesante, con un'accuratezza misurata nettamente superiore a
// Tesseract (che quindi non viene affiancato come "livello leggero": qui
// l'opzione più leggera è già la più accurata). La struttura righe/colonne
// delle tabelle viene ricostruita col pacchetto complementare 'ppu-doclayout'
// (stesso autore, stessa famiglia di dipendenze) — vedi reconstructTableMarkdown più sotto.
export const OcrToolDefinition = {
  type: 'function' as const,
  function: {
    name: 'ocr_image',
    description: "Estrae il testo REALE da un'immagine (screenshot, foto di un documento, scansione) usando OCR locale (PaddleOCR via ONNX, nessun servizio cloud). Utile per leggere testo in immagini che 'read_file' non può interpretare. I modelli si scaricano automaticamente al primo utilizzo. Se l'immagine contiene una o più tabelle, la struttura righe/colonne viene rilevata (via ppu-doclayout) e ricostruita come tabella Markdown, oltre al testo semplice.",
    parameters: {
      type: 'object',
      properties: {
        imagePath: { type: 'string', description: "Percorso assoluto o relativo al progetto dell'immagine da leggere (.png, .jpg, .jpeg, .webp)." }
      },
      required: ['imagePath']
    }
  }
}

// Servizio inizializzato pigramente e riusato tra chiamate — l'inizializzazione
// carica i modelli ONNX (costosa la prima volta), le chiamate successive nello
// stesso processo la riusano invece di ripagarla ogni volta.
let servicePromise: Promise<any> | null = null

async function getOcrService(): Promise<any> {
  if (!servicePromise) {
    servicePromise = (async () => {
      const mod = await import(/* @vite-ignore */ OCR_PACKAGE_NAME) as typeof import('ppu-paddle-ocr')
      // 'canvas-native' invece del motore 'opencv' di default: quest'ultimo
      // richiede OpenCV.js (via ppu-ocv) con una propria inizializzazione
      // WASM — verificato con un vero test che falliva ("image.getContext is
      // not a function") nell'ambiente Electron/Node di questo progetto.
      // canvas-native è più leggero e non ha quella dipendenza aggiuntiva;
      // il costo dichiarato dalla libreria stessa è un riconoscimento dei
      // riquadri di testo leggermente meno preciso, accettabile per l'uso
      // previsto qui (estrarre testo, non analisi geometrica del layout).
      const service = new mod.PaddleOcrService({ processing: { engine: 'canvas-native' } })
      await service.initialize()
      return service
    })().catch(err => {
      servicePromise = null // permette di ritentare a una chiamata successiva invece di restare rotto per sempre
      throw err
    })
  }
  return servicePromise
}

// Servizio di layout inizializzato pigramente come quello OCR — stesso motivo
// (ppu-doclayout è ESM-puro, stesso trucco @vite-ignore) e stesso pattern
// "riusa tra chiamate, azzera se l'init fallisce".
let layoutServicePromise: Promise<any> | null = null

async function getLayoutService(): Promise<any> {
  if (!layoutServicePromise) {
    layoutServicePromise = (async () => {
      const mod = await import(/* @vite-ignore */ DOCLAYOUT_PACKAGE_NAME) as typeof import('ppu-doclayout')
      const service = new mod.DocLayoutService()
      await service.initialize()
      return service
    })().catch(err => {
      layoutServicePromise = null
      throw err
    })
  }
  return layoutServicePromise
}

const SUPPORTED_EXTENSIONS = /\.(png|jpe?g|webp|bmp)$/i

type OcrItem = { text: string, box: { x: number, y: number, width: number, height: number } }

// ppu-doclayout localizza SOLO il riquadro di ogni tabella (box [x1,y1,x2,y2]),
// non la griglia di celle — non è un modello di table-structure-recognition.
// Ricostruiamo righe/colonne geometricamente: prendiamo le righe di testo già
// riconosciute da ppu-paddle-ocr (con le loro coordinate reali) che cadono
// dentro quel riquadro, le raggruppiamo in righe per vicinanza verticale del
// centro (soglia = metà dell'altezza mediana dei box, per tollerare un lieve
// disallineamento tipico dell'OCR), e ordiniamo ogni riga da sinistra a destra.
// È un'euristica geometrica, non un vero riconoscimento di celle unite/divise,
// ma preserva l'informazione che il solo testo concatenato perdeva del tutto.
// Riconoscimento intestazione/riga totale via keyword matching (italiano +
// inglese) — suggerito da una sessione parallela su GARE-OS dopo un
// confronto diretto: quel progetto usa Docling/TableFormer per una vera
// griglia di celle, non portabile qui senza uno stack Python pesante e fuori
// scope. QUESTA parte però è pura logica di stringhe (alias di nomi colonna
// + pattern "totale/sommano/riporto"), esattamente come in GARE-OS
// (computo_comune.py::individua_intestazione/e_riga_di_totale) — nessun
// modello ML coinvolto, quindi genuinamente portabile senza nuove dipendenze.
const HEADER_COLUMN_ALIASES: RegExp[] = [
  /\b(codice|cod\.?|art\.?|articolo)\b/i,
  /\b(descrizione|descriz\.?|voce|oggetto)\b/i,
  /\b(quantit[aà]|qt[aà]\.?|q\.\s?t[aà]\.?|qty)\b/i,
  /\b(u\.?\s?m\.?|unit[aà] di misura|udm|unit)\b/i,
  /\b(prezzo\s?unit\.?|p\.?\s?u\.?|price)\b/i,
  /\b(importo|totale\s?riga|amount|total)\b/i,
  /\b(name|nome|city|citt[aà]|age|et[aà])\b/i
]
const TOTAL_ROW_PATTERN = /\b(totale\s?generale|totale\s?complessivo|totale|sommano|riporto|somma|grand\s?total|subtotal)\b/i

// Prime 3 righe soltanto: un'intestazione oltre quella profondità in una
// tabella già piccola (il caso tipico qui, uno screenshot/foto) è più
// probabile un falso positivo che una vera intestazione multi-riga.
function detectHeaderRowIndex(grid: string[][]): number | null {
  for (let i = 0; i < Math.min(grid.length, 3); i++) {
    const matches = grid[i].filter(cell => HEADER_COLUMN_ALIASES.some(re => re.test(cell))).length
    if (matches >= 2) return i
  }
  return null
}

function detectTotalRowIndices(grid: string[][]): number[] {
  const indices: number[] = []
  grid.forEach((row, i) => {
    if (row.some(cell => TOTAL_ROW_PATTERN.test(cell))) indices.push(i)
  })
  return indices
}

function reconstructTableMarkdown(items: OcrItem[]): string {
  if (items.length === 0) return '(nessun testo riconosciuto dentro il riquadro tabella)'

  const heights = items.map(i => i.box.height).sort((a, b) => a - b)
  const medianHeight = heights[Math.floor(heights.length / 2)] || 10
  const rowThreshold = Math.max(medianHeight * 0.6, 4)

  const sorted = [...items].sort((a, b) => (a.box.y + a.box.height / 2) - (b.box.y + b.box.height / 2))
  const rows: OcrItem[][] = []
  for (const item of sorted) {
    const centerY = item.box.y + item.box.height / 2
    const lastRow = rows[rows.length - 1]
    if (lastRow) {
      const lastCenterY = lastRow[0].box.y + lastRow[0].box.height / 2
      if (Math.abs(centerY - lastCenterY) <= rowThreshold) {
        lastRow.push(item)
        continue
      }
    }
    rows.push([item])
  }

  const grid = rows.map(row => row.sort((a, b) => a.box.x - b.box.x).map(cell => cell.text.replace(/\|/g, '\\|')))
  const colCount = Math.max(...grid.map(r => r.length))

  const headerRowIndex = detectHeaderRowIndex(grid)
  const totalRowIndices = new Set(detectTotalRowIndices(grid))
  // Un separatore Markdown va comunque dopo la prima riga per sintassi
  // valida, sia o meno una vera intestazione riconosciuta — dichiarato
  // esplicitamente sotto quando non lo è, invece di far credere che lo sia.
  const separatorRowIndex = headerRowIndex ?? 0

  const lines: string[] = []
  grid.forEach((row, i) => {
    const padded = [...row, ...Array(colCount - row.length).fill('')]
    const isTotalRow = totalRowIndices.has(i)
    const cells = isTotalRow ? padded.map(c => c ? `**${c}**` : c) : padded
    lines.push(`| ${cells.join(' | ')} |`)
    if (i === separatorRowIndex) lines.push(`|${' --- |'.repeat(colCount)}`)
  })

  const notes: string[] = []
  if (headerRowIndex === null) {
    notes.push('_Nessuna intestazione riconosciuta con certezza (nessuna riga combacia con almeno 2 nomi di colonna noti) — la prima riga è trattata come intestazione solo per la sintassi della tabella, non è una rilevazione reale._')
  }
  if (totalRowIndices.size > 0) {
    notes.push(`_Riga/e totale rilevata/e (in **grassetto** sopra): ${[...totalRowIndices].map(i => `riga ${i + 1}`).join(', ')}._`)
  }

  return notes.length > 0 ? `${lines.join('\n')}\n\n${notes.join('\n')}` : lines.join('\n')
}

export async function executeOcrImage(args: { imagePath: string }, cwd: string): Promise<string> {
  try {
    const targetPath = resolveTargetPath(cwd, args.imagePath)

    if (!fs.existsSync(targetPath)) {
      return `❌ Immagine non trovata: ${args.imagePath}`
    }
    if (!SUPPORTED_EXTENSIONS.test(targetPath)) {
      return `❌ Formato non supportato: ${args.imagePath} (usa .png, .jpg, .jpeg, .webp o .bmp).`
    }

    const service = await getOcrService()
    // La versione Node installata (nonostante l'esempio del README mostri
    // 'service.recognize("./file.jpg")') richiede davvero un ArrayBuffer o un
    // oggetto Canvas — verificato leggendo il codice sorgente reale del
    // pacchetto (processor/paddle-ocr.service.js): un percorso stringa cade
    // nel branch che presume un Canvas e fallisce con "image.getContext is
    // not a function", perché una stringa non ha quel metodo.
    const buffer = fs.readFileSync(targetPath)
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    const result = await service.recognize(arrayBuffer, { flatten: true })
    const text = (result?.text || '').trim()

    if (!text) {
      return `⚠️ OCR completato ma nessun testo trovato in ${args.imagePath} (immagine senza testo leggibile, o troppo a bassa risoluzione).`
    }

    // Rilevamento tabelle: fallimento non fatale, il testo semplice sopra è
    // già un risultato valido di per sé — se il layout model non è
    // disponibile o l'immagine non contiene tabelle, restituiamo solo quello.
    let tablesSection = ''
    try {
      const layoutService = await getLayoutService()
      const arrayBuffer2 = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
      const layoutResult = await layoutService.analyze(arrayBuffer2)
      const tableBoxes = layoutResult.boxes.filter((b: any) => b.label === 'table')

      if (tableBoxes.length > 0) {
        const ocrItems: OcrItem[] = (result.results || []).map((r: any) => ({ text: r.text, box: r.box }))
        const tableMarkdowns = tableBoxes.map((tb: any, idx: number) => {
          const [x1, y1, x2, y2] = tb.box
          const itemsInTable = ocrItems.filter(item => {
            const cx = item.box.x + item.box.width / 2
            const cy = item.box.y + item.box.height / 2
            return cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2
          })
          return `**Tabella ${idx + 1}** (confidenza rilevamento: ${(tb.score * 100).toFixed(0)}%)\n\n${reconstructTableMarkdown(itemsInTable)}`
        })
        tablesSection = `\n\n---\n\n📊 ${tableBoxes.length} tabella/e rilevata/e, struttura ricostruita:\n\n${tableMarkdowns.join('\n\n')}`
      }
    } catch (layoutError: any) {
      tablesSection = `\n\n⚠️ Rilevamento struttura tabelle non riuscito (${layoutError.message}) — sopra resta comunque il testo semplice completo.`
    }

    return `📄 Testo estratto da ${args.imagePath}:\n\n${text}${tablesSection}`
  } catch (error: any) {
    return `❌ Errore durante l'OCR: ${error.message} (al primo utilizzo il download del modello può richiedere qualche secondo — se l'errore persiste riprova).`
  }
}
