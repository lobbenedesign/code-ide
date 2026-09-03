import * as prettier from 'prettier'
import path from 'node:path'

const AI_COMMENT_PATTERNS = [
  // Pattern comuni dei LLM
  /^\s*\/\/\s*\.\.\.\s*existing code\s*\.\.\.\s*$/gm,
  /^\s*\/\/\s*Here is the (updated|requested).*$/gmi,
  /^\s*\/\/\s*Sure,\s*I can help.*$/gmi,
  /^\s*\/\/\s*As requested.*$/gmi,
  /^\s*<!--\s*\.\.\.\s*existing code\s*\.\.\.\s*-->\s*$/gm,
  /^\s*#\s*\.\.\.\s*existing code\s*\.\.\.\s*$/gm,
]

export type MetadataRemovalMode = 'all' | 'ai-only' | 'none'

/**
 * Sanifica il codice rimuovendo commenti tipici dell'AI e applica la formattazione Prettier.
 */
export async function sanitizeAndFormatCode(
  content: string,
  filePath: string,
  mode: MetadataRemovalMode = 'none'
): Promise<string> {
  let cleanedContent = content

  // Rimozione Metadati AI (commenti discorsivi/segnaposti)
  if (mode === 'all' || mode === 'ai-only') {
    for (const pattern of AI_COMMENT_PATTERNS) {
      cleanedContent = cleanedContent.replace(pattern, '')
    }
  }

  // Se mode è 'all', potremmo teoricamente rimuovere tutti i block comments (es. @author),
  // ma sul codice sorgente è spesso distruttivo. Lo limitiamo alla rimozione AI e formattazione pura.

  const ext = path.extname(filePath).toLowerCase()
  const supportedExtensions: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'babel',
    '.jsx': 'babel',
    '.json': 'json',
    '.css': 'css',
    '.html': 'html',
    '.md': 'markdown'
  }

  const parser = supportedExtensions[ext]
  if (!parser) {
    return cleanedContent // Ritorna così com'è per estensioni non supportate
  }

  try {
    // Cerchiamo un file di configurazione prettier nel progetto, altrimenti fallback
    const config = await prettier.resolveConfig(filePath) || {
      semi: false,
      singleQuote: true,
      printWidth: 100,
    }

    const formatted = await prettier.format(cleanedContent, {
      ...config,
      parser,
      filepath: filePath
    })
    return formatted
  } catch (err) {
    console.warn(`[codeSanitizer] Fallimento Prettier per ${filePath}:`, err)
    return cleanedContent
  }
}
