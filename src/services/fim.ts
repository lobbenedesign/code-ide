export async function getFimCompletion(
  prefix: string,
  suffix: string,
  model: string = 'qwen2.5-coder:latest',
  signal?: AbortSignal
): Promise<string> {
  // Costruiamo il prompt nel formato standard FIM per modelli come Qwen Coder o DeepSeek Coder
  const prompt = `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`

  try {
    const response = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // D-03 dell'audit: quando il chiamante annulla (l'utente ha già
      // digitato altro), il segnale interrompe DAVVERO la richiesta HTTP
      // verso Ollama invece di limitarsi a scartare una risposta che
      // arriverebbe comunque — niente generazioni sprecate in background
      // per suggerimenti che non verranno mai mostrati.
      signal,
      body: JSON.stringify({
        model: model,
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0.2, // Bassa temperatura per autocompletamenti precisi
          num_predict: 128 // Evitiamo che generi troppo testo
        }
      })
    })

    if (!response.ok) {
      return ''
    }

    const data = await response.json()
    return data.response || ''
  } catch (error: any) {
    if (error?.name === 'AbortError') return '' // annullata dal chiamante: non un errore da loggare
    console.error('FIM Completion Error:', error)
    return ''
  }
}
