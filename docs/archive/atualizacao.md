# Tarefa — Melhorar busca Page-Level com sinais textuais fortes + embedding visual da página inteira

Leia tudo antes de alterar código.

## Contexto do projeto

Projeto: `buscador-inteligente`
Repo: `github.com/gabriel-0116/buscador-inteligente`

O sistema é o **Buscador Inteligente**.

Objetivo real:
Rafael sobe catálogos PDF de fornecedores. O sistema renderiza as páginas, entende quais produtos existem em cada página e depois permite buscar por imagem. O resultado deve mostrar **páginas do catálogo** onde o produto aparece.

Não é Google Lens genérico.
É busca interna em base fechada de catálogos.

A estratégia atual mudou. Não estamos mais tentando recortar produto/card.

Fluxo atual correto:

```txt
PDF → páginas renderizadas → PageProductMention por página → busca por imagem retorna página inteira
```

Produto detectado dentro da página é a unidade de inteligência.
Página inteira é o resultado visual.

## Estado atual

O modo `page_mentions` já funciona.

O catálogo teste renderizou 49 páginas e criou centenas de produtos detectados. A UI já mostra produtos por página em ordem visual usando `displayOrder`.

Já existem:

- `PageProductMention`
- `displayOrder`
- `page-product-analyzer.ts`
- `query-image-analyzer.ts`
- `text-embeddings.ts`
- `page-search.ts`
- `rerank-page-products.ts`
- `test-page-analyzer.ts`
- `test-page-search.ts`

O problema agora é qualidade da busca.

## Problema

Não podemos depender só de `namePt` e tradução para português.

Catálogos podem ter:

- texto em chinês;
- texto em inglês;
- texto em espanhol;
- tradução ruim;
- nome genérico;
- abreviações;
- códigos/modelos importantes;
- marca visível;
- embalagem com código;
- produto visualmente claro, mas texto ruim.

Exemplo:
Um produto pode aparecer como:

```txt
剃须刀（USB、数显） / KM-3385
```

e o sistema traduzir como “barbeador elétrico com display digital e USB”.

Mas em outro catálogo pode aparecer como:

```txt
Electric Shaver KM3385
```

ou Rafael pode mandar uma foto da embalagem com o código `KM-3385`.

Então a busca precisa usar múltiplos sinais:

- nome em português;
- nome original;
- texto original;
- marca;
- código/modelo;
- função comercial;
- categoria;
- atributos técnicos;
- atributos visuais;
- cor;
- aliases/sinônimos;
- texto visível na imagem enviada;
- embedding textual;
- embedding visual da página inteira.

## Regra importante

Não voltar para crop.
Não detectar boxes.
Não treinar modelo.
Não usar Roboflow, YOLO, RT-DETR, PaddleX, Detectron2 ou Document AI.
Não implementar recorte de produto.

A melhoria agora é:

```txt
Busca híbrida por produto detectado + página visualmente parecida
```

Mas a função comercial continua mandando mais que aparência.

Exemplo:
Imagem: antena com cabo preto.
Não pode retornar cabo USB preto como resultado principal só porque é visualmente parecido.

---

# Parte 1 — Melhorar PageProductMention com marca, códigos e aliases

## 1. Atualizar Prisma schema

Adicionar em `PageProductMention`:

```prisma
brand String?
modelCodes String[] @default([])
aliases String[] @default([])
```

Adicionar índice:

```prisma
@@index([brand])
```

Manter os campos existentes:

- `namePt`
- `originalName`
- `descriptionPt`
- `category`
- `functionGroup`
- `colors`
- `visualAttributes`
- `technicalAttributes`
- `notConfuseWith`
- `commercialUse`
- `evidenceText`
- `searchText`
- `embedding`
- `displayOrder`

Criar migration segura.

## 2. Atualizar `page-product-analyzer.ts`

No schema Zod do produto, adicionar:

```ts
brand?: string | null;
modelCodes: string[];
aliases: string[];
```

