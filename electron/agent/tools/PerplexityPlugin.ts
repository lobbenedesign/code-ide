import * as dotenv from 'dotenv'

dotenv.config()

export const PerplexityToolDefinition = {
  type: 'function' as const,
  function: {
    name: 'web_search',
    description: "Esegue una ricerca web aggiornata in tempo reale tramite Perplexity AI, con citazioni delle fonti. Usa questo tool quando serve un'informazione che potrebbe essere cambiata dopo il training del modello (versioni di librerie, notizie, documentazione recente, prezzi, disponibilità di API) — NON per domande di programmazione generiche che già conosci.",
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'La domanda o i termini di ricerca da inviare a Perplexity.'
        }
      },
      required: ['query']
    }
  }
}

export async function executeWebSearch(args: { query: string }): Promise<string> {
  const apiKey = process.env.PERPLEXITY_API_KEY
  if (!apiKey) {
    return "Errore: Variabile d'ambiente PERPLEXITY_API_KEY non trovata. Aggiungila al file .env nella root del progetto per abilitare la ricerca web (https://www.perplexity.ai/settings/api)."
  }

  try {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          { role: 'system', content: 'Sii conciso e preciso. Includi fatti verificabili e, quando disponibili, versioni/date esatte.' },
          { role: 'user', content: args.query }
        ]
      })
    })

    if (!response.ok) {
      const errText = await response.text()
      return `❌ Errore Perplexity API (${response.status}): ${errText.substring(0, 500)}`
    }

    const data = await response.json()
    const content = data.choices?.[0]?.message?.content || '(nessuna risposta)'
    const citations: string[] = data.citations || []

    let result = `🔎 Risultato ricerca web:\n${content}`
    if (citations.length > 0) {
      result += `\n\nFonti:\n${citations.map((c, i) => `[${i + 1}] ${c}`).join('\n')}`
    }
    return result
  } catch (error: any) {
    return `❌ Errore durante la ricerca web: ${error.message}`
  }
}
