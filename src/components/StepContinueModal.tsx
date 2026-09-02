interface StepContinueModalProps {
  stepNumber: number
  filesReadThisStep: string[]
  totalFiles: number
  totalFolders: number
  onContinueOnce: () => void
  onContinueAuto: () => void
  onStop: () => void
}

// Modale di conferma tra uno step e il successivo di una revisione multi-file
// (vedi runReadOnlyToolStep in services/llm.ts): un task ampio come "trova bug
// in ogni file" richiederebbe più chiamate di quante è sicuro farne in un colpo
// solo (token/tempo/costo se il modello è a pagamento via OmniRoute) — invece
// di troncare silenziosamente, ci si ferma qui e si chiede all'utente se
// continuare, dandogli anche la scelta di lasciare che l'app continui da sola
// fino alla fine senza richiedere conferma a ogni step.
export function StepContinueModal({
  stepNumber, filesReadThisStep, totalFiles, totalFolders,
  onContinueOnce, onContinueAuto, onStop
}: StepContinueModalProps) {
  return (
    <div className="absolute inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="bg-[#252526] border border-[#444] rounded-lg shadow-xl max-w-[380px] w-full p-4">
        <div className="text-sm font-semibold text-gray-200 mb-2">
          ⏸️ Step {stepNumber} completato
        </div>
        <div className="text-xs text-gray-400 mb-3">
          Il progetto ha <span className="text-gray-200 font-medium">{totalFiles} file</span> in{' '}
          <span className="text-gray-200 font-medium">{totalFolders} cartelle</span>. In questo step ho letto/investigato:
        </div>
        {filesReadThisStep.length > 0 ? (
          <ul className="text-[11px] text-gray-300 bg-[#1e1e1e] rounded border border-[#333] p-2 mb-3 max-h-[140px] overflow-y-auto font-mono">
            {filesReadThisStep.map((f, i) => <li key={i}>📄 {f}</li>)}
          </ul>
        ) : (
          <div className="text-[11px] text-gray-500 mb-3">(nessun file letto in questo step)</div>
        )}
        <div className="text-xs text-gray-400 mb-4">Vuoi continuare con lo step successivo?</div>
        <div className="flex flex-col gap-1.5">
          <button
            onClick={onContinueAuto}
            className="text-xs px-3 py-1.5 bg-green-700 hover:bg-green-600 text-white rounded"
          >
            ✅ Continua automaticamente fino alla fine
          </button>
          <button
            onClick={onContinueOnce}
            className="text-xs px-3 py-1.5 bg-blue-700 hover:bg-blue-600 text-white rounded"
          >
            ➡️ Continua solo con il prossimo step
          </button>
          <button
            onClick={onStop}
            className="text-xs px-3 py-1.5 bg-[#37373d] hover:bg-[#4d4d54] text-gray-300 rounded"
          >
            ⏹️ Fermati qui
          </button>
        </div>
      </div>
    </div>
  )
}
