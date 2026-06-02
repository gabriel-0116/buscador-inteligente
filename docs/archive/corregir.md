Leia com calma e corrija os problemas abaixo no repositório `gabriel-0116/buscador-inteligente`.

Contexto:
O refactor para `page_mentions` está no caminho certo. Não volte para recorte de produto. Não implemente YOLO, detector treinável, boxes ou crops. A estratégia continua sendo:

PDF → páginas renderizadas → PageProductMention por página → busca por imagem retorna página inteira.

Agora preciso corrigir problemas de robustez, limpeza e UI antes de testar catálogo completo.

## 1. Corrigir vazamento de arquivo temporário no page-product-analyzer

Arquivo:
`src/features/catalog-processing/page-product-analyzer.ts`

Problema:
`analyzeCatalogPageProducts` chama `prepareVisionInputImage`, que cria um JPEG temporário em `/tmp`, mas o arquivo não é removido depois da chamada ao modelo.

Corrigir:

- importar `rm` ou `unlink` de `node:fs/promises`;
- envolver leitura + chamada ao modelo em `try/finally`;
- apagar `prepared.imagePath` no finally;
- não deixar arquivo temporário acumulando por página.

Exemplo esperado:

```ts
const prepared = await prepareVisionInputImage({ pageImagePath: args.pageImagePath });

try {
  const imageBuffer = await readFile(prepared.imagePath);
  ...
  const { text, usage } = await callVisionProvider(...);
  ...
} finally {
  await rm(prepared.imagePath, { force: true }).catch(() => {});
}
```

Ajuste a estrutura sem quebrar o retorno atual.

## 2. Melhorar status/resumo quando analyzer falha em páginas

Arquivo:
`src/features/catalog-processing/process-catalog.ts`

Problema:
No modo `page_mentions`, erros por página são capturados e salvos em PageAnalysis, mas o catálogo termina como `READY` mesmo que muitas páginas tenham falhado.

Adicionar contadores no `processInPageMentionsMode`:

- `analyzerErrorCount`
- `embeddingErrorCount`
- `embeddedMentionCount`
- `analyzedPages`
- `emptyPages`
- `mentionCount`

Quando `analyzeCatalogPageProducts` falhar, incrementar `analyzerErrorCount`.

Quando `generateTextEmbeddings` falhar, incrementar `embeddingErrorCount`.

Quando embedding for salvo com sucesso em `PageProductMention`, incrementar `embeddedMentionCount`.

No final do `processInPageMentionsMode`, atualizar `Catalog` com:

- `pageCount`
- `pageProductCount`
- `error`

Regras:

- Se `analyzerErrorCount > 0` ou `embeddingErrorCount > 0`, salvar um texto curto em `Catalog.error`, mesmo mantendo `status=READY`.
- Se `analyzedPages === 0 && analyzerErrorCount > 0`, lançar erro ou marcar catálogo como `FAILED`, porque nesse caso nada foi analisado de verdade.
- Se `mentionCount > 0` mas alguns erros aconteceram, manter `READY`, porém com `Catalog.error` avisando falha parcial.

Exemplo de mensagem:

```txt
Processado com avisos: 12 páginas falharam no analyzer; 3 páginas tiveram erro de embedding.
```

Não criar novo enum agora. Usar `Catalog.error` como aviso.

## 3. Resetar pageProductCount no reprocessamento

Arquivo:
`src/app/api/catalogs/[catalogId]/reprocess/route.ts`

Problema:
O reprocessamento reseta `pageCount` e `candidateCount`, mas não reseta `pageProductCount`.

Corrigir no update que marca `PROCESSING`:

```ts
data: {
  status: "PROCESSING",
  error: null,
  pageCount: null,
  candidateCount: null,
  pageProductCount: null,
}
```

Garantir que ao deletar `CatalogPage`, os `PageProductMention` sejam apagados por cascade. Se quiser deixar explícito e mais seguro, pode adicionar:

```ts
await prisma.pageProductMention.deleteMany({ where: { catalogId } });
```

antes de deletar páginas.

## 4. Corrigir limpeza do Supabase Storage no DELETE de catálogo

Arquivo:
`src/app/api/catalogs/[catalogId]/route.ts`

Problema:
O DELETE não remove:

- `Catalog.pdfStoragePath`;
- `ProductCandidate.cardUrl`.

Corrigir o include:

```ts
include: {
  images: { select: { imageUrl: true } },
  pages: { select: { imageUrl: true } },
  candidates: { select: { cropUrl: true, originalUrl: true, cardUrl: true } },
}
```

E incluir `catalog.pdfStoragePath` na lista de paths.

