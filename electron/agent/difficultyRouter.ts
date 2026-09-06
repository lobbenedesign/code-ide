// N-04 dell'audit: instradamento in base alla difficoltà. Deep Reasoning
// (MCTS / Supreme Court in deepReasoning.ts, 3 candidati generati in
// parallelo + un giudice che li confronta) esiste già da tempo, ma finora
// l'utente doveva ricordarsi di attivarlo a mano per OGNI task complesso —
// e per un task davvero semplice ("rinomina questa variabile") lo stesso
// toggle avrebbe solo triplicato costo e latenza senza alcun beneficio
// reale. Questo modulo aggiunge una terza opzione "Automatico": una stima
// EURISTICA e locale (nessuna chiamata LLM per decidere se chiamarne una —
// sarebbe assurdo) della difficoltà del prompt, per decidere da sola quando
// vale la pena pagare il costo di Deep Reasoning.
//
// Deliberatamente NON un instradamento tra modelli diversi (es. locale
// veloce vs. API costosa): la lista di modelli disponibili è troppo
// eterogenea e in gran parte già scelta esplicitamente dall'utente nel
// menu a tendina (vedi AiChat.tsx) per provare a sostituirla in automatico
// senza sorprese. Instradare invece tra "esecuzione diretta" e "Deep
// Reasoning" *con lo stesso modello* riusa un meccanismo già esistente e
// verificato, invece di introdurne uno nuovo per l'intero spazio dei provider.

export interface DifficultyEstimate {
  isComplex: boolean
  score: number // 0-100, solo per debug/log — la soglia decide isComplex
  reasons: string[]
}

const COMPLEXITY_THRESHOLD = 45

// Segnali di task strutturalmente più rischiosi da lasciare a un singolo
// tentativo diretto: toccano più file/aree, richiedono ragionamento su
// concorrenza o sicurezza, o combinano più passi distinti in una frase sola.
const HIGH_RISK_KEYWORDS = [
  'refactor', 'refactoring', 'riscrivi', 'riprogetta', 'architettura',
  'race condition', 'concorrenza', 'deadlock', 'memory leak',
  'sicurezza', 'vulnerabilit', 'injection', 'xss',
  'ottimizza le performance', 'ottimizzazione delle performance',
  'migrazione', 'migra da', 'sostituisci tutte le occorrenze',
  'tutti i file', "l'intero progetto", 'intero codebase', 'l\'intera app'
]

// Segnali dell'opposto: micro-modifiche circoscritte dove Deep Reasoning
// (3 generazioni + giudizio) è solo overhead — la stessa lista di parole
// chiave "semplici" di un audit precedente di questo progetto per il
// recupero dei tool call a testo libero ha già dimostrato che gli euristici
// lessicali su un dominio ristretto (qui: verbi comuni di micro-edit)
// funzionano bene abbastanza da essere utili senza dover chiamare un LLM.
const LOW_RISK_KEYWORDS = [
  'rinomina', 'correggi il typo', 'refuso', 'fix typo',
  'aggiungi un commento', 'aggiungi un log', 'console.log',
  'cambia il colore', 'cambia colore', 'sposta questo file',
  'aggiorna la versione', 'aggiorna il readme'
]

function countDistinctFileMentions(prompt: string): number {
  // Percorsi/riferimenti a file: qualcosa con un'estensione riconoscibile o
  // uno slash — una stima grezza ma sufficiente per capire "tocca un file
  // solo" vs "tocca più file", che è il segnale che conta davvero qui.
  const matches = prompt.match(/[\w./-]+\.(ts|tsx|js|jsx|py|rs|go|java|css|html|json|md)\b|(?:^|\s)\S+\/\S+/g) || []
  return new Set(matches.map(m => m.trim().toLowerCase())).size
}

function countStepConnectors(prompt: string): number {
  // "prima X poi Y", "e poi", "successivamente": più passi distinti
  // dichiarati nello stesso prompt aumentano la superficie d'errore di un
  // singolo tentativo diretto, esattamente il caso che il confronto tra
  // più candidati di Deep Reasoning aiuta a coprire.
  const connectors = prompt.match(/\be poi\b|\bsuccessivamente\b|\bprima di\b|\bdopo di che\b|\binoltre\b|\bquindi\b/gi) || []
  return connectors.length
}

/**
 * Stima locale, senza chiamate LLM, di quanto un task sia "rischioso" da
 * eseguire in un solo tentativo diretto. Usata solo quando l'utente sceglie
 * esplicitamente la modalità "Automatico" per Deep Reasoning — mai per
 * sovrascrivere una scelta esplicita (On/Off) fatta dall'utente.
 */
export function estimateTaskDifficulty(userPrompt: string): DifficultyEstimate {
  const prompt = userPrompt || ''
  const lower = prompt.toLowerCase()
  const reasons: string[] = []
  let score = 0

  // Lunghezza: un prompt molto lungo di solito descrive un task con più
  // requisiti/vincoli da soddisfare contemporaneamente, non una micro-modifica.
  if (prompt.length > 600) {
    score += 20
    reasons.push('prompt lungo (>600 caratteri)')
  } else if (prompt.length > 300) {
    score += 10
    reasons.push('prompt di media lunghezza (>300 caratteri)')
  }

  const fileMentions = countDistinctFileMentions(prompt)
  if (fileMentions >= 3) {
    score += 25
    reasons.push(`menzioni di ${fileMentions} file/percorsi distinti`)
  } else if (fileMentions === 2) {
    score += 10
    reasons.push('menzioni di 2 file/percorsi distinti')
  }

  const steps = countStepConnectors(prompt)
  if (steps >= 2) {
    score += 20
    reasons.push(`${steps} connettori di sequenza multi-passo`)
  } else if (steps === 1) {
    score += 8
    reasons.push('1 connettore di sequenza multi-passo')
  }

  const highRiskHit = HIGH_RISK_KEYWORDS.find(kw => lower.includes(kw))
  if (highRiskHit) {
    score += 30
    reasons.push(`parola chiave ad alto rischio: "${highRiskHit}"`)
  }

  const lowRiskHit = LOW_RISK_KEYWORDS.find(kw => lower.includes(kw))
  if (lowRiskHit && !highRiskHit) {
    score -= 25
    reasons.push(`parola chiave a basso rischio: "${lowRiskHit}"`)
  }

  score = Math.max(0, Math.min(100, score))

  return {
    isComplex: score >= COMPLEXITY_THRESHOLD,
    score,
    reasons
  }
}
