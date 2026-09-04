import * as fs from 'fs'
import * as path from 'path'
import * as os from 'node:os'

export interface DuckAiModel {
  id: string
  label: string
  description?: string
  supportsReasoning?: boolean
  isBeta?: boolean
}

// Fallback hardcoded garantito e verificato se la rete non è disponibile
export const DEFAULT_DUCKAI_MODELS: DuckAiModel[] = [
  { id: 'gpt-5.6-luna', label: 'DuckAI: GPT-5.6 Luna', description: 'Best for everyday use' },
  { id: 'gpt-5.4-mini', label: 'DuckAI: GPT-5.4 mini', description: 'Solid but hits limits sooner', supportsReasoning: true },
  { id: 'claude-haiku-4-5', label: 'DuckAI: Claude Haiku 4.5', description: 'Solid but hits limits sooner' },
  { id: 'mistral-small-2603', label: 'DuckAI: Mistral Small 4', description: 'Veloce ed efficiente' },
  { id: 'tinfoil/gpt-oss-120b', label: 'DuckAI: gpt-oss 120B', description: 'Open-weights 120B' },
  { id: 'tinfoil/gemma4-31b', label: 'DuckAI: Gemma 4 31B (Beta)', description: 'Google Gemma 4', isBeta: true }
]

function getCachePath(): string {
  try {
    const { app } = require('electron')
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'duck_models_cache.json')
    }
  } catch {}
  return path.join(os.tmpdir(), 'duck_models_cache.json')
}

function formatLabel(id: string): string {
  if (id === 'gpt-5.6-luna') return 'DuckAI: GPT-5.6 Luna'
  if (id === 'gpt-5.4-mini') return 'DuckAI: GPT-5.4 mini'
  if (id === 'claude-haiku-4-5') return 'DuckAI: Claude Haiku 4.5'
  if (id.includes('mistral-small')) return 'DuckAI: Mistral Small 4'
  if (id.includes('gpt-oss-120b')) return 'DuckAI: gpt-oss 120B'
  if (id.includes('gemma')) return 'DuckAI: Gemma 4 31B (Beta)'

  // Generico per futuri modelli aggiunti da DuckDuckGo
  const cleanId = id.replace(/^tinfoil\//, '')
  return `DuckAI: ${cleanId}`
}

/**
 * Scansiona in background https://duck.ai per estrarre la lista dei modelli correntemente attivi
 */
export async function discoverDuckAiModels(): Promise<DuckAiModel[]> {
  try {
    const htmlRes = await fetch('https://duck.ai', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      }
    })
    if (!htmlRes.ok) throw new Error(`HTTP ${htmlRes.status}`)
    const html = await htmlRes.text()

    // Cerca lo script di entry point del bundle duckai
    const scriptMatch = html.match(/src="(\/dist\/duckai-dist\/entry\.duckai\.[^"]+\.js)"/)
    if (!scriptMatch) throw new Error('Bundle entry non trovato nell\'HTML di duck.ai')

    const bundleUrl = `https://duck.ai${scriptMatch[1]}`
    const jsRes = await fetch(bundleUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      }
    })
    if (!jsRes.ok) throw new Error(`HTTP ${jsRes.status} scaricando bundle`)
    const js = await jsRes.text()

    // Estrae l'array dei modelli liberi es. ["gpt-5.4-mini","gpt-5.6-luna",...]
    const modelsMatch = js.match(/\["gpt-5\.4-mini"[^\]]+\]/)
    if (!modelsMatch) throw new Error('Pattern modelli non trovato nel bundle JS')

    const modelIds: string[] = JSON.parse(modelsMatch[0])
    const discovered: DuckAiModel[] = modelIds.map(id => ({
      id,
      label: formatLabel(id),
      supportsReasoning: id.includes('5.4-mini') || id.includes('luna'),
      isBeta: id.includes('gemma')
    }))

    // Salva in cache
    const cacheFile = getCachePath()
    try {
      fs.writeFileSync(cacheFile, JSON.stringify(discovered, null, 2), 'utf-8')
    } catch (e) {
      console.warn('[duckAiDiscovery] Impossibile salvare cache:', e)
    }

    return discovered
  } catch (err: any) {
    console.warn('[duckAiDiscovery] Auto-discovery fallito, uso cache o fallback:', err.message)
    return getCachedOrDefaultModels()
  }
}

export function getCachedOrDefaultModels(): DuckAiModel[] {
  const cacheFile = getCachePath()
  if (fs.existsSync(cacheFile)) {
    try {
      const data = fs.readFileSync(cacheFile, 'utf-8')
      const parsed = JSON.parse(data)
      if (Array.isArray(parsed) && parsed.length > 0) return parsed
    } catch {
      // Ignora e usa default
    }
  }
  return DEFAULT_DUCKAI_MODELS
}
