# Buscador Inteligente — Mudança de Estratégia: Busca por Página + Produtos Detectados

## Leia antes de mexer no código

Este projeto mudou de direção.

Antes o sistema tentava detectar e recortar cada produto/card dentro das páginas dos PDFs. Isso gerou complexidade alta demais: GRID_LAYOUT, PDF_LAYOUT, heurísticas, validação de crop, crops multi-produto, boxes errados, etc.

A nova estratégia é mais simples e deve substituir o foco anterior:

> O sistema NÃO precisa mais recortar produtos individualmente.
> O sistema deve renderizar cada página do PDF, entender quais produtos existem naquela página e salvar a página inteira como resultado visual.

A busca por imagem continua existindo, mas o retorno agora será a **página do catálogo** onde o produto aparece, não um crop recortado do produto.

---

## Objetivo real do sistema

O Buscador Inteligente é um buscador interno para Rafael encontrar rapidamente em quais fornecedores existe determinado produto dentro de uma base fechada de catálogos PDF.

Não é Google Lens genérico.

O usuário envia uma imagem, foto, print ou embalagem de um produto. O sistema deve entender o produto buscado e retornar páginas dos catálogos de fornecedores que contenham produtos iguais, equivalentes ou parecidos dentro da mesma função comercial.

Exemplo correto:

- Imagem enviada: câmera infantil rosa.
- Resultado: páginas que tenham câmera infantil rosa, câmera infantil parecida, câmera infantil equivalente.
- Resultado errado: página com fone rosa, caixa rosa, cabo rosa ou brinquedo rosa que não seja câmera.

Exemplo correto:

- Imagem enviada: antena com cabo preto.
- Resultado: páginas que tenham antena, antena digital, antena interna, antena parecida.
- Resultado errado: cabo USB preto, cabo HDMI preto, cabo de energia preto, adaptador ou carregador só porque visualmente tem cabo preto.

A regra central agora é:

> A página é o resultado visual.
> O produto detectado dentro da página é a unidade de inteligência.

---

## Nova regra principal

Antes:

```txt
Produto válido = crop correto do produto/card + fornecedor + catálogo + página + embedding visual
```

Agora:

```txt
Resultado válido = página correta do catálogo + fornecedor + catálogo + número da página + produtos detectados naquela página
```

O sistema não precisa mais resolver crop perfeito.

Mas ele precisa resolver uma coisa muito bem:

> Identificar e registrar quais produtos existem em cada página.

Se isso não for feito, a busca vira apenas comparação de imagem contra página inteira, o que vai dar resultado ruim em páginas com muitos produtos.

---

## Não fazer

Não implementar agora:

- recorte obrigatório de produto/card;
- detector treinável;
- Roboflow;
- YOLO;
- RT-DETR;
- PaddleX;
- LayoutParser;
- Detectron2;
- Google Document AI;
- AWS Textract;
- segmentação de produto;
- boxes obrigatórias;
- treinamento de modelo próprio;
- OCR avançado como solução principal;
- marketplace;
- WhatsApp;
- pedido;
- estoque;
- CRM;
- pagamento;
- nota fiscal;
- app mobile.

Também não manter a obsessão antiga de “produto pesquisável = crop correto”. Isso mudou.

---

## O que deve acontecer no upload de PDF

Quando Rafael subir um PDF de fornecedor:

1. Salvar o PDF original no Supabase Storage.
2. Renderizar cada página como imagem.
3. Salvar cada imagem de página no Supabase Storage.
4. Extrair texto/estrutura do PDF quando possível usando o que já existe com PyMuPDF.
5. Enviar cada página para um analisador multimodal.
6. O analisador deve retornar uma lista estruturada dos produtos presentes naquela página.
7. Salvar esses produtos como registros associados à página.
8. Gerar texto normalizado de busca para cada produto detectado.
9. Gerar embedding textual/semântico para cada produto detectado.
10. A página inteira continua sendo a imagem exibida no resultado.