Atualizar prompt do analyzer para pedir explicitamente:

Para cada produto, retorne:

- marca, se visível;
- códigos/modelos/SKUs visíveis;
- aliases/sinônimos comerciais;
- texto original relevante;
- nome em português;
- função comercial normalizada;
- categoria;
- atributos visuais;
- atributos técnicos;
- cores;
- produtos que não devem ser confundidos.

### Regra de código/modelo

Extrair códigos como:

```txt
KM-7103
KM-293
BMQ-KM-7108
LFJ-3124
TXD-KM-T389
KM-3385
BMQ-3006
```

Não deixar esses códigos apenas dentro de `descriptionPt` ou `evidenceText`.

Exemplo esperado:

```json
{
  "namePt": "Barbeador elétrico 3 em 1",
  "originalName": "拔毛器（三合一、数显、USB） / 包好 / KM-7103",
  "brand": "Kemei",
  "modelCodes": ["KM-7103"],
  "aliases": ["barbeador", "máquina de barbear", "electric shaver", "剃须刀"],
  "functionGroup": "barbeador_eletrico"
}
```

### Regra de aliases

Gerar aliases úteis, sem exagerar.

Exemplos:

Para `barbeador_eletrico`:

```txt
barbeador
máquina de barbear
aparelho de barbear
electric shaver
shaver
剃须刀
```

Para `maquina_cortar_cabelo`:

```txt
máquina de cortar cabelo
cortador de cabelo
hair clipper
clipper
理发器
```

Para `aparador_pelos_nariz`:

```txt
aparador de nariz
aparador nasal
nose trimmer
鼻毛器
```

Para `camera_infantil`:

```txt
câmera infantil
kids camera
children camera
câmera digital infantil
```

Não precisa criar 20 aliases por produto. Algo entre 3 e 8 está bom.

## 3. Atualizar `buildPageProductSearchText`

Incluir no `searchText`:

- `namePt`
- `originalName`
- `descriptionPt`
- `brand`
- `modelCodes`
- `aliases`
- `category`
- `functionGroup`
- `commercialUse`
- `colors`
- `visualAttributes`
- `technicalAttributes`
- `evidenceText`
- `notConfuseWith`

O `searchText` precisa ser multi-sinal. Não pode depender só da tradução.

Exemplo:

```ts
function buildPageProductSearchText(product: PageProductMentionInput) {
  return [
    product.namePt,
    product.originalName,
    product.descriptionPt,
    product.brand ? `marca: ${product.brand}` : null,
    product.modelCodes?.length
      ? `modelos/códigos: ${product.modelCodes.join(", ")}`
      : null,
    product.aliases?.length ? `sinônimos: ${product.aliases.join(", ")}` : null,
    product.category,
    product.functionGroup ? `função: ${product.functionGroup}` : null,
    product.commercialUse ? `uso: ${product.commercialUse}` : null,
    product.colors?.length ? `cores: ${product.colors.join(", ")}` : null,
    product.visualAttributes?.length
      ? `aspecto: ${product.visualAttributes.join(", ")}`
      : null,
    product.technicalAttributes?.length
      ? `técnico: ${product.technicalAttributes.join(", ")}`
      : null,
    product.evidenceText
      ? `texto original/evidência: ${product.evidenceText}`
      : null,
    product.notConfuseWith?.length
      ? `Não confundir com: ${product.notConfuseWith.join(", ")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}
