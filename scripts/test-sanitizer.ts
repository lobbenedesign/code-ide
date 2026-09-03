import { sanitizeAndFormatCode } from '../electron/services/codeSanitizer.js'
import { stripImageMetadata } from '../electron/services/imageMetadata.js'

async function testCodeSanitizer() {
  console.log('--- TESTING CODE SANITIZER ---')
  const dirtyCode = `
    const a = 1;
// ... existing code ...
    function foo() {
      // Sure, I can help with that
      return a + 1;
    }
    // As requested, here is the updated logic
    foo();
  `

  console.log('Original Code:\n' + dirtyCode)

  const cleanedAiOnly = await sanitizeAndFormatCode(dirtyCode, 'test.ts', 'ai-only')
  console.log('\nProcessed (ai-only):\n' + cleanedAiOnly)

  const cleanedNone = await sanitizeAndFormatCode(dirtyCode, 'test.ts', 'none')
  console.log('\nProcessed (none):\n' + cleanedNone)

  if (!cleanedAiOnly.includes('// ... existing code ...') && cleanedAiOnly.includes('function foo() {')) {
    console.log('✅ Code Sanitizer (ai-only) removed AI comments and formatted correctly.')
  } else {
    console.error('❌ Code Sanitizer failed.')
  }
}

function createFakePng(chunks: { type: string, data: string }[]): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const buffers: Buffer[] = [signature]
  
  for (const chunk of chunks) {
    const dataBuf = Buffer.from(chunk.data, 'latin1')
    const lengthBuf = Buffer.alloc(4)
    lengthBuf.writeUInt32BE(dataBuf.length)
    const typeBuf = Buffer.from(chunk.type, 'ascii')
    const crcBuf = Buffer.alloc(4) // Fake CRC
    buffers.push(Buffer.concat([lengthBuf, typeBuf, dataBuf, crcBuf]))
  }
  
  // End chunk
  const iendType = Buffer.from('IEND', 'ascii')
  const iendLen = Buffer.alloc(4)
  const iendCrc = Buffer.alloc(4)
  buffers.push(Buffer.concat([iendLen, iendType, Buffer.alloc(0), iendCrc]))
  
  return Buffer.concat(buffers)
}

function testImageMetadata() {
  console.log('\n--- TESTING IMAGE METADATA (PNG) ---')
  const fakePng = createFakePng([
    { type: 'IHDR', data: 'fake_header' },
    { type: 'tEXt', data: 'Software: Midjourney' }, // AI metadata
    { type: 'tEXt', data: 'Author: Giuseppe' }, // Normal metadata
    { type: 'IDAT', data: 'fake_pixel_data' }
  ])

  // Test 'all'
  const resAll = stripImageMetadata(fakePng, 'all')
  console.log(`'all' mode removed chunks:`, resAll.removedChunks)
  if (resAll.removedChunks.length === 2) {
    console.log('✅ stripImageMetadata (all) correctly removed ALL tEXt chunks.')
  } else {
    console.error('❌ stripImageMetadata (all) failed.')
  }

  // Test 'ai-only'
  const resAi = stripImageMetadata(fakePng, 'ai-only')
  console.log(`'ai-only' mode removed chunks:`, resAi.removedChunks)
  // We expect it to remove 1 chunk (the Midjourney one)
  if (resAi.removedChunks.length === 1 && resAi.removedChunks.includes('tEXt')) {
    console.log('✅ stripImageMetadata (ai-only) correctly removed ONLY AI chunk.')
  } else {
    console.error('❌ stripImageMetadata (ai-only) failed. Removed chunks:', resAi.removedChunks.length)
  }
}

async function runTests() {
  try {
    await testCodeSanitizer()
    testImageMetadata()
  } catch (err) {
    console.error('Test execution failed:', err)
  }
}

runTests()
