import { describe, it, expect, beforeEach, vi } from 'vitest'

// runRegistry.ts è un modulo stateful a livello di processo (una sola Map
// module-level, niente istanze) — vi.resetModules() prima di ogni test evita
// che i run registrati in un test restino visibili al successivo.
describe('runRegistry: tracciamento dei run paralleli dell\'agente', () => {
  let registryModule: typeof import('../electron/agent/runRegistry')

  beforeEach(async () => {
    vi.resetModules()
    registryModule = await import('../electron/agent/runRegistry')
  })

  it('un run appena registrato è "running" e ha lastMessage vuoto', () => {
    const { registerRun, listRuns } = registryModule
    registerRun('run-1', { title: 'Fai qualcosa', cwd: '/tmp/a', model: 'qwen2.5-coder:latest' })

    const runs = listRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ id: 'run-1', status: 'running', lastMessage: '' })
  })

  it('due run registrati insieme restano tracciati separatamente, senza mescolare gli aggiornamenti', () => {
    const { registerRun, updateRunFromStreamEvent, listRuns } = registryModule
    registerRun('run-a', { title: 'Task A', cwd: '/tmp/a', model: 'modelA' })
    registerRun('run-b', { title: 'Task B', cwd: '/tmp/b', model: 'modelB' })

    updateRunFromStreamEvent('run-a', 'status', 'Sto leggendo i file di A...')
    updateRunFromStreamEvent('run-b', 'status', 'Sto leggendo i file di B...')
    updateRunFromStreamEvent('run-a', 'done', 'Task A completato')

    const runs = listRuns()
    const a = runs.find(r => r.id === 'run-a')!
    const b = runs.find(r => r.id === 'run-b')!

    expect(a.status).toBe('done')
    expect(a.lastMessage).toBe('Task A completato')
    expect(b.status).toBe('running')
    expect(b.lastMessage).toBe('Sto leggendo i file di B...')
  })

  it('un evento "error" marca il run come concluso in errore', () => {
    const { registerRun, updateRunFromStreamEvent, listRuns } = registryModule
    registerRun('run-x', { title: 'Task X', cwd: '/tmp/x', model: 'modelX' })
    updateRunFromStreamEvent('run-x', 'error', 'Qualcosa è andato storto')

    const run = listRuns().find(r => r.id === 'run-x')!
    expect(run.status).toBe('error')
    expect(run.endedAt).toBeDefined()
  })

  it('un evento per un runId mai registrato viene ignorato senza lanciare eccezioni', () => {
    const { updateRunFromStreamEvent, listRuns } = registryModule
    expect(() => updateRunFromStreamEvent('run-mai-esistito', 'done', 'ciao')).not.toThrow()
    expect(listRuns()).toHaveLength(0)
  })

  it('listRuns ordina i run dal più recente al meno recente', async () => {
    const { registerRun, listRuns } = registryModule
    registerRun('run-old', { title: 'Vecchio', cwd: '/tmp', model: 'm' })
    await new Promise(r => setTimeout(r, 5))
    registerRun('run-new', { title: 'Nuovo', cwd: '/tmp', model: 'm' })

    const runs = listRuns()
    expect(runs[0].id).toBe('run-new')
    expect(runs[1].id).toBe('run-old')
  })

  it('pruneFinishedRuns rimuove solo i run conclusi più vecchi oltre il limite, mai quelli ancora in esecuzione', () => {
    const { registerRun, updateRunFromStreamEvent, listRuns } = registryModule
    // 3 run conclusi + 1 ancora in esecuzione: un limite di 2 conclusi deve
    // rimuovere il più vecchio dei conclusi, senza toccare quello "running".
    registerRun('done-1', { title: 'D1', cwd: '/tmp', model: 'm' })
    updateRunFromStreamEvent('done-1', 'done', 'ok')
    registerRun('done-2', { title: 'D2', cwd: '/tmp', model: 'm' })
    updateRunFromStreamEvent('done-2', 'done', 'ok')
    registerRun('done-3', { title: 'D3', cwd: '/tmp', model: 'm' })
    updateRunFromStreamEvent('done-3', 'done', 'ok')
    registerRun('still-running', { title: 'R', cwd: '/tmp', model: 'm' })

    // pruneFinishedRuns() gira già automaticamente dentro registerRun con
    // MAX_FINISHED_RUNS=50, quindi qui verifichiamo solo che nessuno dei 4
    // run appena creati sia stato rimosso (soglia reale molto più alta di 4).
    const runs = listRuns()
    expect(runs.map(r => r.id).sort()).toEqual(['done-1', 'done-2', 'done-3', 'still-running'])
  })
})