```

---

# Parte 2 — Melhorar análise da imagem enviada pelo Rafael

## 4. Atualizar `query-image-analyzer.ts`

Adicionar no `ImageQueryProfile`:

```ts
brand?: string | null;
modelCodes: string[];
visibleText: string[];
```

Atualizar prompt:

Quando Rafael enviar uma imagem, o modelo deve extrair:

- produto principal;
- função comercial;
- categoria;
- marca visível;
- códigos/modelos visíveis;
- texto visível na embalagem/produto;
- cores;
- atributos visuais;
- atributos técnicos;
- sinônimos possíveis;
- produtos que não devem ser confundidos.

Exemplo:

Imagem com embalagem Kemei KM-7103:

```json
{
  "mainProductNamePt": "Barbeador elétrico 3 em 1",
  "functionGroup": "barbeador_eletrico",
  "category": "Cuidados pessoais",
  "brand": "Kemei",
  "modelCodes": ["KM-7103"],
  "visibleText": ["Kemei", "KM-7103", "USB", "3 em 1"],
  "colors": ["dourado", "roxo"],
  "visualAttributes": ["formato compacto", "cabeças intercambiáveis"],
  "technicalAttributes": ["USB", "3 em 1"],
  "possibleSynonyms": ["barbeador", "máquina de barbear", "electric shaver"],
  "mustNotMatch": ["aparador de nariz", "cabo USB", "carregador USB"],
  "confidence": 0.9
}
```

## 5. Atualizar `buildImageQuerySearchText`

Incluir:

- `mainProductNamePt`
- `brand`
- `modelCodes`
- `visibleText`
- `functionGroup`
- `category`
- `commercialUse`
- `colors`
- `visualAttributes`
- `technicalAttributes`
- `possibleSynonyms`
- `mustNotMatch`

---

# Parte 3 — Atualizar reranking comercial

## 6. Atualizar `rerank-page-products.ts`

Adicionar `brand`, `modelCodes`, `aliases`, `originalName`, `evidenceText` ao tipo `PageProductMentionLike`.

### Normalização de código/modelo

Criar helper:

```ts
function normalizeModelCode(value: string): string {
  return value
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]/g, "");
}
```

Assim:

```txt
KM-7103 == KM7103
BMQ-KM-7108 == BMQKM7108
```

### Regra de código/modelo

Se `query.modelCodes` e `candidate.modelCodes` tiverem interseção normalizada:

```txt
matchType = exact
confidence = high
score muito alto
reason = "mesmo código/modelo"
```

Código/modelo igual pesa mais que nome traduzido.

### Regra de marca

Se `query.brand` e `candidate.brand` forem iguais e `functionGroup` também bater:

- dar bônus;
- aumentar confiança.

Mas marca igual sozinha não basta.

Exemplo:
Kemei tem barbeador, aparador, máquina de cabelo etc.
Marca igual sem função igual não pode virar match forte.

### Regra de visibleText

Se `query.visibleText` bater com:

- `candidate.modelCodes`
- `candidate.originalName`
- `candidate.evidenceText`
- `candidate.aliases`
- `candidate.brand`

dar bônus.

### Regra absoluta

Aparência e cor não vencem função comercial.

Se `functionGroup` for diferente e não houver código/modelo batendo:

- não retornar alta confiança;
- não retornar média confiança;
- classificar como `related_but_not_match` ou `rejected`.

---

# Parte 4 — Salvar embedding visual da página inteira

## 7. Descobrir dimensão do embedding visual atual

O projeto já tem:

```txt
src/features/visual-search/embeddings.ts
```

Verificar a dimensão retornada por:

```ts
generateImageEmbeddingFromPath;
generateImageEmbeddingFromFile;
```

Usar essa dimensão no Prisma.

Não chutar dimensão. O campo vector precisa bater exatamente.

## 8. Atualizar Prisma schema

Adicionar em `CatalogPage`:

```prisma
visualEmbedding Unsupported("vector(DIM)")?
```

Trocar `DIM` pela dimensão real.

Criar migration segura.

Se o modelo atual usar `vector(768)`, usar `vector(768)`.
Se usar outra dimensão, usar a dimensão real.

## 9. Atualizar `process-catalog.ts`

No modo `page_mentions`, depois de criar `CatalogPage`, gerar embedding visual da página inteira:

```ts
const pageVisualEmbedding = await generateImageEmbeddingFromPath(imagePath);
```

Salvar via SQL raw:

```ts
const vectorStr = `[${pageVisualEmbedding.join(",")}]`;

