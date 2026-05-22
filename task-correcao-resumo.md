# Resumo — Pipeline PDF-structure-first (task-correcao)

Implementação da decisão de **não usar mais o LLM como recortador principal**.
A pipeline primária agora é `PDF_LAYOUT`: extrai a estrutura real do PDF com
PyMuPDF e agrupa os elementos em cards de produto. A IA multimodal virou
**fallback**, usada só em páginas escaneadas / sem estrutura.

Nova ordem da cascata:

```
PDF_LAYOUT → HEURISTIC → VISION_BOXES_CHEAP → VISION_BOXES_PREMIUM → FALLBACK
```

---

## Arquivos criados

| Arquivo | Papel |
|---|---|
| `scripts/extract_pdf_layout.py` | Extrator PyMuPDF. Lê o PDF e gera JSON com blocos `text`/`image`/`drawing` + bbox (em pontos PDF) e dimensões da página. Uso: `python scripts/extract_pdf_layout.py in.pdf out.json` |
| `scripts/requirements.txt` | Dependência Python: `PyMuPDF` |
| `src/features/catalog-processing/pdf-layout-extractor.ts` | Wrapper TS `extractPdfLayout({pdfPath, outputDir})`. Roda o Python via `execFile` (sem shell string insegura), valida o JSON com Zod, retorna `PdfLayoutDocument \| null`. Erro de Python/PyMuPDF → `null` (não derruba o processamento). Interpretador via `PYTHON_BIN` (default `python3`). |
| `src/features/catalog-processing/pdf-layout-card-detector.ts` | `detectCardsFromPdfLayout(...)` — converte pontos→pixels, filtra ruído, agrupa imagens+textos em cards, rejeita/dedupe. |

## Arquivos modificados

| Arquivo | Mudança |
|---|---|
| `src/features/catalog-processing/detect-product-candidates.ts` | `sourceDetector`/`DetectionDecision` ganham `PDF_LAYOUT`. Novos: `runPdfLayoutDetector`, `evaluatePdfLayoutQuality`, `looksLikeMultiCardCrop`, `countContentBands`, `enforceHardCardRules`, `runHeuristicWithRules`. Orquestrador reescrito para a nova ordem. `multi_card_crop` adicionado a `SEVERE_REJECTS`. |
| `src/features/catalog-processing/process-catalog.ts` | Roda `extractPdfLayout` **1× por catálogo**, mantém o layout em memória (`Map` por página) e passa `pageLayout` ao detector. Conta `pdfLayoutPages` no resumo. |
| `src/app/catalogos/[catalogId]/page.tsx` | Badge `PDF_LAYOUT` ("pdf layout", verde) + label de rejeição `multi_card_crop` ("vários cards"). |
| `Dockerfile` | Instala `python3` + `python3-pip` e `pip install PyMuPDF` (`--break-system-packages` no Debian). |
| `CLAUDE.md` / `README.md` / `.env.example` | Documentam a nova ordem, PyMuPDF, `PYTHON_BIN` e instalação. (Também corrigido no CLAUDE.md o gate de embedding de `0.50`→`0.60`.) |

---

## Como funciona

### 1. Extração (PyMuPDF)
`page.get_text("dict")` dá blocos de texto (type 0) e imagem (type 1) com bbox;
`page.get_drawings()` dá retângulos/desenhos. Coordenadas em **pontos PDF**,
origem topo-esquerda (mesma orientação dos pixels da imagem renderizada). O foco
é posição, não conteúdo perfeito do texto.

### 2. Conversão pontos → pixels
`scaleX = renderedPageWidth / pageLayout.width` (idem Y). Derivado das dimensões
reais, então funciona com qualquer DPI — não há `2.5` fixo do `-r 180`.

### 3. Agrupamento em cards (`detectCardsFromPdfLayout`)
1. Escala blocos para pixels.
2. Remove furniture: cabeçalho/rodapé, blocos minúsculos, barras finas de
   largura total, e **imagem de fundo de página inteira** (senão ela engole tudo).
3. **Âncora nas imagens**: só funde imagens que se tocam/sobrepõem (uma foto = uma
   âncora). Células de grade distintas nunca se fundem.
4. Cada **texto gruda na âncora mais próxima** (legenda abaixo / código ao lado),
   com guarda de sobreposição e largura — texto **nunca faz ponte entre duas
   âncoras**, então uma coluna empilhada não vira um card só.
5. Expande levemente, rejeita página-inteira / barra / coluna / minúsculo, dedup
   por IoU. Página sem foto de produto não gera card.

### 4. `multi_card_crop` (`looksLikeMultiCardCrop`)
Flagra crop ~3× mais alto que largo, **ou** com ≥2 faixas de conteúdo *altas*
(foto) separadas por gaps de branco profundos (legendas finas de várias linhas
não contam como produto). Em `enforceHardCardRules` (aplicado a crops do
heurístico **e** do PDF_LAYOUT) também rejeita:
- `≥ 750×1000 px` → `too_large` (ex.: ELETROMEX 869×1713)
- `área > 35%` da página → `card_too_large`
- `aspecto > 3.2` → `horizontal_bar`

### 5. Quando cai para heurística
PDF_LAYOUT tinha imagens mas **0 cards pesquisáveis** (página escaneada / sem
estrutura), ou a extração Python falhou (`null`).

### 6. Quando chama Vision
Só quando PDF_LAYOUT **e** heurística falham, e há budget
(`CATALOG_MAX_VISION_PAGES`, default 20). Página resolvida pelo PDF_LAYOUT nunca
chama IA. `mode=always` ignora PDF_LAYOUT (teste puro de visão); `mode=off`
roda `PDF_LAYOUT → HEURISTIC` sem visão.

---

## Validação

- `npx prisma generate` ✅ · `pnpm lint` ✅ · `pnpm build` ✅
- `extract_pdf_layout.py` testado nos 2 catálogos de `storage/`:
  catálogo 1 = 49 págs / 2868 blocos; catálogo 2 = 88 págs / 7781 blocos.
- Detecção de grade: **28** e **71** páginas com **9 cards** (grades 3×3).
- E2E (vision off): páginas resolvidas como **PDF_LAYOUT, sem chamar IA**; crops
  pesquisáveis com qualidade **0,88–0,95** e `originalText` anexado.
- Guarda anti-coluna: card único (aspecto 0,68) **não** flagrado; coluna de 2
  fotos (1,77) flagrada; coluna estreita (3,26) flagrada.

> Ressalva: os catálogos ELETROMEX/LUKTON/LEHMOX citados no critério de aceite
> não estão no repositório e não houve acesso ao banco nesta sessão, então não
> foram reprocessados. As regras duras miram exatamente os casos citados.
> Recomenda-se reprocessá-los e conferir `pdfLayoutPages` no resumo do log.

---

## Como testar (reprocessar)

```bash
pip install -r scripts/requirements.txt          # PyMuPDF
python3 scripts/extract_pdf_layout.py CAMINHO.pdf /tmp/out.json   # checa pages/blocks
pnpm dev
# /fornecedores/[id] → reprocessar, ou POST /api/catalogs/[id]/reprocess
# log: "[catalog X] summary: pdfLayoutPages=N ... estimatedVisionCalls=M"
```
