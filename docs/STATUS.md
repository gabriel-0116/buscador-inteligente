# Status do Projeto

## Estado atual (03/06/2026)

- **O que está funcionando**:
  - Upload de catálogo PDF → renderização das páginas → analyzer multimodal
    extrai produtos (com `brand`/`modelCodes`/`aliases`/`functionGroup`/
    `displayOrder` e demais campos estruturados) → embedding textual (1536)
    em `PageProductMention.embedding` + embedding visual (DINOv2 768) em
    `CatalogPage.visualEmbedding`.
  - Busca por imagem em `/busca`: profile multimodal + DINOv2 da query
    rodam em paralelo, hybrid search (`searchPagesByQueryProfile`) combina
    semântico + visual, reranker comercial filtra
    `related_but_not_match`/`accessory`/`rejected` da UI pública.
  - Regras especializadas do reranker: explicit-code-match
    (`isStrongModelCode`) vence `mustNotMatch`; visibleText→code é só
    bônus; powered-vs-manual derruba "barbeador elétrico × manual" para
    `related_but_not_match`.
  - `/catalogos/[id]` lista produtos por página em ordem visual com
    marca/código abaixo do nome. Stats da home contam
    `PageProductMention`.
  - Debug: `npx tsx scripts/debug-catalog-processing.ts <catalogId>` mostra
    `pageCount`, `pageProductCount`, `Catalog.error` e todas as
    `PageAnalysis` com erro.

- **O que está em progresso**:
  - Nenhuma feature em aberto. Cleanup do pipeline legacy (este commit)
    encerra a dívida técnica do `legacy_crops` / `legacy_candidates`.

- **Último teste rodado**:
  - `pnpm lint` ✓
  - `npx tsc --noEmit` ✓
  - `pnpm build` ✓
  - `npx prisma migrate deploy` (9 migrations aplicadas) ✓
  - `scripts/debug-catalog-processing.ts` em catálogo real (49 páginas, 373
    mentions) — relatório limpo, zero erro de analyzer/embedding.

## Próxima sessão

- **Tarefa**: nenhuma travada. Próximos itens prováveis (quando aparecerem):
  1. Reprocessar catálogos antigos para popular
     `CatalogPage.visualEmbedding` (rows criadas antes da migration
     `add_brand_codes_aliases_and_page_visual`).
  2. Avaliar mAP/precisão da busca contra uma lista curada de query
     images (Rafael).
  3. Possíveis ajustes de prompt do analyzer conforme novos catálogos
     forem adicionados.
- **Critério de aceite**: ao reprocessar um catálogo qualquer, todas as
  páginas terminam com `visualEmbedding` populado e o `summary` mostra
  `pageVisualEmbeddingErrors=0`.

## Decisões arquiteturais recentes

- **(03/06/2026) Remoção do `legacy_crops` / `legacy_candidates`** — modos
  ficam atrás de feature flag por semanas sem serem ligados. Cascade de
  detectores (`detect-product-candidates`, `grid-layout-detector`,
  `pdf-layout-card-detector`, etc.), modelos `ProductCandidate`/
  `ProductImage` e flags `CATALOG_PROCESSING_MODE`/`SEARCH_MODE` removidos.
  `page_mentions` é o único modo.
- **(29/05/2026) Reranker: `isStrongModelCode` + powered-vs-manual** —
  separa código forte (length≥5, letra+dígito, não-denylist) de termos
  genéricos tipo `USB`/`5W`. Apenas códigos explícitos batem
  `mustNotMatch`; OCR vira bônus. "Barbeador elétrico ≠ manual" cai para
  `related_but_not_match`.
- **(29/05/2026) Hybrid search texto + visual da página** — busca passa a
  combinar `PageProductMention.embedding` (1536, textual) com
  `CatalogPage.visualEmbedding` (768, DINOv2 da página inteira). Visual
  é signal de apoio: nunca promove confidence sozinho.
- **(28/05/2026) `PageProductMention` substitui `ProductCandidate`** — a
  página inteira é o resultado visual; o produto detectado dentro é a
  unidade de inteligência. Função comercial manda mais que aparência.
  Ver `PAGE_LEVEL_SEARCH_REFACTOR.md`.
