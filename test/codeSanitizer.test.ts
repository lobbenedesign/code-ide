import { describe, it, expect } from 'vitest'
import { sanitizeAndFormatCode } from '../electron/services/codeSanitizer'

describe('codeSanitizer: mode "none"', () => {
  it('leaves content untouched (no stripping, no formatting) for an unsupported extension', async () => {
    const raw = 'weird   spacing\n// ... existing code ...\n'
    const out = await sanitizeAndFormatCode(raw, 'notes.xyz', 'none')
    expect(out).toBe(raw)
  })
})

describe('codeSanitizer: mode "ai-only"', () => {
  it('strips LLM placeholder comments but keeps real code, then formats with Prettier', async () => {
    const dirty = `
const a = 1;
// ... existing code ...
function foo() {
  // Sure, I can help with that
  return a + 1;
}
// As requested, here is the updated logic
foo();
`
    const out = await sanitizeAndFormatCode(dirty, 'test.ts', 'ai-only')
    expect(out).not.toContain('existing code')
    expect(out).not.toContain('Sure, I can help')
    expect(out).not.toContain('As requested')
    expect(out).toContain('function foo()')
    expect(out).toContain('return a + 1')
  })

  it('does NOT strip a real comment that happens to contain similar words out of the exact placeholder phrasing', async () => {
    const code = `// This handles the case where the user has requested a refund\nconst refund = true;\n`
    const out = await sanitizeAndFormatCode(code, 'test.ts', 'ai-only')
    // La regex è ancorata alla frase esatta dei placeholder LLM (es. "As
    // requested, here is..."), non a parole sciolte come "requested" — un
    // vero commento di dominio non deve sparire.
    expect(out).toContain('handles the case where the user has requested a refund')
  })

  it('formats using the project prettier config or a sane default (semicolons off, single quotes)', async () => {
    const messy = `const x={a:1,b:2}\nfunction f(y){return y}\n`
    const out = await sanitizeAndFormatCode(messy, 'test.ts', 'ai-only')
    expect(out).toContain('const x = { a: 1, b: 2 }')
  })
})

describe('codeSanitizer: mode "all"', () => {
  it('also strips AI placeholders (same as ai-only for the comment patterns implemented today)', async () => {
    const dirty = '// ... existing code ...\nconst x = 1;\n'
    const out = await sanitizeAndFormatCode(dirty, 'test.ts', 'all')
    expect(out).not.toContain('existing code')
    expect(out).toContain('const x = 1')
  })
})
