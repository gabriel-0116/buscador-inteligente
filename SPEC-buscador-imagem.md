Você vai trabalhar no repositório:

https://github.com/gabriel-0116/buscador-inteligente

Contexto do projeto:
Este sistema é um Buscador Inteligente de Catálogos. O usuário Rafael sobe catálogos em PDF de fornecedores. O sistema deve recortar os produtos presentes nos catálogos, gerar embeddings visuais e permitir busca por imagem. Quando Rafael envia uma imagem de um produto, o sistema deve retornar produtos com a MESMA FUNÇÃO COMERCIAL, não apenas visualmente parecidos de forma genérica.

Exemplos:

- Se enviar liquidificador portátil azul, deve retornar liquidificadores portáteis, independentemente de cor, preço ou tamanho.
- Se enviar carregador, deve retornar carregadores.
- Se enviar antena de TV, deve retornar antenas de TV, não cabo USB.
- Se enviar suporte de TV, deve retornar suportes de TV, não parafuso, embalagem ou foto de sala.

Problema atual:
O sistema está usando `pdfimages` para extrair imagens embutidas do PDF. Isso NÃO recorta produtos. Ele apenas extrai imagens internas do PDF. Se o PDF tiver um card inteiro como imagem, o sistema salva o card inteiro como se fosse produto.

Exemplo real:
Uma imagem extraída chamada `img-007.jpg` veio com logo, texto chinês, código, embalagem, suporte, foto de sala, parafusos e informações de medidas. O sistema gerou embedding dessa montagem inteira. Isso é errado. O embedding deve ser gerado preferencialmente sobre o produto/candidato recortado, não sobre o card inteiro.

Objetivo desta tarefa:
Refatorar o processamento de catálogo para criar uma pipeline correta:

PDF
→ renderizar páginas como imagem
→ salvar páginas
→ detectar/gerar recortes candidatos de produtos
→ salvar candidatos
→ gerar embedding dos candidatos
→ permitir busca sobre candidatos, não sobre imagens brutas extraídas do PDF
→ criar tela de depuração para ver página original + recortes

Não tente resolver tudo com IA. Primeiro corrija a entrada dos dados.

Regras importantes:

1. Não recomece o projeto do zero.
2. Não destrua as páginas e APIs que já funcionam.
3. Não mantenha `pdfimages` como pipeline principal.
4. Pode manter `pdfimages` apenas como auxiliar/fallback, mas a pipeline principal deve usar renderização de página com `pdftoppm`.
5. O foco é melhorar a indexação dos produtos.
6. Não implemente marketplace, pedido, estoque, WhatsApp, app mobile, CRM ou qualquer coisa fora do MVP.
7. Não use OCR pesado agora se isso atrasar. Pode deixar os campos preparados para OCR/classificação futura.
8. O sistema precisa continuar rodando com Next.js, TypeScript, Prisma, Supabase, pgvector, sharp e poppler-utils.
9. Depois de alterar, rode build/typecheck/lint quando possível e corrija erros reais.

Estado atual conhecido do projeto:

- Next.js 16 com App Router.
- Prisma + Supabase Postgres + pgvector.
- Supabase Storage bucket `product-images`.
- Embeddings visuais usando `Xenova/dinov2-base`, dimensão 768.
- Existe `src/features/visual-search/embeddings.ts`.
- Existe `src/features/catalog-processing/extract-images.ts` usando `pdfimages`.
- Existe `src/features/catalog-processing/process-catalog.ts`.
- Existe busca em `src/features/visual-search/search.ts`.
- Existe API `/api/catalogs`.
- Existe API `/api/search`.
- Existe página de catálogo com grid de imagens.

O problema central:
Hoje o schema trata `ProductImage` como se qualquer imagem extraída fosse produto. Isso é conceitualmente errado. Precisamos separar:

- página renderizada do catálogo;
- candidato de produto;
- imagem/crop usado para embedding.

Faça as alterações abaixo.

==================================================

1. # Atualizar schema Prisma

Atualize o schema para criar entidades separadas.

Manter:

- Supplier
- Catalog

Adicionar:

model CatalogPage {
id String @id @default(cuid())
catalogId String
pageNumber Int
imageUrl String
width Int
height Int
createdAt DateTime @default(now())

catalog Catalog @relation(fields: [catalogId], references: [id], onDelete: Cascade)
candidates ProductCandidate[]

@@index([catalogId])
@@unique([catalogId, pageNumber])
}

