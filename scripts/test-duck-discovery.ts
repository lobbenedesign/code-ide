import { discoverDuckAiModels, getCachedOrDefaultModels } from '../electron/services/duckAiDiscovery.js'

async function run() {
  console.log('--- Testing DuckAI Discovery ---')
  const models = await discoverDuckAiModels()
  console.log('Discovered models count:', models.length)
  models.forEach(m => {
    console.log(`- [${m.id}] ${m.label} (reasoning: ${!!m.supportsReasoning}, beta: ${!!m.isBeta})`)
  })

  if (models.length >= 5) {
    console.log('✅ Discovery succeeded and loaded real models!')
  } else {
    console.error('❌ Discovery returned fewer models than expected.')
  }
}

run().catch(console.error)