Não gerar crop por produto nesse novo fluxo.

---

## Novo conceito: PageProductMention

Criar um modelo novo no Prisma para representar um produto detectado dentro de uma página, sem crop.

Nome sugerido:

```prisma
model PageProductMention {
  id          String   @id @default(cuid())

  catalogId   String
  pageId      String

  pageNumber  Int

  namePt          String
  originalName    String?
  descriptionPt   String?
  category        String?
  functionGroup   String?

  colors              String[]
  visualAttributes    Json?
  technicalAttributes Json?
  commercialUse       String?

  isKit           Boolean @default(false)
  kitContains     Json?

  confidence      Float?
  evidenceText    String?
  evidenceSource  String? // "vision", "pdf_text", "both", "manual"

  searchText      String
  embedding       Unsupported("vector(1536)")?

  rawJson         Json?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  catalog Catalog     @relation(fields: [catalogId], references: [id], onDelete: Cascade)
  page    CatalogPage @relation(fields: [pageId], references: [id], onDelete: Cascade)

  @@index([catalogId])
  @@index([pageId])
  @@index([functionGroup])
  @@index([category])
  @@index([pageNumber])
}
```

Se o projeto preferir outro tamanho de embedding, ajustar `vector(1536)` conforme o provider/modelo usado. O importante é separar esse embedding textual/semântico do embedding visual antigo de crop.

Não tentar reaproveitar `ProductCandidate` como produto principal novo. `ProductCandidate` representa a estratégia antiga de crop. Pode continuar existindo por compatibilidade, mas a nova busca deve usar `PageProductMention`.

Também adicionar relação em `CatalogPage`:

```prisma
productMentions PageProductMention[]
```

E em `Catalog`:

```prisma
productMentions PageProductMention[]
```

Se quiser evitar alterar demais a UI antiga, pode manter `candidateCount`, mas adicionar um campo mais correto em `Catalog`, por exemplo:

```prisma
pageProductCount Int?
```

---

## Analisador de página

Criar arquivo:

```txt
src/features/catalog-processing/page-product-analyzer.ts
```

Responsabilidade:

- receber a imagem da página renderizada;
- receber textos extraídos via PyMuPDF quando existirem;
- pedir para o modelo multimodal listar os produtos presentes;
- retornar JSON validado com Zod;
- não pedir bounding boxes;
- não pedir crop;
- não pedir coordenadas obrigatórias.

Entrada sugerida:

```ts
export async function analyzeCatalogPageProducts(args: {
  pageImagePath: string;
  pageNumber: number;
  supplierName?: string;
  catalogFileName?: string;
  pdfTextBlocks?: Array<{
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}): Promise<PageProductAnalysis>;
```

Schema de retorno sugerido:

```ts
export type PageProductAnalysis = {
  pageNumber: number;
  products: Array<{
    namePt: string;
    originalName?: string | null;
    descriptionPt?: string | null;
    category?: string | null;
    functionGroup: string;
    colors?: string[];
    visualAttributes?: string[];
    technicalAttributes?: string[];
    commercialUse?: string | null;
    isKit?: boolean;
    kitContains?: string[];
    confidence: number;
    evidenceText?: string | null;
    evidenceSource: "vision" | "pdf_text" | "both" | "manual";
    notConfuseWith?: string[];
  }>;
  pageSummary?: string;
  hasProducts: boolean;
};
```

Exemplo de produto detectado:

```json
{
  "namePt": "Câmera infantil rosa",
  "originalName": "Kids Camera",
  "descriptionPt": "Câmera digital infantil na cor rosa com tela e botões.",
  "category": "Eletrônicos infantis",
  "functionGroup": "camera_infantil",
  "colors": ["rosa"],
  "visualAttributes": ["tela pequena", "botões frontais", "formato compacto"],
  "technicalAttributes": ["câmera digital"],
  "commercialUse": "tirar fotos e gravar vídeos",
  "isKit": false,
  "kitContains": [],
  "confidence": 0.91,
  "evidenceText": "Kids Camera",
  "evidenceSource": "both",
  "notConfuseWith": ["fone rosa", "brinquedo rosa sem câmera", "capa rosa"]
}
```

