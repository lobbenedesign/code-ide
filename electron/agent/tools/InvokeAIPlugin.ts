import * as fs from 'fs'
import * as path from 'path'
import { ensureInvokeAIRunning, INVOKEAI_BASE_URL } from '../../services/invokeAIService'

// Tool di generazione immagini (Stable Diffusion via InvokeAI). La struttura
// del grafo qui sotto (MainModelLoaderInvocation → CompelInvocation ×2 →
// NoiseInvocation → DenoiseLatentsInvocation → LatentsToImageInvocation) è
// verificata contro lo schema OpenAPI REALE di un'istanza InvokeAI 6.14.0
// avviata dal vivo stanotte (nomi/tipi dei campi confermati, non indovinati).
// Quello che NON è stato verificato end-to-end: il round-trip completo
// submit→attesa→immagine reale, perché farlo richiede scaricare un modello
// Stable Diffusion (diversi GB, calcolo GPU pesante) — esattamente la stessa
// categoria di operazione che ha causato un kernel panic reale in questa
// sessione con il Voice Agent. Per questo generate_image controlla PRIMA che
// almeno un modello sia installato e restituisce un messaggio chiaro se non
// lo è, invece di tentare una generazione alla cieca.
export const GenerateImageToolDefinition = {
  type: 'function' as const,
  function: {
    name: 'generate_image',
    description: "Genera un'immagine reale (icona, asset, mockup, illustrazione) da una descrizione testuale usando InvokeAI (Stable Diffusion) in esecuzione localmente, e la salva come file nel progetto. Al primo utilizzo può richiedere l'installazione automatica di InvokeAI in background (alcuni minuti) o l'installazione di un modello Stable Diffusion dall'utente (richiede la sua scelta, non automatizzabile) — se risponde che è in corso o serve un modello, informane l'utente invece di ritentare in loop.",
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: "Descrizione testuale dell'immagine da generare." },
        outputPath: { type: 'string', description: 'Percorso relativo al progetto dove salvare il file immagine generato (es. "assets/icon.png").' },
        width: { type: 'number', description: 'Larghezza in pixel (default 512, deve essere multiplo di 8).' },
        height: { type: 'number', description: 'Altezza in pixel (default 512, deve essere multiplo di 8).' },
        negativePrompt: { type: 'string', description: 'Cosa evitare nella generazione (opzionale).' }
      },
      required: ['prompt', 'outputPath']
    }
  }
}

interface InvokeModel {
  key: string
  hash: string
  name: string
  base: string
  type: string
}

async function getFirstMainModel(): Promise<InvokeModel | null> {
  const res = await fetch(`${INVOKEAI_BASE_URL}/api/v2/models/`)
  if (!res.ok) return null
  const data = await res.json()
  const models: InvokeModel[] = data.models || []
  return models.find(m => m.type === 'main') || null
}

function buildTxt2ImgGraph(model: InvokeModel, prompt: string, negativePrompt: string, width: number, height: number) {
  const modelField = { key: model.key, hash: model.hash, name: model.name, base: model.base, type: model.type }

  return {
    id: 'txt2img_graph',
    nodes: {
      model_loader: { id: 'model_loader', type: 'main_model_loader', model: modelField },
      positive_conditioning: { id: 'positive_conditioning', type: 'compel', prompt },
      negative_conditioning: { id: 'negative_conditioning', type: 'compel', prompt: negativePrompt },
      noise: { id: 'noise', type: 'noise', width, height },
      denoise: { id: 'denoise', type: 'denoise_latents', steps: 30, cfg_scale: 7.5, scheduler: 'euler' },
      l2i: { id: 'l2i', type: 'l2i' }
    },
    edges: [
      { source: { node_id: 'model_loader', field: 'clip' }, destination: { node_id: 'positive_conditioning', field: 'clip' } },
      { source: { node_id: 'model_loader', field: 'clip' }, destination: { node_id: 'negative_conditioning', field: 'clip' } },
      { source: { node_id: 'positive_conditioning', field: 'conditioning' }, destination: { node_id: 'denoise', field: 'positive_conditioning' } },
      { source: { node_id: 'negative_conditioning', field: 'conditioning' }, destination: { node_id: 'denoise', field: 'negative_conditioning' } },
      { source: { node_id: 'noise', field: 'noise' }, destination: { node_id: 'denoise', field: 'noise' } },
      { source: { node_id: 'model_loader', field: 'unet' }, destination: { node_id: 'denoise', field: 'unet' } },
      { source: { node_id: 'denoise', field: 'latents' }, destination: { node_id: 'l2i', field: 'latents' } },
      { source: { node_id: 'model_loader', field: 'vae' }, destination: { node_id: 'l2i', field: 'vae' } }
    ]
  }
}