await prisma.$executeRaw`
  UPDATE "CatalogPage"
  SET "visualEmbedding" = ${vectorStr}::vector
  WHERE id = ${catalogPage.id}
`;
```

Se der erro:

- não falhar o catálogo inteiro;
- incrementar `pageVisualEmbeddingErrorCount`;
- salvar aviso em `Catalog.error` no final.

Adicionar ao summary:

```txt
pageVisualEmbeddingErrorCount
```

## 10. Índice vetorial para `CatalogPage.visualEmbedding`

Criar migration com índice vetorial, se suportado pelo Supabase/pgvector.

Exemplo:

```sql
CREATE INDEX IF NOT EXISTS "CatalogPage_visualEmbedding_idx"
ON "CatalogPage"
USING ivfflat ("visualEmbedding" vector_cosine_ops)
WITH (lists = 100);
```

Se não for seguro agora, documentar como futura otimização. Mas se já foi feito para `PageProductMention.embedding`, repetir o padrão.

---

# Parte 5 — Busca híbrida

## 11. Atualizar `page-search.ts`

Hoje a busca faz:

```txt
ImageQueryProfile
→ text embedding
→ busca em PageProductMention.embedding
→ rerank
→ agrupa por página
```

Adicionar também:

```txt
imagem enviada
→ image embedding
→ busca em CatalogPage.visualEmbedding
→ juntar por pageId
```

Criar função:

```ts
searchCatalogPagesByVisualEmbedding(args: {
  imageEmbedding: number[];
  limit?: number;
}): Promise<Array<{
  pageId: string;
  catalogId: string;
  supplierId: string;
  supplierName: string;
  catalogFileName: string;
  pageNumber: number;
  pageImageUrl: string;
  visualSimilarity: number;
}>>;
```

## 12. Como combinar os resultados

A busca semântica por `PageProductMention` continua sendo principal.

A busca visual por página inteira é apoio.

Regras:

### Caso A — página aparece na busca semântica e visual

Aumentar score.

```txt
scoreFinal = semanticScore * 0.75 + visualSimilarity * 0.25
```

Mostrar na UI:

```txt
Também houve similaridade visual com a página.
```

### Caso B — página aparece só na semântica

Pode aparecer normalmente.

### Caso C — página aparece só na visual

Não pode virar alta confiança.

Só pode aparecer como baixa confiança se:

- visualSimilarity for alto;
- a página tiver algum `PageProductMention` com `functionGroup` relacionado ao query;
- não violar `mustNotMatch`.

Se a página visualmente parece com a imagem, mas os produtos detectados são de função diferente, não retornar como resultado principal.

Exemplo:
Imagem: antena com cabo preto.
Página visual parecida: cabo USB preto.
Resultado: não mostrar como match forte.

## 13. Atualizar `PageSearchResult`

Adicionar campos opcionais:

```ts
visualSimilarity?: number;
matchedByVisualPage?: boolean;
semanticScore?: number;
```

Na UI, mostrar discreto:

```txt
Similaridade visual com a página: 82%
```

Mas não deixar isso parecer mais importante que produto/função.

---

# Parte 6 — Atualizar scripts

## 14. Atualizar `test-page-analyzer.ts`

Imprimir também:

- brand;
- modelCodes;
- aliases principais;
- displayOrder.

Exemplo:

```txt
1. Barbeador elétrico 3 em 1 | brand=Kemei | codes=KM-7103 | functionGroup=barbeador_eletrico
```

## 15. Atualizar `test-page-search.ts`

Imprimir no query profile:

- brand;
- modelCodes;
- visibleText;
- functionGroup;
- mustNotMatch.

Nos resultados, imprimir:

- matchType;
- confidence;
- semanticScore;
- visualSimilarity;
- matchedByVisualPage;
- reason.

Com `--debug`, continuar mostrando também resultados filtrados.

---

# Parte 7 — Atualizar UI

## 16. Página do catálogo

Em `/catalogos/[catalogId]`, na lista de produtos por página, mostrar discretamente:

```txt
Kemei · KM-7103
```

Abaixo do nome do produto.

Exemplo:

```txt
1. Barbeador elétrico 3 em 1
   Kemei · KM-7103
   Cuidados pessoais · barbeador_eletrico
