# Buscador Inteligente de Catálogos

Sistema interno de busca por produto em catálogos PDF de fornecedores. Rafael
sobe os catálogos, manda uma foto do produto procurado, e o sistema retorna
**as páginas dos catálogos** que contêm aquele produto — mostrando qual produto
da página deu match.

> **Estratégia atual: busca por página + produtos detectados** (default
> `CATALOG_PROCESSING_MODE=page_mentions`, ver
> `PAGE_LEVEL_SEARCH_REFACTOR.md`). O sistema NÃO recorta produtos
> individualmente para a busca nova. Cada página é renderizada, analisada por
> um modelo multimodal, e cada produto detectado vira uma linha
> `PageProductMention` com embedding **textual/semântico**. A página inteira
> é o resultado visual; o produto detectado é a unidade de inteligência. A
> função comercial manda mais que aparência — câmera rosa nunca volta como
> "fone rosa", antena com cabo preto nunca volta como "cabo USB preto".

## Pipeline (page_mentions, default)

```
PDF
→ pdftoppm -jpeg -r 180        (renderiza páginas inteiras a 180 DPI)
→ CatalogPage salvo no Supabase Storage em {catalogId}/pages/
→ extractPdfLayout (PyMuPDF)   (texto da página, usado como evidência)
→ analyzeCatalogPageProducts  (multimodal: lista produtos visíveis, sem boxes)
→ PageProductMention (uma linha por produto detectado na página)
→ searchText consolidado     (nome, função, categoria, atributos, mustNotMatch)
→ text-embeddings (OpenAI text-embedding-3-small / 1536 dim)
→ pgvector cosine search sobre PageProductMention
→ reranker comercial (functionGroup > produto principal > cor > aparência)
→ resultado = página + produto detectado + tipo de match + motivo
```

## Pipeline antiga (legacy_crops — preservada)

Para rodar o detector de cards/crops antigo (cascata estrutural + visão),
defina `CATALOG_PROCESSING_MODE=legacy_crops` no upload e
`SEARCH_MODE=legacy_candidates` na busca:

```
PDF
→ pdftoppm -jpeg -r 180
→ extractPdfLayout (PyMuPDF)
→ classifica a página → GRID_LAYOUT → PDF_LAYOUT → HEURISTIC → VISION → FALLBACK
→ valida produto único por crop (rejeita crops multi-produto)
→ ProductCandidate salvo em {catalogId}/candidates/
→ DINOv2 embedding (Xenova/dinov2-base, 768 dim, CLS token)
→ pgvector cosine search sobre ProductCandidate
```

## Variáveis de ambiente

```env
DATABASE_URL              # Supabase pooled connection (runtime Prisma)
DIRECT_URL                # Supabase direct connection (Prisma CLI migrations)
SUPABASE_URL              # https://xxx.supabase.co
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY # necessário para upload server-side

# Detector visual (cascata — opcional)
VISION_DETECTOR_PROVIDER          # 'openai' | 'anthropic'
VISION_DETECTOR_API_KEY
VISION_DETECTOR_MODE              # 'auto' (default) | 'always' | 'off'
VISION_DETECTOR_MODEL_CHEAP       # modelo barato (chamado primeiro)
VISION_DETECTOR_MODEL_PREMIUM     # modelo caro (só com fallback ligado)
VISION_USE_PREMIUM_FALLBACK       # 'true' | 'false' (default false)
CATALOG_MAX_VISION_PAGES          # teto de chamadas com visão por catálogo (default 20)

# Knobs de custo do detector boxes-only
VISION_DETECTOR_MAX_IMAGE_WIDTH   # default 1280 — largura máx da imagem enviada
VISION_DETECTOR_JPEG_QUALITY      # default 75
VISION_DETECTOR_MAX_OUTPUT_TOKENS # default 800 — boxes-only não precisa de mais

# Detector estrutural (PyMuPDF)
PYTHON_BIN                        # interpretador python do extrator (default 'python3')
CATALOG_DEBUG_PAGES               # ex.: "3,4,5" — logs detalhados por página

# Estratégia page_mentions (default)
CATALOG_PROCESSING_MODE           # 'page_mentions' (default) | 'legacy_crops'
SEARCH_MODE                       # 'page_mentions' (default) | 'legacy_candidates'
PAGE_ANALYZER_MODEL               # modelo multimodal do analyzer (cai p/ VISION_DETECTOR_MODEL_CHEAP)
PAGE_ANALYZER_MAX_OUTPUT_TOKENS   # default 2400
QUERY_ANALYZER_MODEL              # modelo p/ analisar a imagem de busca (cai p/ PAGE_ANALYZER_MODEL)
QUERY_ANALYZER_MAX_OUTPUT_TOKENS  # default 1200
QUERY_ANALYZER_MAX_IMAGE_WIDTH    # default 1024
TEXT_EMBEDDING_PROVIDER           # 'openai' (default)
TEXT_EMBEDDING_MODEL              # default 'text-embedding-3-small'
TEXT_EMBEDDING_DIMENSIONS         # default 1536 (precisa bater com o schema)
TEXT_EMBEDDING_API_KEY            # opcional — cai p/ OPENAI_API_KEY / VISION_DETECTOR_API_KEY
```