model ProductCandidate {
id String @id @default(cuid())
catalogId String
pageId String?
originalUrl String // imagem fonte: página ou imagem extraída
cropUrl String // recorte usado para busca
width Int
height Int
fileSize Int?
sourceType CandidateSourceType @default(PAGE_CROP)
cropX Int?
cropY Int?
cropWidth Int?
cropHeight Int?

detectedLabel String?
functionGroup String?
confidence Float?

embedding Unsupported("vector(768)")?
createdAt DateTime @default(now())

catalog Catalog @relation(fields: [catalogId], references: [id], onDelete: Cascade)
page CatalogPage? @relation(fields: [pageId], references: [id], onDelete: SetNull)

@@index([catalogId])
@@index([pageId])
@@index([functionGroup])
}

enum CandidateSourceType {
PAGE_CROP
EMBEDDED_IMAGE
MANUAL
}

Atualizar Catalog:

- adicionar pages CatalogPage[]
- adicionar candidates ProductCandidate[]
- manter imageCount se quiser, mas o ideal é interpretar como candidateCount ou criar candidateCount.
- se alterar para candidateCount, atualize UI/API.

Importante:

- Não use mais `ProductImage` como fonte principal da busca.
- Se preferir manter `ProductImage` temporariamente para compatibilidade, não use na busca principal.
- A busca principal deve consultar `ProductCandidate`.

Criar migration Prisma correspondente.
Garantir que pgvector continua funcionando com vector(768).

================================================== 2. Atualizar storage
==================================================

Organizar arquivos no Supabase Storage assim:

product-images/
{catalogId}/
pages/
page-001.jpg
page-002.jpg
candidates/
candidate-001.jpg
candidate-002.jpg
embedded/
img-001.jpg
img-002.jpg

Regras:

- `pages/` guarda página renderizada inteira.
- `candidates/` guarda recortes de produto/candidato.
- `embedded/` pode guardar extrações auxiliares do pdfimages, se ainda forem usadas.

Criar helpers em `src/lib/supabase.ts` se necessário:

- getPublicImageUrl(path)
- uploadImageToStorage(bucket/path/buffer/contentType)

================================================== 3. Criar renderização de páginas do PDF
==================================================

Criar arquivo:

src/features/catalog-processing/render-pages.ts

Função sugerida:

export async function renderPdfPagesToImages(
pdfPath: string,
outputDir: string
): Promise<Array<{ pageNumber: number; imagePath: string }>>

Implementação:

- usar `pdftoppm`, já disponível via poppler-utils.
- comando sugerido:
  pdftoppm -jpeg -r 180 "{pdfPath}" "{outputDir}/page"

Isso vai gerar arquivos tipo:
page-1.jpg
page-2.jpg

Depois:

- listar arquivos gerados;
- ordenar por número da página;
- retornar pageNumber e imagePath.

Cuidados:

- usar `execFile` ou `spawn` em vez de montar string insegura, se possível.
- criar outputDir antes.
- lidar com erro de comando.
- evitar injection por path.
- manter compatibilidade com Docker atual, que já instala poppler-utils.

Atualizar Dockerfile se necessário, mas ele já instala poppler-utils.

================================================== 4. Criar salvamento das páginas renderizadas
==================================================

No processamento do catálogo:

- renderizar páginas;
- para cada página:
  - ler metadata com sharp;
  - converter para JPEG qualidade 85;
  - upload para `product-images/{catalogId}/pages/page-XXX.jpg`;
  - salvar registro em `CatalogPage`.

Não gerar embedding da página inteira.
A página inteira é só fonte/debug.

================================================== 5. Criar detector inicial de candidatos por crop
==================================================

Criar arquivo:

src/features/catalog-processing/detect-product-candidates.ts

Objetivo:
Gerar recortes candidatos a partir da página renderizada.

Não precisa ser perfeito agora. Precisa ser melhor que salvar o card inteiro cegamente.

Implementar heurística inicial em camadas:

A) Para páginas que parecem ter um produto/card único:

- remover margens externas brancas;
- remover cabeçalho/rodapé se houver excesso de texto/logos;
- criar um crop central mais limpo;
- salvar como candidato.

