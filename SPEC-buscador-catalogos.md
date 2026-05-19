# Buscador de Catálogos — Especificação Técnica Completa

## Visão geral

Sistema interno para o Rafael buscar produtos por imagem nos catálogos dos fornecedores chineses. Duas funcionalidades apenas: upload de catálogo (PDF) com extração automática de imagens de produtos, e busca por similaridade visual.

## Público

Um único usuário (Rafael). Sem autenticação por enquanto. Sem revisão humana. Tudo automático.

## Stack

- **App**: Next.js 16 (App Router, TypeScript, Tailwind CSS v4, shadcn/ui)
- **Banco**: Supabase PostgreSQL com extensão pgvector
- **Storage**: Supabase Storage (buckets para imagens de produtos)
- **Embeddings**: CLIP via @xenova/transformers (Xenova/clip-vit-base-patch32) — roda no servidor Node
- **Extração de PDF**: `pdfimages` (poppler-utils) para extrair imagens embutidas do PDF
- **Deploy**: Railway (Docker) — permite binários de sistema e modelo CLIP
- **Gerenciador de pacotes**: pnpm

## Schema do banco (Prisma)

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["postgresqlExtensions"]
}

datasource db {
  provider   = "postgresql"
  extensions = [vector]
}

model Supplier {
  id        String    @id @default(cuid())
  name      String    @unique
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
  catalogs  Catalog[]
}

model Catalog {
  id         String         @id @default(cuid())
  supplierId String
  fileName   String
  status     CatalogStatus  @default(PROCESSING)
  pageCount  Int?
  imageCount Int?
  createdAt  DateTime       @default(now())
  updatedAt  DateTime       @updatedAt

  supplier Supplier       @relation(fields: [supplierId], references: [id], onDelete: Cascade)
  images   ProductImage[]

  @@index([supplierId])
  @@index([status])
}

model ProductImage {
  id         String   @id @default(cuid())
  catalogId  String
  imageUrl   String   // URL pública no Supabase Storage
  width      Int
  height     Int
  fileSize   Int?     // bytes
  pageNumber Int?     // página de onde foi extraída (se disponível)
  embedding  Unsupported("vector(512)")? // CLIP embedding 512 dimensões
  createdAt  DateTime @default(now())

  catalog Catalog @relation(fields: [catalogId], references: [id], onDelete: Cascade)

  @@index([catalogId])
}

enum CatalogStatus {
  PROCESSING
  READY
  FAILED
}
```

**Nota sobre pgvector:** A busca por similaridade usa a função `<=>` (distância cosseno) do pgvector diretamente via raw query no Prisma. Exemplo:

```typescript
const results = await prisma.$queryRaw`
  SELECT id, "imageUrl", "catalogId",
         1 - (embedding <=> ${queryVector}::vector) as similarity
  FROM "ProductImage"
  WHERE embedding IS NOT NULL
  ORDER BY embedding <=> ${queryVector}::vector
  LIMIT 20
`;
```

## Supabase Storage

Um bucket chamado `product-images` (público para leitura).

Estrutura dos arquivos:
```
product-images/
  {catalogId}/
    img-001.jpg
    img-002.jpg
    ...
```

O `imageUrl` salvo no banco é a URL pública completa do Supabase Storage.

## Páginas (App Router)

### 1. `/` — Home
- Link para "Enviar catálogo" e "Buscar produto"
- Resumo: total de fornecedores, catálogos e imagens indexadas

### 2. `/fornecedores` — Lista de fornecedores
- Tabela simples: nome, qtd catálogos, data
- Botão "Novo fornecedor" (formulário inline ou dialog)

### 3. `/fornecedores/[id]` — Detalhe do fornecedor
- Lista de catálogos enviados
- Botão "Enviar catálogo" (upload de PDF)
- Status de cada catálogo (processando, pronto, falhou)

### 4. `/catalogos/[id]` — Detalhe do catálogo
- Grid de todas as imagens extraídas (thumbnails)
- Info: nome do arquivo, fornecedor, qtd imagens, status
- Botão para reprocessar se falhou

### 5. `/busca` — Busca por imagem (PÁGINA PRINCIPAL DO RAFAEL)
- Área de upload de imagem (drag & drop ou clique)
- Preview da imagem enviada
- Ao enviar: mostra resultados em grid
- Cada resultado: imagem do catálogo, nome do fornecedor, nome do catálogo, % similaridade
- Clicar no resultado abre a imagem grande

## Rotas de API

### `POST /api/suppliers`
- Body: `{ name: string }`
- Cria fornecedor

### `POST /api/catalogs`
- FormData: `supplierId` + `file` (PDF)
- Salva PDF temporariamente
- Inicia processamento em background (ver fluxo abaixo)
- Retorna imediatamente com status PROCESSING

### `GET /api/catalogs/[id]`
- Retorna catálogo com status e imagens

### `DELETE /api/catalogs/[id]`
- Deleta catálogo, imagens no storage e embeddings

### `POST /api/search`
- FormData: `image` (arquivo de imagem)
- Gera embedding CLIP da imagem
- Busca por similaridade no pgvector
- Retorna top 20 resultados com imageUrl, similarity, supplier, catalog

## Fluxo de processamento do catálogo (background)

Quando um PDF é enviado:

```
1. Salvar PDF em /tmp/{catalogId}.pdf
2. Executar: pdfimages -j {pdf} /tmp/{catalogId}/img
   (-j extrai JPEG como JPEG, PNG como PNG)