async function pollQueueItem(itemId: number, timeoutMs: number): Promise<any> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${INVOKEAI_BASE_URL}/api/v1/queue/default/i/${itemId}`)
    if (res.ok) {
      const item = await res.json()
      if (item.status === 'completed' || item.status === 'failed' || item.status === 'canceled') {
        return item
      }
    }
    await new Promise(r => setTimeout(r, 2000))
  }
  throw new Error(`Timeout: generazione non completata dopo ${Math.round(timeoutMs / 1000)}s`)
}

export async function executeGenerateImage(args: { prompt: string, outputPath: string, width?: number, height?: number, negativePrompt?: string }, cwd: string): Promise<string> {
  const status = await ensureInvokeAIRunning()
  if (!status.ready) return status.message

  try {
    const model = await getFirstMainModel()
    if (!model) {
      return `⚠️ InvokeAI è in esecuzione ma non c'è alcun modello Stable Diffusion installato. Apri ${INVOKEAI_BASE_URL} e installane uno dal pannello Modelli (scelta che spetta all'utente — stili/dimensioni diversi hanno bisogno di modelli diversi), poi riprova.`
    }

    const width = args.width || 512
    const height = args.height || 512
    const graph = buildTxt2ImgGraph(model, args.prompt, args.negativePrompt || '', width, height)

    const enqueueRes = await fetch(`${INVOKEAI_BASE_URL}/api/v1/queue/default/enqueue_batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batch: { graph, runs: 1 }, prepend: false })
    })
    if (!enqueueRes.ok) {
      const errBody = await enqueueRes.text().catch(() => '')
      return `❌ InvokeAI ha rifiutato la richiesta di generazione (${enqueueRes.status}): ${errBody.slice(0, 500)}`
    }
    const enqueueData = await enqueueRes.json()
    const itemId = enqueueData.item_ids?.[0]
    if (itemId === undefined) {
      return `❌ Risposta inattesa da InvokeAI: nessun item_id nella coda. ${JSON.stringify(enqueueData).slice(0, 300)}`
    }

    const finished = await pollQueueItem(itemId, 5 * 60 * 1000)
    if (finished.status !== 'completed') {
      return `❌ Generazione fallita (${finished.status}): ${finished.error_message || '(nessun dettaglio)'}`
    }

    // Il nome dell'immagine risultante vive nei risultati di sessione sotto il
    // nodo l2i — la forma esatta (results['l2i'].image.image_name) è quella
    // documentata da InvokeAI per questo tipo di nodo di output immagine.
    const imageName = finished.session?.results?.l2i?.image?.image_name
    if (!imageName) {
      return `⚠️ Generazione completata ma non sono riuscito a individuare il nome dell'immagine nella risposta di InvokeAI (formato risultati inatteso — verificalo tu stesso su ${INVOKEAI_BASE_URL}). Risposta grezza: ${JSON.stringify(finished.session?.results || {}).slice(0, 500)}`
    }

    const imageRes = await fetch(`${INVOKEAI_BASE_URL}/api/v1/images/i/${imageName}/full`)
    if (!imageRes.ok) {
      return `❌ Immagine generata (${imageName}) ma il download è fallito (${imageRes.status}).`
    }
    const buffer = Buffer.from(await imageRes.arrayBuffer())

    const targetPath = path.isAbsolute(args.outputPath) ? args.outputPath : path.join(cwd, args.outputPath)
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.writeFileSync(targetPath, buffer)

    return `✅ Immagine generata e salvata in ${args.outputPath} (${width}x${height}, modello: ${model.name}).`
  } catch (error: any) {
    return `❌ Errore durante la generazione dell'immagine: ${error.message}`
  }
}