B) Para páginas com múltiplos blocos/cards:

- tentar detectar regiões não brancas grandes;
- agrupar bounding boxes próximas;
- descartar regiões pequenas;
- descartar regiões muito largas/finas;
- descartar regiões com área pequena;
- gerar crops candidatos.

Use sharp para:

- normalizar imagem;
- achatar fundo branco;
- ler pixels;
- detectar máscara de pixels não brancos/não quase brancos;
- encontrar bounding boxes.

Critérios iniciais:

- background branco: pixel com r,g,b > 245.
- conteúdo: pixel não branco.
- ignorar ruído pequeno.
- min crop width: 180.
- min crop height: 180.
- crop não pode ocupar menos que 3% da página.
- crop não deve ser quase a página inteira se houver alternativa melhor.
- se só encontrar um bloco gigante, criar um crop com margens removidas, mas salvar sourceType PAGE_CROP e crop metadata.

A função pode retornar:

type DetectedCandidate = {
imagePath: string;
x: number;
y: number;
width: number;
height: number;
confidence: number;
};

export async function detectProductCandidatesFromPage(args: {
pageImagePath: string;
outputDir: string;
pageNumber: number;
}): Promise<DetectedCandidate[]>

Importante:

- O detector inicial não precisa identificar categoria.
- O objetivo é gerar imagens mais limpas que o card/página inteira.
- Se não conseguir detectar nada confiável, criar fallback com crop central/margens removidas, mas marcar confidence baixa.

================================================== 6. Melhorar crop para produto principal
==================================================

A imagem exemplo tem um card inteiro com:

- logo;
- textos;
- foto ambiente;
- embalagem;
- suporte;
- parafusos.

Para esse tipo de página, o crop ideal deve tentar privilegiar a região visual do produto e reduzir texto/logos.

Implementar uma heurística simples:

- após detectar a bounding box geral do conteúdo, criar subcrops candidatos:
  1. região central;
  2. região direita/central;
  3. região inferior/central;
  4. região maior sem margens.
- calcular qual subcrop tem melhor “densidade visual”:
  - não branco suficiente;
  - não texto demais;
  - área razoável;
  - não é fino/largo demais.
- salvar no máximo 1 a 3 candidatos por página no início para não poluir o banco.

Regra prática:

- melhor ter poucos candidatos bons do que muitos ruins.
- Não salve logo, texto puro, tabela de medidas ou embalagem pequena como produto principal.

================================================== 7. Atualizar process-catalog.ts
==================================================

Refatorar `src/features/catalog-processing/process-catalog.ts`.

Fluxo novo:

1. Criar diretórios temporários:
   /tmp/{catalogId}/pages
   /tmp/{catalogId}/candidates
   /tmp/{catalogId}/embedded

2. Renderizar páginas:
   renderPdfPagesToImages(pdfPath, pagesDir)

3. Para cada página:
   a. Salvar página em Supabase Storage em `{catalogId}/pages/page-XXX.jpg`
   b. Criar registro CatalogPage
   c. Rodar detectProductCandidatesFromPage
   d. Para cada candidato:
   - validar dimensões
   - converter para JPEG
   - upload para `{catalogId}/candidates/candidate-XXX.jpg`
   - gerar embedding DINOv2 do crop
   - criar ProductCandidate sem embedding
   - atualizar embedding via raw SQL `::vector`
   - salvar crop metadata: x, y, width, height, confidence
   - sourceType = PAGE_CROP

4. Opcional/fallback:
   - pode rodar `pdfimages` depois como auxiliar, mas apenas se:
     - o número de candidatos por página for muito baixo;
     - ou se quiser comparar.
   - Se usar `pdfimages`, salvar em `embedded/`, mas não deixar dominar a indexação.

5. Atualizar Catalog:
   - status READY
   - pageCount
   - imageCount ou candidateCount

6. Em erro:
   - status FAILED
   - salvar error

7. Limpar tmp.

Importante:

- Não gerar embedding de página inteira.
- Não gerar embedding de imagem/card bruto se houver crop melhor.
- Não deixar o processamento explodir tempo demais. No MVP, limitar candidatos por página.

================================================== 8. Atualizar busca para ProductCandidate
==================================================

Atualizar `src/features/visual-search/search.ts`.