### Pipeline de detecção em cascata

A ordem é **`PAGE_CLASSIFIER → GRID_LAYOUT → PDF_LAYOUT → HEURISTIC → VISION → FALLBACK`**.
Os detectores primários (`GRID_LAYOUT`, `PDF_LAYOUT`) usam a estrutura real do PDF
via PyMuPDF e não custam nada. Numa página digital típica eles resolvem sozinhos
e a IA nem é chamada.

- O **classificador** marca capa/sumário/índice como não-produto → 0 candidatos
  pesquisáveis, sem visão.
- O **GRID_LAYOUT** infere as células de produto pelas posições dos sinais
  (código, `R$`, `PCS/CX`, `Unid.CX`) e gera 1 box por produto.
- Cada crop passa por **validação de produto único**: se contém 2+ produtos
  (2+ preços/PCS-CX), é rejeitado como `multi_card_crop` e nunca é indexado —
  isso evita embeddings misturados. Crops compostos são subdivididos.

`auto` (padrão) só chama o modelo de visão quando os detectores estruturais **e**
a heurística falham (página escaneada, sem estrutura). Em testes use o modelo
barato e mantenha `VISION_USE_PREMIUM_FALLBACK=false`.

`CATALOG_MAX_VISION_PAGES` é um teto absoluto por catálogo: ao atingir o
limite as páginas restantes ficam com a heurística mesmo no `auto`.

Configuração recomendada para teste barato:

```env
VISION_DETECTOR_PROVIDER=openai
VISION_DETECTOR_MODE=auto
VISION_DETECTOR_MODEL_CHEAP=gpt-5.4-mini
VISION_DETECTOR_MODEL_PREMIUM=gpt-5.5
VISION_USE_PREMIUM_FALLBACK=false
CATALOG_MAX_VISION_PAGES=20
```

## Dependências de sistema

- **poppler-utils** — fornece `pdftoppm` para renderização de páginas e `pdfimages` (fallback).
  O Dockerfile já instala via `apt-get install poppler-utils`.
- **Python 3 + PyMuPDF** — usados pelo detector principal `PDF_LAYOUT`
  (`scripts/extract_pdf_layout.py`). Local: `pip install -r scripts/requirements.txt`
  (ou `pip install PyMuPDF`). O Dockerfile instala `python3` + `PyMuPDF`. Se o
  Python/PyMuPDF não estiver disponível, a extração falha graciosamente e cada
  página cai na heurística/visão.

## Rodar localmente

```bash
pnpm install
pnpm dev
```

Certifique-se de ter um arquivo `.env.local` com todas as variáveis acima.

## Testar upload de PDF

1. Acesse `/fornecedores` → crie um fornecedor.
2. Abra o fornecedor → faça upload de um PDF.
3. Aguarde status mudar de "Processando" para "Pronto" (a página auto-atualiza a cada 5s).
4. Abra o catálogo para ver as **páginas renderizadas** e os **candidatos extraídos**.

## Testar busca por imagem

1. Acesse `/busca`.
2. Faça upload de uma foto do produto que quer encontrar.
3. Cada resultado é uma **página de catálogo** mostrando o produto detectado
   que deu match, o tipo de match (`exact`/`equivalent`/`variant`/
   `kit_contains`/`accessory`/`related_but_not_match`), a confiança
   (`high`/`medium`/`low`) e o motivo. Clique para abrir a página inteira.

## Como avaliar se o processamento está bom

1. Abra o catálogo em `/catalogos/[catalogId]`.
2. Cada página renderizada mostra os produtos detectados (`PageProductMention`)
   com nome em pt-BR, `functionGroup`, categoria e cores.
3. Sinais de problema:
   - Páginas de capa/sumário aparecendo com produtos → ajustar o prompt do
     analyzer (`page-product-analyzer.ts`).
   - `functionGroup` errado para muitos produtos → o reranker vai sofrer;
     considere um modelo melhor em `PAGE_ANALYZER_MODEL`.

## Comandos úteis

```bash
pnpm dev                                 # dev server
pnpm build                               # build de produção
pnpm lint                                # eslint
npx prisma generate                      # regenerar client após mudança no schema
npx prisma migrate deploy                # aplicar migrations em produção
# Debug do analyzer numa página sem tocar o banco:
npx tsx scripts/test-page-analyzer.ts ~/Downloads/catalogo.pdf 3 4 5
# Debug da busca fim-a-fim com uma imagem real (usa o banco):
npx tsx scripts/test-page-search.ts --image ~/Downloads/camera-rosa.jpg
# Pipeline antiga (legacy_crops):
npx tsx scripts/test-eletromex.ts ~/Downloads/catalogo.pdf 3 4 5
npx tsx scripts/reindex.ts               # re-indexar ProductImage (legado)
```
