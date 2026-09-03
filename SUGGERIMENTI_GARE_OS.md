# Suggerimento per una prossima sessione: migliorare il riconoscimento tabelle in `OcrPlugin.ts`

Nota lasciata da una sessione Claude che lavorava in parallelo su un altro
progetto dello studio (`LLM/GARE-OS`), dopo aver confrontato il modo in cui
i due progetti leggono tabelle da documento/immagine. Non è un bug — quanto
già implementato qui funziona — ma il rilevamento struttura tabelle di
GARE-OS è strutturalmente più solido, e il gap è coprribile senza cambiare
il flusso attuale dello strumento `ocr_image`.

## Cosa fa oggi `OcrPlugin.ts` sulle tabelle

`electron/agent/tools/OcrPlugin.ts`:
1. OCR del testo con `ppu-paddle-ocr` (PaddleOCR PP-OCRv6 via ONNX Runtime) — ottimo, nessun cambiamento suggerito qui.
2. Localizzazione delle tabelle con `ppu-doclayout`: individua **solo il riquadro** `[x1,y1,x2,y2]` di ogni tabella nell'immagine — non la griglia di celle.
3. `reconstructTableMarkdown()` ricostruisce righe/colonne con un'**euristica geometrica**: prende i box di testo OCR che cadono dentro il riquadro, li raggruppa in "righe" per vicinanza verticale del centro (soglia = metà dell'altezza mediana dei box), ordina ogni riga da sinistra a destra.

Il limite di questo approccio (dichiarato onestamente nei commenti del file stesso): è un'euristica, non un vero riconoscimento di celle. Non gestisce celle unite/divise, non sa che due colonne visivamente vicine sono in realtà colonne separate se il testo è corto, non distingue un'intestazione multi-riga da righe di dati.

## Come fa la stessa cosa GARE-OS, e perché è più solido

GARE-OS usa **Docling** (già MIT/Apache, libreria Python — non la propongo per un porting diretto in Node, vedi sotto) con **TableFormer**, un modello di *table structure recognition* vero e proprio: dato il riquadro di una tabella (rilevato a sua volta da un modello di layout, come fa `ppu-doclayout` qui), TableFormer predice direttamente la **griglia di celle** — quante righe, quante colonne, quali celle sono unite (span), il testo di ciascuna — non un raggruppamento a posteriori di box OCR.

Configurazione in GARE-OS (`core/gareos/ingestion/parser.py::_opzioni_pdf()`):
```python
PdfPipelineOptions(ocr_options=_motore_ocr_di_default())
# do_table_structure=True e TableFormerMode.ACCURATE sono i default di Docling,
# verificati esplicitamente per non fare affidamento su un default implicito.
```

Poi GARE-OS va un passo oltre la sola estrazione strutturale: dato che il
caso d'uso reale sono i **computi metrici** (tabelle con colonne
codice/descrizione/unità di misura/quantità/prezzo/importo), un livello
applicativo in più (`core/gareos/ingestion/pdf_computo.py` +
`core/gareos/ingestion/computo_comune.py`) legge la griglia strutturata di
TableFormer, riconosce quale riga è l'intestazione (per alias di colonna:
"descrizione"/"descriz"/"voce", "prezzo unit"/"p.u.", ecc.) e produce una
riga di testo canonica e cercabile per ogni voce, es.:

```
[01.01] Scavo di sbancamento 120,50 mc × 8,30 €/mc = 1.000,15 €
```

invece di lasciare la tabella come blocco di markdown grezzo. La stessa
identica logica di riconoscimento intestazione è condivisa con l'estrazione
da XLSX nativi (`xlsx_computo.py`) — un'unica definizione di "cos'è una
colonna descrizione/prezzo/importo", non duplicata.

## Suggerimento concreto, non un porting

**Non serve portare Docling/Python in Electron** — sarebbe una dipendenza
enorme e fuori stack per questo progetto. Due miglioramenti indipendenti,
in ordine di costo/beneficio:

1. **Verificare se `ppu-doclayout` (o un pacchetto ONNX equivalente in npm)
   espone anche un modello di table-structure-recognition**, non solo il
   layout detection già usato — molti modelli della famiglia PaddleOCR/
   PP-Structure (da cui TableFormer e affini derivano concettualmente)
   hanno una testa dedicata a questo (`SLANet`/`PP-StructureV2` in
   PaddleOCR, con controparti ONNX). Se esiste un pacchetto npm MIT/Apache
   che lo espone, sostituire l'euristica geometrica con quello alzerebbe
   la qualità delle tabelle senza cambiare l'interfaccia dello strumento.

2. **Se non esiste un modello del genere in npm**, l'euristica attuale
   resta la scelta pragmatica — ma vale la pena rendere esplicito
   all'utente/agente quando il rilevamento è "solo geometrico" (già fatto,
   bene) e valutare se aggiungere il riconoscimento di un'eventuale riga
   di intestazione/totale via parole chiave — lo stesso approccio a bassa
   soglia usato in GARE-OS (`computo_comune.py::individua_intestazione`,
   `e_riga_di_totale`) — così che, per il caso d'uso "leggere un computo
   metrico da una foto", il testo restituito distingua almeno intestazione/
   voci/totale invece di una sola tabella markdown indifferenziata. Questa
   parte SÌ è portabile concettualmente: è pura logica di stringhe (alias
   di colonna case-insensitive + pattern "totale/sommano/riporto" per le
   righe di chiusura), nessun modello ML coinvolto.

Riferimento per chi riprende questo lavoro: `docs/DECISIONI.md` di
GARE-OS, voce "2026-09-04 — Voci di computo metrico anche dalle tabelle
di un PDF" per il dettaglio implementativo completo lato Python.
