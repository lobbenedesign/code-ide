// Rimozione dei metadati testuali che i generatori di immagini AI (Gemini,
// DALL-E, Midjourney, ecc.) incorporano come "firma"/provenienza — è per
// questo che aprendo un PNG creato dall'AI come testo grezzo si vedono
// sottostringhe leggibili tipo "http", "google", "gemini" in mezzo ai byte
// binari: sono chunk PNG di tipo testo (tEXt/iTXt/eXIf), non rumore.
// Implementazione pura JS, nessuna dipendenza nativa (niente 'sharp' o
// simili): il formato PNG/JPEG è documentato e semplice da parsare a mano,
// e qui serve solo RIMUOVERE chunk/marker interi, non ri-codificare i pixel.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// Chunk ancillari che portano SOLO metadati testuali/provenienza, mai dati
// dei pixel — sicuri da eliminare senza intaccare l'immagine visibile.
// NON tocchiamo IHDR/PLTE/IDAT/IEND (critici) né gAMA/cHRM/sRGB/iCCP/pHYs/
// tRNS/bKGD (influenzano il rendering: colore, trasparenza, dimensioni fisiche).
const PNG_METADATA_CHUNK_TYPES = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'])

export type MetadataRemovalMode = 'all' | 'ai-only'

// Firme tipiche dei generatori AI nei metadati
const AI_METADATA_SIGNATURES = ['Midjourney', 'DALL-E', 'c2pa', 'Google', 'Stable Diffusion', 'xmp', 'http://ns.adobe.com/xap/1.0/']

function isAiMetadata(chunkText: string): boolean {
  const lower = chunkText.toLowerCase()
  return AI_METADATA_SIGNATURES.some(sig => lower.includes(sig.toLowerCase()))
}

function stripPngMetadata(buffer: Buffer, mode: MetadataRemovalMode = 'all'): { output: Buffer, removedChunks: string[] } {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Non è un PNG valido (signature mancante).')
  }

  const chunks: Buffer[] = [PNG_SIGNATURE]
  const removedChunks: string[] = []
  let offset = 8

  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) break // dati troncati/corrotti: ci fermiamo qui invece di leggere oltre il buffer
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const chunkTotalLength = 4 + 4 + length + 4 // length + type + data + crc
    if (offset + chunkTotalLength > buffer.length) break // stesso caso: chunk dichiarato più lungo del file rimasto

    if (PNG_METADATA_CHUNK_TYPES.has(type)) {
      if (mode === 'all') {
        removedChunks.push(type)
      } else if (mode === 'ai-only') {
        const chunkData = buffer.toString('latin1', offset + 8, offset + 8 + length)
        if (isAiMetadata(chunkData)) {
          removedChunks.push(type)
        } else {
          chunks.push(buffer.subarray(offset, offset + chunkTotalLength))
        }
      }
    } else {
      chunks.push(buffer.subarray(offset, offset + chunkTotalLength))
    }

    offset += chunkTotalLength
    if (type === 'IEND') break
  }

  return { output: Buffer.concat(chunks), removedChunks }
}

// JPEG: sequenza di marker 0xFFxx, ognuno (tranne pochi senza payload) seguito
// da una lunghezza a 2 byte big-endian che INCLUDE i 2 byte di lunghezza
// stessi. APP1 è dove EXIF e XMP (spesso usato per il C2PA "Content
// Credentials" degli strumenti AI) vivono quasi sempre; APP13 è dove
// Photoshop/IPTC mette le sue info. SOS (Start Of Scan) segna l'inizio dei
// dati compressi veri e propri: da lì in poi NON sono più marker da parsare,
// va copiato tutto il resto così com'è.
const JPEG_METADATA_MARKERS = new Set([0xe1, 0xed, 0xfe]) // APP1, APP13, COM

function stripJpegMetadata(buffer: Buffer, mode: MetadataRemovalMode = 'all'): { output: Buffer, removedChunks: string[] } {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new Error('Non è un JPEG valido (marker SOI mancante).')
  }

  const chunks: Buffer[] = [buffer.subarray(0, 2)] // SOI
  const removedChunks: string[] = []
  let offset = 2

  while (offset + 1 < buffer.length) {
    if (buffer[offset] !== 0xff) break // stream malformato: fermiamoci invece di leggere spazzatura come marker
    const marker = buffer[offset + 1]

    // Marker senza payload (RST0-7, TEM) o inizio dati compressi: da qui la
    // struttura a marker finisce, copiamo tutto il resto senza più parsare.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xda) {
      chunks.push(buffer.subarray(offset))
      break
    }

    if (offset + 4 > buffer.length) break
    const segmentLength = buffer.readUInt16BE(offset + 2) // include i 2 byte di lunghezza stessi
    const totalLength = 2 + segmentLength // marker (2 byte) + segmentLength

    if (JPEG_METADATA_MARKERS.has(marker)) {
      if (mode === 'all') {
        removedChunks.push(`APP/COM 0xFF${marker.toString(16).toUpperCase()}`)
      } else if (mode === 'ai-only') {
        const chunkData = buffer.toString('latin1', offset + 4, offset + totalLength)
        if (isAiMetadata(chunkData)) {
          removedChunks.push(`APP/COM 0xFF${marker.toString(16).toUpperCase()}`)
        } else {
          chunks.push(buffer.subarray(offset, offset + totalLength))
        }
      }
    } else {
      chunks.push(buffer.subarray(offset, offset + totalLength))
    }

    offset += totalLength
  }

  return { output: Buffer.concat(chunks), removedChunks }
}

export function detectImageFormat(buffer: Buffer): 'png' | 'jpeg' | null {
  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png'
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpeg'
  return null
}

/** Ritorna il file SENZA i chunk/marker di metadati testuali (firma AI/provenienza inclusa), pronto per essere riscritto su disco. Non tocca un byte dei pixel. */
export function stripImageMetadata(buffer: Buffer, mode: MetadataRemovalMode = 'all'): { output: Buffer, removedChunks: string[], format: 'png' | 'jpeg' } {
  const format = detectImageFormat(buffer)
  if (format === 'png') return { ...stripPngMetadata(buffer, mode), format }
  if (format === 'jpeg') return { ...stripJpegMetadata(buffer, mode), format }
  throw new Error('Formato immagine non riconosciuto (supportati: PNG, JPEG).')
}
