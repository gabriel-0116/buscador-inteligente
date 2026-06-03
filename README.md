# Buscador Inteligente de Catálogos

Sistema interno de busca por produto em catálogos PDF de fornecedores. Rafael
sobe os catálogos, manda uma foto do produto procurado, e o sistema retorna
**as páginas dos catálogos** que contêm aquele produto — mostrando qual produto
da página deu match.

> **Estratégia: busca por página + produtos detectados** (ver
> `PAGE_LEVEL_SEARCH_REFACTOR.md`). O sistema NÃO recorta produtos
> individualmente. Cada página é renderizada, analisada por um modelo
> multimodal, e cada produto detectado vira uma linha `PageProductMention`
> com embedding **textual/semântico**. A página inteira é o resultado
> visual; o produto detectado é a unidade de inteligência. A função
> comercial manda mais que aparência — câmera rosa nunca volta como
> "fone rosa", antena com cabo preto nunca volta como "cabo USB preto".

## Pipeline

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

## Variáveis de ambiente

```env
DATABASE_URL              # Supabase pooled connection (runtime Prisma)
DIRECT_URL                # Supabase direct connection (Prisma CLI migrations)
SUPABASE_URL              # https://xxx.supabase.co
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY # necessário para upload server-side

# Provider multimodal (compartilhado pelos dois analyzers)
VISION_DETECTOR_PROVIDER          # 'openai' | 'anthropic'
VISION_DETECTOR_API_KEY
VISION_DETECTOR_MODEL_CHEAP       # modelo barato — fallback dos dois analyzers
VISION_DETECTOR_MAX_IMAGE_WIDTH   # default 1280 — largura máx da imagem enviada
VISION_DETECTOR_JPEG_QUALITY      # default 75

# Extrator estrutural (PyMuPDF) — alimenta evidência do analyzer
PYTHON_BIN                        # interpretador python do extrator (default 'python3')

# Page analyzer
PAGE_ANALYZER_MODEL               # modelo multimodal do analyzer (cai p/ VISION_DETECTOR_MODEL_CHEAP)
PAGE_ANALYZER_MAX_OUTPUT_TOKENS   # default 2400

# Query image analyzer
QUERY_ANALYZER_MODEL              # modelo p/ analisar a imagem de busca (cai p/ PAGE_ANALYZER_MODEL)
QUERY_ANALYZER_MAX_OUTPUT_TOKENS  # default 1200
QUERY_ANALYZER_MAX_IMAGE_WIDTH    # default 1024

# Embeddings textuais
TEXT_EMBEDDING_PROVIDER           # 'openai' (default)
TEXT_EMBEDDING_MODEL              # default 'text-embedding-3-small'
TEXT_EMBEDDING_DIMENSIONS         # default 1536 (precisa bater com o schema)
TEXT_EMBEDDING_API_KEY            # opcional — cai p/ OPENAI_API_KEY / VISION_DETECTOR_API_KEY
```

## Dependências de sistema

- **poppler-utils** — fornece `pdftoppm` para renderização de páginas.
  O Dockerfile já instala via `apt-get install poppler-utils`.
- **Python 3 + PyMuPDF** — usados pelo extrator de texto da página
  (script em `scripts/`), que fornece a evidência textual usada pelo
  prompt do analyzer. Local: `pip install -r scripts/requirements.txt`
  (ou `pip install PyMuPDF`). O Dockerfile instala `python3` + `PyMuPDF`. Se
  o Python/PyMuPDF não estiver disponível, a extração falha graciosamente e
  o analyzer roda sem esse hint adicional.

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
4. Abra o catálogo para ver as **páginas renderizadas** e os **produtos detectados** em cada página.

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
```