A busca deve consultar `ProductCandidate`, não `ProductImage`.

Retornar:

- id
- cropUrl
- originalUrl
- catalogId
- similarity
- supplierName
- catalogFileName
- functionGroup se existir
- detectedLabel se existir
- confidence se existir
- crop metadata se quiser

Query base:

SELECT
pc.id,
pc."cropUrl",
pc."originalUrl",
pc."catalogId",
pc."detectedLabel",
pc."functionGroup",
pc."confidence",
(1 - (pc.embedding <=> ${vectorStr}::vector))::float8 AS similarity,
c."fileName" AS "catalogFileName",
s.name AS "supplierName"
FROM "ProductCandidate" pc
JOIN "Catalog" c ON c.id = pc."catalogId"
JOIN "Supplier" s ON s.id = c."supplierId"
WHERE pc.embedding IS NOT NULL
ORDER BY pc.embedding <=> ${vectorStr}::vector
LIMIT 100

Depois:

- deduplicar resultados muito semelhantes;
- retornar top 20.

Não use chave de dedupe baseada só em similarity. Isso é fraco.
Melhor dedupe:

- mesmo catalogId + cropUrl;
- ou mesmo catalogId + pageId + bounding boxes próximas;
- ou similarity muito alta + mesmo catálogo.

Se ainda não tiver functionGroup, deixe campo null. Mas já prepare o retorno.

================================================== 9. Atualizar API `/api/search`
==================================================

Manter upload de imagem.
Gerar embedding com DINOv2.
Buscar em ProductCandidate.
Retornar candidatos.

Adicionar validações:

- imagem obrigatória;
- máximo 8MB;
- content-type começa com image/.

Retorno JSON deve ser compatível com UI.

================================================== 10. Atualizar UI da busca
==================================================

A página `/busca` deve mostrar:

- imagem enviada;
- grid de resultados;
- imagem do candidato usando cropUrl;
- fornecedor;
- catálogo;
- similaridade;
- label/função se existir;
- botão/link para abrir crop;
- botão/link para abrir imagem original ou página original, se disponível.

Texto visual:

- “Resultado encontrado no catálogo”
- Não dizer “em estoque”.
- Não dizer “produto exato” se for apenas similar.

Exibir similaridade como porcentagem, mas sem prometer precisão absoluta.

================================================== 11. Criar tela de debug do catálogo
==================================================

Atualizar `/catalogos/[catalogId]`.

Ela deve mostrar:

- dados do catálogo;
- páginas renderizadas;
- candidatos extraídos.

Sugestão de layout:

- Seção “Páginas renderizadas”
  - grid com páginas inteiras.
- Seção “Candidatos extraídos”
  - grid com crops.
  - cada card mostra:
    - crop;
    - página de origem;
    - dimensões;
    - confidence;
    - sourceType;
    - link para abrir imagem original/página.

Objetivo:
Eu preciso conseguir olhar rapidamente se o sistema está recortando produtos ou salvando lixo.

Se possível, criar rota:
`/catalogos/[catalogId]/debug`

Mas pode ser na própria página do catálogo, desde que fique claro.

================================================== 12. Preparar campos para classificação futura por função
==================================================

Não precisa implementar IA avançada agora, mas deixe preparado:

Em ProductCandidate:

- detectedLabel
- functionGroup
- confidence

Criar arquivo opcional:

src/features/catalog-processing/function-groups.ts

Com alguns grupos iniciais manuais:

export const FUNCTION_GROUPS = {
charger: "Carregador",
tv_antenna: "Antena de TV",
tv_mount: "Suporte de TV",
blender_portable: "Liquidificador portátil",
cable_usb: "Cabo USB",
unknown: "Desconhecido",
};

Não precisa classificar automaticamente agora se isso complicar. Mas não remova os campos.

================================================== 13. Não implementar OCR agora como dependência obrigatória
==================================================

A especificação antiga removeu OCR, mas o projeto provavelmente vai precisar dele depois para diferenciar função comercial. Por enquanto:

- não coloque OCR pesado se for atrasar;
- não bloqueie a pipeline por OCR;
- deixe campos preparados.

Se implementar algo simples, que seja opcional e não quebre deploy.

================================================== 14. Atualizar ou substituir ProductImage
==================================================