3. Listar imagens extraídas em /tmp/{catalogId}/
4. Para cada imagem:
   a. Ler dimensões com sharp
   b. FILTRAR: descartar se width < 150 OU height < 150 (logos, ícones)
   c. FILTRAR: descartar se for quase toda branca (>92% pixels brancos)
   d. Upload para Supabase Storage: product-images/{catalogId}/img-{NNN}.jpg
   e. Gerar embedding CLIP (512 dimensões)
   f. Inserir no banco: ProductImage com imageUrl, width, height, embedding
5. Atualizar Catalog: status = READY, imageCount = total
6. Limpar /tmp/{catalogId}/
```

Se falhar em qualquer passo: status = FAILED, logar erro.

**Filtro de imagens irrelevantes** é crucial. Os catálogos têm logos, ícones, bordas decorativas, imagens de fundo. A regra de tamanho mínimo (150x150) e a regra de "quase branco" eliminam a maioria. Se precisar refinar depois, pode adicionar filtro por aspect ratio (descartar muito fino/largo).

## Fluxo de busca por imagem

```
1. Receber imagem via FormData
2. Validar: é imagem? tamanho < 8MB?
3. Gerar embedding CLIP da imagem (512 dimensões)
4. Query pgvector: buscar top 20 por distância cosseno
5. Retornar resultados com: imageUrl, similarity, supplierName, catalogFileName
```

## Configuração do CLIP (reusar do projeto atual)

O arquivo `src/features/visual-search/embeddings.ts` do projeto atual está bom. Manter a lógica de:
- Cache do modelo em `.cache/transformers/`
- Singleton do extractor (evita recarregar modelo)
- Normalização do vetor
- Funções: `generateImageEmbeddingFromFile`, `generateImageEmbeddingFromBuffer`, `generateImageEmbeddingFromPath`

## Docker (para Railway)

```dockerfile
FROM node:20-slim

# Instalar poppler-utils (pdfimages, pdfinfo)
RUN apt-get update && apt-get install -y \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

EXPOSE 3000
CMD ["pnpm", "start"]
```

## Variáveis de ambiente

```env
DATABASE_URL="postgresql://..."           # Supabase connection string (com pgvector)
DIRECT_URL="postgresql://..."             # Supabase direct connection (para migrations)
SUPABASE_URL="https://xxx.supabase.co"
SUPABASE_ANON_KEY="eyJ..."
SUPABASE_SERVICE_ROLE_KEY="eyJ..."        # Para upload de storage server-side
```

## Estrutura de diretórios (projeto novo)

```
src/
  app/
    page.tsx                    # Home
    layout.tsx
    globals.css
    fornecedores/
      page.tsx                  # Lista fornecedores
      [supplierId]/
        page.tsx                # Detalhe fornecedor + upload catálogo
    catalogos/
      [catalogId]/
        page.tsx                # Detalhe catálogo + grid de imagens
    busca/
      page.tsx                  # Busca por imagem (tela principal do Rafael)
    api/
      suppliers/
        route.ts                # POST criar fornecedor
      catalogs/
        route.ts                # POST upload catálogo
        [catalogId]/
          route.ts              # GET detalhes, DELETE remover
      search/
        route.ts                # POST busca por imagem
  lib/
    prisma.ts                   # Prisma client (reusar do projeto atual)
    supabase.ts                 # Supabase client (storage)
    utils.ts                    # cn() helper (reusar)
  features/
    catalog-processing/
      extract-images.ts         # Extrai imagens do PDF com pdfimages
      filter-images.ts          # Filtra imagens irrelevantes (tamanho, brancas)
      process-catalog.ts        # Pipeline completo: extrai → filtra → upload → embedding → salva
    visual-search/
      embeddings.ts             # CLIP embedding (reusar do projeto atual)
      search.ts                 # Busca por similaridade com pgvector
  components/
    ui/                         # shadcn/ui components (reusar)
    image-upload.tsx            # Componente de upload com drag & drop
    search-results.tsx          # Grid de resultados
    catalog-images-grid.tsx     # Grid de imagens do catálogo
prisma/
  schema.prisma
Dockerfile
```

## O que reusar do projeto atual

| Arquivo | Ação |
|---|---|
| `src/features/visual-search/embeddings.ts` | Reusar inteiro |
| `src/lib/prisma.ts` | Reusar, adaptar connection string para Supabase |
| `src/lib/utils.ts` | Reusar inteiro |
| `src/components/ui/*` | Reusar todos os componentes shadcn |
| `tsconfig.json` | Reusar |
| `.prettierrc`, `.prettierignore` | Reusar |
| `eslint.config.mjs` | Reusar |
| `postcss.config.mjs` | Reusar |
| `next.config.ts` | Reusar base, remover bodySizeLimit exagerado |
| `tailwindcss`, `globals.css` | Reusar |

## O que NÃO existe mais

- Nenhum OCR (Tesseract)
- Nenhuma revisão humana
- Nenhum RawProduct, CanonicalProduct, SupplierOffer
- Nenhuma extração por grid (3x3)
- Nenhuma busca textual
- Nenhum OpenAI Vision
- Nenhum status PENDING_REVIEW / APPROVED / REJECTED

## Ordem de implementação sugerida para Claude Code

1. Setup: criar projeto Next.js, instalar deps, configurar Prisma com pgvector
2. Schema: criar as 3 tabelas (Supplier, Catalog, ProductImage)
3. Supabase: configurar client + bucket de storage
4. CLIP: copiar módulo de embeddings, testar que funciona
5. Processamento: implementar pipeline de extração de imagens do PDF
6. API de upload: POST /api/catalogs com processamento em background
7. API de busca: POST /api/search com pgvector
8. UI: páginas de fornecedores, catálogos e busca
9. Docker: Dockerfile para Railway
10. Deploy: configurar Railway + Supabase
