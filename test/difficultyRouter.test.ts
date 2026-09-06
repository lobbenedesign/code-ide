import { describe, it, expect } from 'vitest'
import { estimateTaskDifficulty } from '../electron/agent/difficultyRouter'

describe('difficultyRouter: estimateTaskDifficulty', () => {
  it('classifica come semplice una micro-modifica circoscritta', () => {
    const result = estimateTaskDifficulty('rinomina la variabile foo in bar in src/utils.ts')
    expect(result.isComplex).toBe(false)
  })

  it('classifica come semplice una richiesta breve senza segnali di rischio', () => {
    const result = estimateTaskDifficulty('aggiungi un commento sopra questa funzione')
    expect(result.isComplex).toBe(false)
  })

  it('classifica come complesso un refactoring che tocca più file', () => {
    const result = estimateTaskDifficulty(
      'Refactoring dell\'architettura di autenticazione: prima aggiorna src/auth/login.ts, ' +
      'poi src/auth/session.ts, e successivamente src/middleware/authGuard.ts per gestire correttamente ' +
      'una race condition nella gestione dei token. Inoltre aggiorna anche i test relativi.'
    )
    expect(result.isComplex).toBe(true)
    expect(result.reasons.some(r => r.includes('rischio'))).toBe(true)
  })

  it('classifica come complesso un prompt lungo, multi-passo e su più file anche senza keyword ad alto rischio', () => {
    const longPrompt = 'Voglio che tu faccia questa cosa. '.repeat(20) +
      ' Prima aggiorna src/app.ts, e poi src/utils/helpers.ts, e poi controlla il risultato finale.'
    const result = estimateTaskDifficulty(longPrompt)
    expect(result.isComplex).toBe(true)
  })

  it('un prompt vuoto non è mai complesso', () => {
    const result = estimateTaskDifficulty('')
    expect(result.isComplex).toBe(false)
    expect(result.score).toBe(0)
  })

  it('il punteggio resta sempre tra 0 e 100', () => {
    const result = estimateTaskDifficulty(
      'refactor riprogetta architettura race condition concorrenza sicurezza migrazione '.repeat(5) +
      'a.ts b.ts c.ts d.ts e.ts prima poi quindi inoltre successivamente'
    )
    expect(result.score).toBeGreaterThanOrEqual(0)
    expect(result.score).toBeLessThanOrEqual(100)
  })
})