Exemplo:

```ts
const allPaths = [
  catalog.pdfStoragePath,
  ...catalog.images.map(...),
  ...catalog.pages.map(...),
  ...catalog.candidates.flatMap((c) => [
    pathFromUrl(c.cropUrl),
    pathFromUrl(c.originalUrl),
    c.cardUrl ? pathFromUrl(c.cardUrl) : null,
  ]),
].filter(...);
```

Cuidado: `pdfStoragePath` já é path interno, não URL. Não passar por `pathFromUrl`.

## 5. Não mostrar seção legada vazia na tela do catálogo

Arquivo:
`src/app/catalogos/[catalogId]/page.tsx`

Problema:
No modo novo, `catalog.candidates.length === 0` é normal. Mas a UI mostra:

“Candidatos extraídos (0)”
“Nenhum candidato detectado. Tente reprocessar.”

Isso é confuso.

Corrigir:

- Renderizar a seção de candidatos legados somente se `catalog.candidates.length > 0`.
- Se não houver candidates, não mostrar nada sobre candidatos.
- A tela deve focar em “Páginas renderizadas” e “Produtos detectados”.

Remover esse bloco no modo novo:

```tsx
if (catalog.candidates.length === 0) {
  return (
    <section>
      <h2>Candidatos extraídos (0)</h2>
      <p>Nenhum candidato detectado. Tente reprocessar.</p>
    </section>
  );
}
```

Substituir por:

```tsx
if (catalog.candidates.length === 0) {
  return null;
}
```

## 6. Filtrar resultados fracos na busca por página

Arquivo:
`src/features/semantic-search/page-search.ts`

Problema:
Hoje a busca remove apenas `matchType === "rejected"`. Isso deixa `related_but_not_match` aparecer como resultado normal.

Corrigir:
Na busca principal, mostrar apenas:

```ts
const PUBLIC_MATCH_TYPES = new Set([
  "exact",
  "equivalent",
  "variant",
  "kit_contains",
]);
```

Durante o agrupamento:

```ts
if (!PUBLIC_MATCH_TYPES.has(r.matchType)) continue;
```

Não mostrar por padrão:

- `rejected`
- `related_but_not_match`
- `accessory`

Acessório pode virar opção futura, mas agora a regra é não poluir o resultado principal.

Opcional:
Guardar rejected/debug apenas em script de teste, não na UI principal.

## 7. Melhorar script test-page-search para mostrar rejeitados/debug

Arquivo:
`scripts/test-page-search.ts`

Hoje ele chama `searchPagesByQueryProfile`, que já filtra resultados. Depois do filtro público, ele não mostrará rejeitados.

Criar uma opção ou função debug separada para testar reranker com rejeitados, ou adicionar uma flag:

```bash
--debug
```

Quando `--debug` estiver ativo, imprimir também candidatos rejeitados/related/accessory para depuração.

Não precisa expor isso na UI.

## 8. Adicionar índice pgvector opcional para PageProductMention

Migration nova ou SQL manual:

Como a busca usa:

```sql
ORDER BY m.embedding <=> vector
```

e a tabela pode crescer, adicionar índice vetorial ajuda.

Criar migration separada, segura, com índice ivfflat ou hnsw se pgvector/Supabase suportar.

Exemplo, se disponível:

```sql
CREATE INDEX IF NOT EXISTS "PageProductMention_embedding_idx"
ON "PageProductMention"
USING ivfflat ("embedding" vector_cosine_ops)
WITH (lists = 100);
```

Se não quiser mexer nisso agora, deixe documentado em comentário/README como otimização futura. Não bloquear o MVP por isso.

## 9. Rodar validação

Depois das alterações, rodar:

```bash
pnpm lint
pnpm build
npx prisma generate
```

Depois testar analyzer isolado:

```bash
npx tsx scripts/test-page-analyzer.ts ~/Downloads/catalogo.pdf 3 4 5
```

Depois testar busca:

```bash
npx tsx scripts/test-page-search.ts --image ~/Downloads/camera-rosa.jpg
```

## Critério de aceite desta correção

- OpenAI continua usando `max_completion_tokens`.
- Analyzer não deixa arquivo temporário por página em `/tmp`.
- Catálogo com falhas parciais mostra aviso em `Catalog.error`.
- Reprocessamento reseta `pageProductCount`.
- Delete remove PDF original e cardUrl do Storage.
- Tela do catálogo não mostra “Candidatos extraídos (0)” no modo page_mentions.
- Busca pública não mostra `related_but_not_match` nem `accessory`.
- `pnpm lint` e `pnpm build` passam.
