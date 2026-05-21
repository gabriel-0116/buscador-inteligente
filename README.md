# Buscador Inteligente de Catálogos

Sistema interno de busca visual por produto. Rafael sobe catálogos em PDF de fornecedores; o sistema detecta recortes de produtos, gera embeddings visuais e permite buscar por imagem similar.

## Pipeline atual

```
PDF
→ pdftoppm -jpeg -r 180        (renderiza páginas inteiras a 180 DPI)
→ CatalogPage salvo no Supabase Storage em {catalogId}/pages/
→ detectProductCandidatesFromPage (heurística de crop por bounding box)
→ ProductCandidate salvo em {catalogId}/candidates/
→ DINOv2 embedding (Xenova/dinov2-base, 768 dim, CLS token)
→ pgvector cosine search sobre ProductCandidate
```

> `pdfimages` não é mais a pipeline principal. Era usado para extrair imagens embutidas do PDF (que frequentemente contêm cards inteiros com logo, texto e foto de ambiente, não o produto isolado). O novo fluxo renderiza cada página como imagem e aplica detecção de regiões de conteúdo.

## Variáveis de ambiente

```env
DATABASE_URL              # Supabase pooled connection (runtime Prisma)
DIRECT_URL                # Supabase direct connection (Prisma CLI migrations)
SUPABASE_URL              # https://xxx.supabase.co
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY # necessário para upload server-side

# Detector visual (cascata — opcional)
VISION_DETECTOR_PROVIDER       # 'openai' | 'anthropic'
VISION_DETECTOR_API_KEY
VISION_DETECTOR_MODE           # 'auto' (default) | 'always' | 'off'
VISION_DETECTOR_MODEL_CHEAP    # modelo barato (chamado primeiro)
VISION_DETECTOR_MODEL_PREMIUM  # modelo caro (só com fallback ligado)
VISION_USE_PREMIUM_FALLBACK    # 'true' | 'false' (default false)
CATALOG_MAX_VISION_PAGES       # teto de chamadas com visão por catálogo (default 20)
```

### Pipeline de detecção em cascata

`auto` (padrão) só chama o modelo de visão quando a heurística local falha
(poucos produtos, crops anormais, qualidade média baixa). Em testes use o
modelo barato e mantenha `VISION_USE_PREMIUM_FALLBACK=false`. O premium só
deve ser ligado para resgatar páginas específicas — nunca em catálogo
inteiro sem limite.

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
3. Os resultados mostram o recorte (`cropUrl`) do candidato mais similar, com link para a página original.

## Como avaliar se o processamento está bom

1. Abra o catálogo em `/catalogos/[catalogId]`.
2. Confira a seção **Candidatos extraídos**:
   - Os crops mostram produtos isolados? → pipeline está funcionando bem.
   - Os crops mostram cards inteiros com logo e texto? → o detector precisa de ajuste.
   - Não há candidatos? → verifique se `pdftoppm` está instalado e se o PDF é nativo (não escaneado).
3. Se os crops estiverem ruins, a qualidade da busca não vai melhorar só mexendo no modelo — corrija a detecção primeiro.

## Ajustar o detector de crops

Arquivo: `src/features/catalog-processing/detect-product-candidates.ts`

Parâmetros principais:
- `GAP_DENSITY` (padrão `0.04`) — sensibilidade para detectar separadores brancos entre produtos.
- `MIN_GAP_SPAN` (padrão `8` px) — número mínimo de linhas/colunas brancas para considerar separador.
- `MIN_CROP_PX` (padrão `180`) — dimensão mínima de um crop válido.
- `MAX_CANDIDATES_PER_PAGE` (padrão `3`) — limite de candidatos por página.

## Comandos úteis

```bash
pnpm dev           # dev server
pnpm build         # build de produção
pnpm lint          # eslint
npx prisma generate           # regenerar client após mudança no schema
npx prisma migrate deploy     # aplicar migrations em produção
npx tsx scripts/reindex.ts    # re-indexar ProductImage (legado) com embedding atual
```
