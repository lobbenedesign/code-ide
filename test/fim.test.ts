import { describe, it, expect, vi, afterEach } from 'vitest'
import { getFimCompletion } from '../src/services/fim'

// D-03 dell'audit: senza debounce/cancellazione, ogni battuta poteva sparare
// una generazione FIM completa verso Ollama. Il debounce+CancellationToken
// vive in App.tsx (dentro Monaco, non unit-testabile in isolamento), ma la
// parte verificabile qui è che getFimCompletion rispetti DAVVERO un
// AbortSignal passato dal chiamante — la richiesta HTTP si interrompe,
// non solo il suo risultato viene scartato lato client.

describe('getFimCompletion: cancellazione', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('passes the AbortSignal through to fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ response: 'const x = 1' })
    } as Response)

    const controller = new AbortController()
    await getFimCompletion('prefix', 'suffix', 'test-model', controller.signal)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [, options] = fetchSpy.mock.calls[0]
    expect((options as RequestInit).signal).toBe(controller.signal)
  })

  it('returns an empty string (not a thrown error) when the signal is already aborted', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => {
      const signal = (options as RequestInit)?.signal
      if (signal?.aborted) {
        const err = new DOMException('Aborted', 'AbortError')
        return Promise.reject(err)
      }
      return Promise.resolve({ ok: true, json: async () => ({ response: 'x' }) } as Response)
    })

    const controller = new AbortController()
    controller.abort()
    const result = await getFimCompletion('prefix', 'suffix', 'test-model', controller.signal)
    expect(result).toBe('')
  })

  it('still returns a completion when not cancelled', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ response: 'return 42' })
    } as Response)
    const result = await getFimCompletion('function f() {', '}', 'test-model')
    expect(result).toBe('return 42')
  })
})