Se for simples migrar:

- substituir uso de ProductImage por ProductCandidate.

Se for arriscado:

- manter ProductImage no schema temporariamente;
- mas parar de usar ProductImage na busca principal;
- marcar como legado/comentário;
- usar ProductCandidate para tudo novo.

Não apague dados sem necessidade.

================================================== 15. Ajustar componentes
==================================================

Atualizar componentes existentes:

- CatalogImagesGrid pode virar CandidateGrid ou aceitar candidates.
- SearchResults deve usar cropUrl.
- Onde antes esperava imageUrl, ajustar para cropUrl.

Cuidado com Next Image:

- next.config.ts já permite `*.supabase.co`.
- manter object-contain.
- evitar quebrar imagens remotas.

================================================== 16. Atualizar API de catálogo
==================================================

`GET /api/catalogs/[id]`, se existir, deve retornar:

- catalog;
- supplier;
- pages;
- candidates.

`DELETE /api/catalogs/[id]`, se existir:

- deletar páginas e candidatos do storage;
- deletar registros relacionados por cascade;
- deletar pasta `{catalogId}/` no storage se possível.

================================================== 17. Ajustar contadores
==================================================

Na Home e páginas:

- trocar “imagens indexadas” por “candidatos indexados” se fizer sentido.
- mostrar:
  - fornecedores;
  - catálogos;
  - páginas processadas;
  - candidatos indexados.

O que importa para busca agora é quantidade de ProductCandidate com embedding.

================================================== 18. Build e qualidade
==================================================

Depois de implementar:

- rodar `pnpm prisma generate`
- rodar migration ou criar SQL/migration necessária
- rodar `pnpm lint`
- rodar `pnpm build`

Corrigir erros de TypeScript.

Se o build falhar por causa de ambiente Supabase/DATABASE_URL ausente, documentar exatamente o que faltou, mas ainda corrigir erros de código detectáveis.

================================================== 19. Atualizar documentação
==================================================

Criar ou atualizar README.md com:

- objetivo do sistema;
- pipeline atual;
- variáveis de ambiente;
- dependência de poppler-utils;
- como rodar local;
- como testar upload de PDF;
- como testar busca por imagem;
- explicação de que `pdfimages` não é mais pipeline principal.

Adicionar uma seção:
“Como avaliar se o processamento está bom”
com:

- abrir catálogo;
- ver páginas renderizadas;
- comparar candidatos extraídos;
- se candidatos estiverem pegando card inteiro, ajustar detector;
- se busca estiver ruim, primeiro verificar crops antes de mexer no modelo.

================================================== 20. Resultado esperado desta tarefa
==================================================

Ao final, eu quero:

1. Subir um PDF.
2. O sistema renderizar as páginas.
3. O sistema salvar páginas em Supabase Storage.
4. O sistema gerar recortes candidatos.
5. O sistema salvar candidatos em Supabase Storage.
6. O sistema gerar embeddings dos candidatos.
7. A página do catálogo mostrar páginas e candidatos.
8. A busca por imagem consultar ProductCandidate.
9. Os resultados mostrarem crop do candidato, fornecedor, catálogo e similaridade.
10. O sistema parar de tratar imagem embutida/card inteiro como produto principal.

================================================== 21. Critério de aceite manual
==================================================

Depois da implementação, eu vou testar com um catálogo real.

O teste é:

- subir catálogo com produto tipo suporte de TV;
- abrir tela do catálogo;
- verificar se o sistema mostra recortes mais próximos do produto, e não apenas cards inteiros;
- buscar por imagem de suporte de TV;
- resultados devem trazer suportes de TV antes de itens como cabo, logo, embalagem ou foto de ambiente.

Se os crops estiverem ruins, a tarefa não está concluída. Não adianta a busca funcionar tecnicamente se o banco estiver indexando imagem errada.

================================================== 22. Entrega
==================================================

Faça as mudanças no código.
Mantenha o código simples.
Evite abstrações desnecessárias.
Não tente criar uma arquitetura gigante.
Priorize o fluxo funcionando e depurável.

Ao final, me entregue um resumo com:

- arquivos alterados;
- o que mudou na pipeline;
- comandos que rodou;
- se build/lint passaram;
- limitações atuais do detector de crops;
- próximos ajustes recomendados.