```

## 17. Página de busca

Em `/busca`, no card do resultado, mostrar se houver:

```txt
Marca: Kemei
Código/modelo: KM-7103
Similaridade visual da página: 84%
```

Não poluir demais. Mostrar só quando existir.

---

# Parte 8 — Encontrar página que falhou no analyzer

O catálogo atual mostrou:

```txt
Processado com avisos: 1 página falharam no analyzer.
```

Adicionar ou melhorar debug para localizar fácil as páginas que falharam.

Pode ser:

- mostrar no detalhe do catálogo uma seção “Avisos de processamento”;
- ou mostrar página com erro em destaque;
- ou criar script.

Script sugerido:

```txt
scripts/debug-catalog-processing.ts
```

Uso:

```bash
npx tsx scripts/debug-catalog-processing.ts <catalogId>
```

Deve imprimir:

```txt
Catalog: catalogo.pdf
status: READY
pageCount: 49
pageProductCount: 366

Analyzer errors:
- page 12: OpenAI response truncated...
```

Critério:
Eu preciso conseguir saber qual página falhou sem abrir banco manualmente.

---

# Parte 9 — Validação

Depois de alterar:

```bash
npx prisma generate
pnpm lint
pnpm build
npx tsc --noEmit
```

Rodar analyzer:

```bash
npx tsx scripts/test-page-analyzer.ts ~/Downloads/catalogo.pdf 4 5
```

Esperado:

- produtos com marca `Kemei`;
- códigos como `KM-7103`, `KM-293`, `LFJ-3124`, `BMQ-KM-7108`;
- aliases preenchidos;
- ordem visual preservada;
- kit só quando for realmente kit/combo/conjunto.

Depois reprocessar catálogo:

```bash
curl -X POST http://localhost:3000/api/catalogs/<catalogId>/reprocess
```

Depois testar busca:

```bash
npx tsx scripts/test-page-search.ts --image ~/Downloads/camera-rosa.jpg
npx tsx scripts/test-page-search.ts --image ~/Downloads/camera-rosa.jpg --debug
```

Também testar imagem com produto que tenha código/modelo visível.

---

# Critério de aceite final

A alteração só está correta se:

1. `PageProductMention` salva `brand`, `modelCodes` e `aliases`.
2. Produtos Kemei extraem `brand="Kemei"`.
3. Códigos como `KM-7103`, `KM-293`, `LFJ-3124`, `BMQ-KM-7108`, `TXD-KM-T389` entram em `modelCodes`.
4. `searchText` inclui nome português, nome original, evidência, marca, códigos, aliases, função, atributos e textos úteis.
5. `ImageQueryProfile` extrai `brand`, `modelCodes` e `visibleText` da imagem enviada.
6. Código/modelo igual gera match forte.
7. Marca igual ajuda, mas não vence função comercial.
8. `CatalogPage` salva embedding visual da página inteira.
9. Busca por imagem usa dois sinais:
   - semântico por produto detectado;
   - visual por página inteira.

10. Similaridade visual da página ajuda, mas não passa por cima de função comercial.
11. Visual sozinho não gera alta confiança.
12. Produto visualmente parecido, mas função diferente, continua rejeitado ou rebaixado.
13. UI mostra marca/código quando existir.
14. Script/debug mostra qual página falhou no analyzer.
15. `pnpm lint`, `pnpm build`, `npx tsc --noEmit` e `npx prisma generate` passam.

## Lembrete final

Não resolver isso voltando para recorte.

A página inteira é o resultado visual.

O produto detectado dentro da página é a unidade de inteligência.

A busca deve ser híbrida:

```txt
texto/código/função/atributos
+
visual da página inteira
```

Mas a função comercial continua mandando mais que aparência.
