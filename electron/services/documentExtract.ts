import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// pdf-parse v2 e mammoth sono entrambi CJS-compatibili (pdf-parse ha
// "type":"module" nel package.json ma il suo "main" punta a un file .cjs,
// che sovrascrive il type a livello di singolo file per le regole Node) —
// require() diretto funziona, niente bisogno del trucco @vite-ignore usato
// per i pacchetti ESM-puri come ppu-paddle-ocr/ppu-doclayout.
let pdfParseModule: typeof import('pdf-parse') | null = null
let mammothModule: typeof import('mammoth') | null = null

function getPdfParse() {
  if (!pdfParseModule) pdfParseModule = require('pdf-parse')
  return pdfParseModule!
}

function getMammoth() {
  if (!mammothModule) mammothModule = require('mammoth')
  return mammothModule!
}

/** Estrae il testo da un PDF o DOCX dato il suo Buffer grezzo. Ritorna testo semplice, pronto per essere iniettato nel contesto della chat. */
export async function extractDocumentText(buffer: Buffer, fileName: string): Promise<{ text: string, warning?: string }> {
  const ext = fileName.toLowerCase().split('.').pop()

  if (ext === 'pdf') {
    const { PDFParse } = getPdfParse()
    const parser = new PDFParse({ data: buffer })
    try {
      const result = await parser.getText()
      return { text: result.text.trim() }
    } finally {
      await parser.destroy?.()
    }
  }

  if (ext === 'docx') {
    const mammoth = getMammoth()
    const result = await mammoth.extractRawText({ buffer })
    const warning = result.messages.length > 0
      ? `(${result.messages.length} avviso/i di conversione: ${result.messages.slice(0, 3).map((m: any) => m.message).join('; ')})`
      : undefined
    return { text: result.value.trim(), warning }
  }

  throw new Error(`Estensione non supportata per l'estrazione: .${ext} (solo .pdf e .docx)`)
}