---

## Prompt interno para análise da página

O prompt do modelo deve ser rígido.

Ele precisa dizer claramente:

- analise a página inteira do catálogo;
- liste apenas produtos reais que aparecem na página;
- não liste títulos, banners, categorias, rodapés, marcas soltas ou decoração;
- não invente produtos;
- não precisa de bounding boxes;
- não precisa de crop;
- traduza nomes e descrições para português;
- normalize a função comercial;
- se houver muitos produtos, liste todos os produtos principais visíveis;
- se houver kit, marque como kit;
- se algo for acessório, classifique corretamente como acessório, não como produto equivalente a outro.

Prompt base sugerido:

```txt
Você está analisando uma página de catálogo de fornecedor.

Sua tarefa é identificar quais produtos reais aparecem nesta página.

Não retorne bounding boxes.
Não retorne coordenadas.
Não recorte produtos.
Não invente produtos.
Não liste banners, títulos de seção, marcas, rodapés, selos, chamadas promocionais ou categorias como se fossem produtos.

Para cada produto encontrado, retorne:
- nome em português;
- nome original, se houver;
- descrição curta em português;
- categoria comercial;
- função comercial normalizada;
- cores principais;
- atributos visuais;
- atributos técnicos, se visíveis;
- se é kit ou produto individual;
- evidência textual usada;
- nível de confiança;
- produtos com os quais NÃO deve ser confundido.

A função comercial é mais importante que aparência.
Exemplo: uma antena com cabo preto não deve ser confundida com um cabo USB preto.
Exemplo: uma câmera rosa não deve ser confundida com um fone rosa.
Exemplo: um carregador não deve ser confundido com um adaptador ou cabo apenas por aparecerem juntos.

Responda somente JSON válido no schema solicitado.
```

---

## Geração do searchText

Para cada `PageProductMention`, gerar um campo `searchText` consolidado.

Exemplo:

```ts
function buildPageProductSearchText(product: PageProductMentionInput) {
  return [
    product.namePt,
    product.originalName,
    product.descriptionPt,
    product.category,
    product.functionGroup,
    product.commercialUse,
    product.colors?.join(", "),
    product.visualAttributes?.join(", "),
    product.technicalAttributes?.join(", "),
    product.kitContains?.join(", "),
    product.notConfuseWith?.length
      ? `Não confundir com: ${product.notConfuseWith.join(", ")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}
