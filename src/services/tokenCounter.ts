// Stima approssimativa (non un tokenizer esatto per-modello): ~4 caratteri per
// token è l'euristica standard usata anche nella documentazione OpenAI per una
// stima rapida. Sufficiente per avvisare l'utente prima di saturare il contesto,
// non per calcoli di fatturazione.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// Finestre di contesto note per i modelli commerciali/free presenti nel menu.
// Fallback conservativo per tutto ciò che non è in tabella.
const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-3-5-sonnet': 200000,
  'gpt-4o': 128000,
  'gemini-1.5-pro': 1000000,
  'grok-2': 131072,
  'qwen-max': 32768,
  'deepseek-coder': 32768,
  'llama-3.3-70b-groq': 128000,
  'hf-inference-api': 4096,
  'z-ai': 8192,
  'sakana': 8192,
  'kimi-k3': 200000,
}

const DEFAULT_CONTEXT_WINDOW = 8192

export function getContextWindowForModel(model: string, ollamaContextLengths: Record<string, number>): number {
  if (model.startsWith('lmstudio:') || model.startsWith('local:')) {
    // Non c'è un modo standard di interrogare la context length da questi server: stima prudente.
    return DEFAULT_CONTEXT_WINDOW
  }
  if (ollamaContextLengths[model]) return ollamaContextLengths[model]
  return KNOWN_CONTEXT_WINDOWS[model] || DEFAULT_CONTEXT_WINDOW
}