```

Esse `searchText` deve ser salvo no banco e usado para embedding textual.

---

## Embeddings

Criar função para gerar embedding textual:

```txt
src/features/semantic-search/text-embeddings.ts
```

Responsabilidade:

```ts
export async function generateTextEmbedding(text: string): Promise<number[]>;
```

Usar provider configurável por `.env`.

Sugestão de envs:

```env
TEXT_EMBEDDING_PROVIDER="openai"
TEXT_EMBEDDING_MODEL="..."
TEXT_EMBEDDING_DIMENSIONS="1536"
```

Não hardcodar modelo se já existir padrão no projeto. Validar dimensão com o schema Prisma.

A busca nova deve priorizar embedding textual/semântico de `PageProductMention`, não embedding visual de crop.

---

## Busca por imagem

Criar arquivo:

```txt
src/features/visual-search/query-image-analyzer.ts
```

Responsabilidade:

Quando Rafael envia uma imagem, o sistema deve transformar essa imagem em um perfil estruturado de busca.

Exemplo de retorno:

```ts
export type ImageQueryProfile = {
  mainProductNamePt: string;
  functionGroup: string;
  category?: string;
  colors?: string[];
  visualAttributes?: string[];
  technicalAttributes?: string[];
  commercialUse?: string;
  possibleSynonyms?: string[];
  mustNotMatch?: string[];
  ambiguityNotes?: string[];
  confidence: number;
};
```

Exemplo real:

Imagem: antena com cabo preto.

Perfil esperado:

```json
{
  "mainProductNamePt": "Antena digital interna",
  "functionGroup": "antena",
  "category": "Eletrônicos / recepção de sinal",
  "colors": ["preto"],
  "visualAttributes": ["cabo preto", "base compacta", "formato pequeno"],
  "technicalAttributes": ["possível conector coaxial"],
  "commercialUse": "captar sinal de TV ou rádio",
  "possibleSynonyms": ["antena interna", "antena digital", "indoor antenna"],
  "mustNotMatch": [
    "cabo USB",
    "cabo HDMI",
    "cabo de energia",
    "carregador",
    "adaptador",
    "fone"
  ],
  "ambiguityNotes": [],
  "confidence": 0.88
}
```

Imagem: câmera rosa.

Perfil esperado:

```json
{
  "mainProductNamePt": "Câmera infantil rosa",
  "functionGroup": "camera_infantil",
  "category": "Eletrônicos infantis",
  "colors": ["rosa"],
  "visualAttributes": ["tela pequena", "botões frontais", "formato compacto"],
  "technicalAttributes": ["câmera digital"],
  "commercialUse": "tirar fotos e gravar vídeos",
  "possibleSynonyms": [
    "kids camera",
    "children camera",
    "câmera digital infantil"
  ],
  "mustNotMatch": [
    "fone rosa",
    "cabo rosa",
    "case rosa",
    "brinquedo rosa sem câmera"
  ],
  "ambiguityNotes": [],
  "confidence": 0.9
}
```

---

## Busca semântica contra PageProductMention

Atualizar ou criar o endpoint de busca por imagem para usar este fluxo:

1. Receber imagem enviada pelo Rafael.
2. Rodar `analyzeImageQueryProfile`.
3. Gerar `querySearchText`.
4. Gerar embedding textual da query.
5. Consultar `PageProductMention.embedding` com pgvector.
6. Re-ranquear resultados com regras comerciais.
7. Agrupar resultados por página.
8. Retornar página inteira, fornecedor, catálogo, número da página e produto detectado que causou o match.

A busca NÃO deve retornar diretamente “página parecida visualmente” sem explicar qual produto da página deu match.

---

## QuerySearchText

Criar texto de busca a partir do perfil da imagem:

```ts
function buildImageQuerySearchText(profile: ImageQueryProfile) {
  return [
    profile.mainProductNamePt,
    profile.functionGroup,
    profile.category,
    profile.commercialUse,
    profile.colors?.join(", "),
    profile.visualAttributes?.join(", "),
    profile.technicalAttributes?.join(", "),
    profile.possibleSynonyms?.join(", "),
    profile.mustNotMatch?.length
      ? `Não confundir com: ${profile.mustNotMatch.join(", ")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}
```

---

## Regras de ranking

Não confiar só na distância vetorial.

Depois do pgvector, aplicar reranking.

Campos mínimos do resultado:

```ts
type PageSearchResult = {
  pageId: string;
  catalogId: string;
  supplierId: string;
  supplierName: string;
  catalogFileName: string;
  pageNumber: number;
  pageImageUrl: string;

  matchedProductMentionId: string;
  matchedProductName: string;
  matchedFunctionGroup: string;
  matchType:
    | "exact"
    | "equivalent"
    | "variant"
    | "kit_contains"
    | "accessory"
    | "related_but_not_match"
    | "rejected";

  confidence: "high" | "medium" | "low";
  score: number;
  reason: string;
};
```

Regras:

### Alta confiança

Só pode ser alta se:

- mesma função comercial;
- produto principal compatível;
- atributos principais batem;
- não viola `mustNotMatch`;
- não é apenas acessório relacionado.

Exemplo:

```txt
Busca: câmera infantil rosa
Resultado: câmera infantil rosa
Alta confiança
```

### Média confiança

- mesma função comercial;
- produto equivalente ou variação;
- cor/modelo pode diferir.

Exemplo:

```txt
Busca: câmera infantil rosa
Resultado: câmera infantil azul
Média confiança
```

### Baixa confiança

- parece relacionado;
- falta evidência textual;
- modelo/cor/função parcialmente ambígua;
- precisa validação humana.

### Rejeitado

Rejeitar ou esconder resultado quando:

- função comercial diferente;
- mesma cor mas produto diferente;
- acessório sozinho;
- produto complementar;
- mesmo contexto, mas uso diferente.

Exemplo:

```txt
Busca: antena com cabo preto
Resultado: cabo USB preto
Rejeitado
Motivo: função comercial diferente. O item é cabo USB, não antena.
```

---

## Regra absoluta: função comercial primeiro

O sistema deve comparar nesta ordem:

1. função comercial;
2. produto principal;
3. categoria;
4. atributos técnicos;
5. atributos visuais;
6. cor;
7. aparência geral.

Nunca deixar cor ou aparência geral vencer função comercial.

Exemplo:

```txt
câmera rosa ≠ fone rosa
antena com cabo preto ≠ cabo USB preto
carregador ≠ cabo
adaptador ≠ carregador
ring light ≠ luminária genérica
microfone ≠ lanterna
controle remoto ≠ calculadora
```

---

## Página com muitos produtos

Uma página pode conter muitos produtos. Isso é normal.

A busca deve retornar a página, mas sempre dizendo:

```txt
Esta página foi retornada porque contém: [produto detectado]
```

Não retornar apenas:

```txt
Página parecida
```

Isso é insuficiente.

O resultado precisa mostrar:

- fornecedor;
- catálogo;
- página;
- produto detectado na página;
- tipo de match;
- confiança;
- motivo;
- botão para abrir página inteira.

---

## UI esperada

Atualizar a UI de resultados para trabalhar com página inteira.

Card de resultado:

```txt
Fornecedor: Eletromex
Catálogo: ELETROMEX-13.05.2026.pdf
Página: 34

Produto encontrado na página:
Câmera infantil rosa

Tipo de match:
Produto equivalente

Confiança:
Alta

Motivo:
Mesma função comercial “camera_infantil”, mesma cor rosa e atributos visuais compatíveis.

[Abrir página do catálogo]
```

Ao abrir a página:

- mostrar imagem da página inteira;
- listar ao lado os produtos detectados naquela página;
- destacar textualmente o produto que causou o match;
- não precisa destacar visualmente com box.

---

## Atualizar processamento de catálogo

Arquivo principal provável:

```txt
src/features/catalog-processing/process-catalog.ts
```

Alterar fluxo para:

1. renderizar páginas como já faz;
2. salvar página no Storage como já faz;
3. extrair layout/texto via PyMuPDF como já faz;
4. chamar `analyzeCatalogPageProducts`;
5. criar registros `PageProductMention`;
6. gerar embeddings textuais;
7. não gerar crops;
8. não gerar ProductCandidate para cada produto no novo modo.

Adicionar env de modo de processamento:

```env
CATALOG_PROCESSING_MODE="page_mentions"
```

Valores possíveis:

```txt
page_mentions
legacy_crops
```

O default novo deve ser `page_mentions`.

Manter `legacy_crops` temporariamente para não quebrar código antigo, mas a direção do produto agora é `page_mentions`.

---

## Atualizar busca

Arquivo provável:

```txt
src/app/api/search/route.ts
```

ou equivalente.

Novo fluxo:

```txt
Imagem enviada
→ analyzeImageQueryProfile
→ buildImageQuerySearchText
→ generateTextEmbedding
→ pgvector em PageProductMention
→ rerank comercial
→ agrupar por página
→ retornar páginas
```

Não usar `ProductCandidate` como fonte principal da busca nova.

Se quiser manter compatibilidade:

```env
SEARCH_MODE="page_mentions"
```

Valores:

```txt
page_mentions
legacy_candidates
```

Default novo:

```txt
page_mentions
```

---

## Reranking comercial

Criar arquivo:

```txt
src/features/semantic-search/rerank-page-products.ts
```

Entrada:

```ts
rerankPageProductMentions({
  queryProfile,
  candidates,
});
```

Saída:

```ts
Array<{
  mention: PageProductMention;
  matchType:
    | "exact"
    | "equivalent"
    | "variant"
    | "kit_contains"
    | "accessory"
    | "related_but_not_match"
    | "rejected";
  confidence: "high" | "medium" | "low";
  score: number;
  reason: string;
}>;
```

Regras mínimas:

```ts
if (candidate.functionGroup !== query.functionGroup) {
  // Não necessariamente rejeitar sempre, porque nomes podem variar,
  // mas aplicar penalidade forte e checar mustNotMatch.
}

if (query.mustNotMatch includes candidate.functionGroup/category/name) {
  reject.
}

if same functionGroup and same main product:
  exact/equivalent.

if same functionGroup but color/model differs:
  variant.

if candidate.isKit and kitContains includes query product:
  kit_contains.

if candidate is accessory of query:
  accessory, not primary.

if functionGroup different:
  related_but_not_match or rejected.
```

Não mostrar `rejected` para Rafael por padrão. Guardar apenas para debug/log.

---

## Debug e auditoria

Salvar raw JSON da análise da página em `PageProductMention.rawJson` e/ou `PageAnalysis`.

Criar tela ou seção de debug por página:

- imagem da página;
- produtos detectados;
- functionGroup;
- confidence;
- evidenceText;
- searchText;
- rawJson;
- botão para marcar manualmente erro depois.

Não precisa fazer edição manual agora se for grande demais, mas o schema deve permitir revisar no futuro.

---

## Scripts de teste

Criar scripts novos:

```txt
scripts/test-page-analyzer.ts
scripts/test-page-search.ts
```

### test-page-analyzer.ts

Uso:

```bash
npx tsx scripts/test-page-analyzer.ts "$HOME/Downloads/catalogo.pdf" 3 4 5 6 17 26 60
```

Deve:

- renderizar páginas pedidas;
- analisar cada página;
- imprimir produtos detectados;
- imprimir functionGroup;
- imprimir confiança;
- salvar JSON de debug.

Saída esperada exemplo:

```txt
page 34
products=4
- Câmera infantil rosa | functionGroup=camera_infantil | confidence=0.91
- Câmera infantil azul | functionGroup=camera_infantil | confidence=0.88
- Mini impressora térmica rosa | functionGroup=mini_impressora | confidence=0.86
- Projetor infantil | functionGroup=projetor | confidence=0.81
```

### test-page-search.ts

Uso:

```bash
npx tsx scripts/test-page-search.ts --image "$HOME/Downloads/camera-rosa.jpg"
```

Deve:

- analisar imagem de busca;
- imprimir query profile;
- buscar PageProductMention;
- mostrar páginas ranqueadas;
- mostrar motivo.

Saída esperada exemplo:

```txt
query:
mainProduct=Câmera infantil rosa
functionGroup=camera_infantil
mustNotMatch=fone rosa, cabo rosa, brinquedo rosa sem câmera

results:
1. Eletromex p.34 | Câmera infantil rosa | exact | high
   reason: mesma função comercial, mesma cor, atributos compatíveis

2. Fornecedor X p.12 | Câmera infantil azul | variant | medium
   reason: mesma função comercial, cor diferente

rejected/debug:
- Fornecedor Y p.8 | Fone rosa | rejected
  reason: cor igual, função comercial diferente
```

---

## Casos obrigatórios para testar

Criar uma lista de casos de teste mental e, se possível, scripts/fixtures depois.

### Caso 1 — Câmera rosa

Busca:

```txt
foto de câmera infantil rosa
```

Deve retornar:

- câmera infantil rosa;
- câmera infantil parecida;
- câmera infantil de outra cor com confiança menor.

Não deve retornar:

- fone rosa;
- cabo rosa;
- case rosa;
- brinquedo rosa sem câmera;
- mini impressora rosa.

### Caso 2 — Antena com cabo preto

Busca:

```txt
foto de antena com cabo preto
```

Deve retornar:

- antena digital;
- antena interna;
- antena com cabo;
- antena parecida.

Não deve retornar:

- cabo USB preto;
- cabo HDMI;
- cabo de energia;
- carregador;
- adaptador;
- fone preto.

### Caso 3 — Carregador

Busca:

```txt
carregador de tomada
```

Deve retornar:

- carregador;
- fonte;
- carregador USB;
- carregador equivalente.

Não deve retornar como principal:

- cabo USB;
- tomada;
- adaptador sem função de carregador;
- power bank, salvo se classificado como produto relacionado e não equivalente.

### Caso 4 — Produto em kit

Busca:

```txt
câmera infantil
```

Página contém:

```txt
kit câmera infantil + cartão + cabo
```

Resultado:

```txt
kit_contains
confiança média/alta
```

Não classificar como produto exato se o item vendido é kit.

### Caso 5 — Página com muitos produtos

Se a página contém 20 produtos, o resultado precisa explicar qual produto da página gerou o match.

---

## Migration e comandos

Depois de alterar schema:

```bash
npx prisma generate
npx prisma migrate dev --name add-page-product-mentions
```

Se estiver em ambiente com shadow DB problemático por pgvector, usar o fluxo já documentado no projeto.

Rodar:

```bash
pnpm lint
pnpm build
```

E testar:

```bash
npx tsx scripts/test-page-analyzer.ts caminho/do/catalogo.pdf 1 2 3 4 5
```

---

## Atualizar documentação

Atualizar:

```txt
README.md
CLAUDE.md
.env.example
```

Documentar claramente:

- nova estratégia page-level;
- recorte de produto não é mais obrigatório;
- produto detectado dentro da página é a unidade de inteligência;
- página inteira é o resultado visual;
- busca usa PageProductMention;
- `ProductCandidate` é legado/compatibilidade;
- envs novas:
  - `CATALOG_PROCESSING_MODE`
  - `SEARCH_MODE`
  - `TEXT_EMBEDDING_PROVIDER`
  - `TEXT_EMBEDDING_MODEL`
  - `TEXT_EMBEDDING_DIMENSIONS`

---

## Segurança

Se houver chaves reais no repositório, `.env`, logs ou histórico:

1. Remover do arquivo.
2. Garantir `.env` no `.gitignore`.
3. Manter apenas `.env.example` sem valores reais.
4. Rotacionar as chaves já expostas:
   - OpenAI;
   - Supabase service role;
   - Supabase database password / DATABASE_URL / DIRECT_URL.

Não seguir sem isso se houver chave real no código.

---

## Critério de aceite

A alteração estará correta quando:

1. Subir PDF renderiza e salva páginas.
2. Cada página tem uma lista de produtos detectados.
3. Nenhum crop de produto é necessário para a busca nova.
4. Busca por imagem retorna páginas do catálogo.
5. Cada resultado mostra o produto detectado que causou o match.
6. Câmera rosa não retorna fone rosa como resultado principal.
7. Antena com cabo preto não retorna cabo USB preto como resultado principal.
8. Produtos com mesma aparência mas função diferente são rejeitados ou rebaixados.
9. Página com vários produtos pode aparecer, mas sempre com explicação do produto correspondente.
10. `ProductCandidate`/crop antigo não é mais a fonte principal da busca nova.
11. `pnpm lint` e `pnpm build` passam.

---

## Orientação final

Não tente resolver o problema antigo de crop.

O sistema agora deve responder:

> “Esse produto aparece nesta página deste fornecedor.”

E não:

> “Aqui está o crop perfeito desse produto.”

A página é o resultado visual.

A lista de produtos detectados dentro da página é a base da inteligência.

A função comercial manda mais que aparência.

Não confundir produto com acessório, cor com função, contexto com equivalência, nem página parecida com produto correto.
