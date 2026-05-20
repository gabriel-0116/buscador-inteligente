Você vai trabalhar no repositório:

https://github.com/gabriel-0116/buscador-inteligente

Contexto do projeto:
Este sistema é um Buscador Inteligente de produtos em catálogos PDF de fornecedores.

O usuário Rafael sobe catálogos em PDF. O sistema deve processar automaticamente esses catálogos, identificar os produtos, recortar os cards/produtos, gerar embeddings visuais e permitir busca por imagem.

Requisito principal:
O sistema precisa ser 100% automático no uso.

Não quero:

- revisão humana produto por produto;
- revisão página por página;
- editor manual de crop;
- configuração manual de template;
- estratégia hardcoded por fornecedor;
- regra específica para LUKTON, ELETROMEX, LEHMOX etc.

O sistema precisa lidar com vários layouts de catálogo automaticamente.

Problema atual:
A pipeline atual melhorou bastante com renderização de páginas e ProductCandidate, mas ainda depende demais de heurísticas:

- gaps brancos;
- linhas e colunas;
- proporção;
- cor verde/laranja;
- grid fixo.

Isso não escala. Cada fornecedor pode ter layout diferente.

Novo objetivo:
Mudar a estratégia principal do MVP.

Em vez de depender de heurística de recorte, o sistema deve usar um modelo multimodal para analisar cada página renderizada e retornar um JSON estruturado com os produtos encontrados, incluindo bounding boxes.

Fluxo novo desejado:

PDF
→ renderizar páginas
→ enviar cada página para detector multimodal
→ receber JSON com produtos e bounding boxes
→ validar JSON e bounding boxes
→ recortar cada produto/card usando os boxes
→ salvar ProductCandidate
→ salvar metadados estruturados do produto
→ gerar embedding visual do crop
→ busca usa imagem + dados estruturados

A heurística atual deve continuar existindo apenas como fallback, não como método principal.

==================================================

1. # Conceito principal

Cada página do catálogo deve virar uma análise JSON.

Exemplo de JSON esperado por página:

{
"pageNumber": 5,
"products": [
{
"box": {
"x": 120,
"y": 230,
"width": 430,
"height": 390
},
"productName": "Hub USB 2.0",
"productNamePt": "Hub USB 2.0",
"category": "Informática",
"functionGroup": "hub_usb",
"model": "HB-013",
"originalText": "USB3.0X1 + USB2.0 X3 / HB-013",
"descriptionPt": "Hub USB com múltiplas entradas",
"confidence": 0.86
}
]
}

Importante:

- O box deve estar em pixels da imagem renderizada da página.
- Cada produto comercial deve virar um item separado.
- Se uma página tiver 9 cards, o JSON deve ter aproximadamente 9 produtos.
- Se uma página tiver 2 produtos, o JSON deve ter 2 produtos.
- Não juntar vários produtos no mesmo box quando eles aparecem separados no catálogo.
- Não retornar cabeçalho, rodapé, número de página, logo do catálogo, faixa decorativa ou espaço vazio como produto.

================================================== 2. Atualizar Prisma
==================================================

Atualizar ProductCandidate para guardar metadados estruturados.

Adicionar campos, se ainda não existirem:

productName String?
productNamePt String?
category String?
functionGroup String?
model String?
originalText String?
descriptionPt String?
sourceDetector String?
visionConfidence Float?
rawVisionJson Json?

Já existem campos como:

- detectedLabel
- functionGroup
- confidence
- isSearchable
- qualityScore
- rejectReason
- cardUrl
- embedding

Manter o que já existe.

Se já existir functionGroup, não duplicar.
Se detectedLabel já existir, pode usar como alias de productNamePt ou manter separado.

Adicionar também, se fizer sentido:

model PageAnalysis {
id String @id @default(cuid())
catalogId String
pageId String
pageNumber Int
provider String?
model String?
rawJson Json
productsCount Int
error String?
createdAt DateTime @default(now())

catalog Catalog @relation(fields: [catalogId], references: [id], onDelete: Cascade)
page CatalogPage @relation(fields: [pageId], references: [id], onDelete: Cascade)

@@index([catalogId])
@@index([pageId])
}

Atualizar relações em Catalog e CatalogPage, se necessário.

Criar migration Prisma e rodar prisma generate.

================================================== 3. Criar schema Zod para resposta multimodal
==================================================

Criar arquivo:

src/features/catalog-processing/product-json-schema.ts

Definir schema com Zod:

PageProductSchema:

- box.x number
- box.y number
- box.width number
- box.height number
- productName string nullable/optional
- productNamePt string nullable/optional
- category string nullable/optional
- functionGroup string nullable/optional
- model string nullable/optional
- originalText string nullable/optional
- descriptionPt string nullable/optional
- confidence number entre 0 e 1

PageAnalysisSchema:

- pageNumber number
- products array de PageProductSchema

A validação deve:

- recusar JSON inválido;
- normalizar campos ausentes;
- garantir products como array;
- garantir confidence entre 0 e 1;
- garantir box com números válidos.

================================================== 4. Criar detector multimodal com JSON
==================================================

Criar arquivo:

src/features/catalog-processing/vision-json-detector.ts

Criar função:

detectProductsJsonWithVision(args: {
pageImagePath: string;
pageNumber: number;
pageWidth: number;
pageHeight: number;
}): Promise<{
provider: string;
model: string;
rawJson: unknown;
products: Array<{
box: { x: number; y: number; width: number; height: number };
productName?: string | null;
productNamePt?: string | null;
category?: string | null;
functionGroup?: string | null;
model?: string | null;
originalText?: string | null;
descriptionPt?: string | null;
confidence: number;
}>;
}>

Essa função deve usar um provider multimodal configurável por env.

Variáveis de ambiente:

VISION_DETECTOR_PROVIDER=
VISION_DETECTOR_API_KEY=
VISION_DETECTOR_MODEL=

Não hardcodar fornecedor.
Não depender de cor.
Não depender de layout fixo.

Se VISION_DETECTOR_API_KEY não estiver configurada:

- retornar erro controlado;
- o processamento deve cair para fallback heurístico atual;
- logar que detector visual não foi usado.

================================================== 5. Prompt do modelo multimodal
==================================================

Usar um prompt forte e objetivo.

Prompt sugerido:

Você está analisando uma página renderizada de um catálogo de fornecedor.

Sua tarefa é identificar todos os produtos comerciais vendidos nesta página.

Retorne somente JSON válido, sem markdown, sem explicação, no formato:

{
"pageNumber": number,
"products": [
{
"box": { "x": number, "y": number, "width": number, "height": number },
"productName": string | null,
"productNamePt": string | null,
"category": string | null,
"functionGroup": string | null,
"model": string | null,
"originalText": string | null,
"descriptionPt": string | null,
"confidence": number
}
]
}

Regras:

- Cada card/produto vendido deve virar um item separado.
- Não junte múltiplos produtos em um único box se eles aparecem como cards separados.
- Ignore cabeçalho, rodapé, número da página, título de seção, logo do catálogo, faixas decorativas, tabela vazia e espaços em branco.
- Se a página tiver grade 3x3, retorne 9 produtos.
- Se tiver 2 produtos, retorne 2 produtos.
- Se a página for capa, sumário ou página sem produtos, retorne products: [].
- O box deve estar em pixels relativos à imagem inteira.
- O box deve conter o card/produto completo o suficiente para busca visual: imagem do produto, embalagem e texto principal.
- Não precisa isolar apenas o objeto físico. O card completo é aceitável.
- productNamePt e descriptionPt devem estar em português quando possível.
- functionGroup deve representar a função comercial do produto em snake_case, exemplo:
  - carregador
  - cabo_usb
  - hub_usb
  - antena_tv
  - suporte_tv
  - barbeador_eletrico
  - fone_bluetooth
  - controle_game
  - mouse
  - teclado
  - ring_light
  - lanterna
  - umidificador
  - microfone
  - adaptador
  - ferramenta_eletrica
  - desconhecido
- Use confidence entre 0 e 1.

================================================== 6. Parsing seguro do JSON
==================================================

O modelo pode retornar:

- JSON puro;
- JSON dentro de texto;
- markdown;
- JSON parcialmente inválido.

Criar função robusta:

parseVisionJsonResponse(text: string)

Ela deve:

1. tentar JSON.parse direto;
2. se falhar, extrair o primeiro bloco entre { e };
3. validar com Zod;
4. se falhar, lançar erro controlado.

Não deixar o processamento inteiro quebrar por uma página ruim.

================================================== 7. Validar bounding boxes
==================================================

Criar arquivo ou função:

validateVisionBoxes(...)

Regras:

- clamp dos boxes dentro da página;
- remover box com width/height inválido;
- remover box pequeno demais;
- remover box grande demais tipo página inteira;
- remover box em cabeçalho/rodapé;
- remover box muito horizontal que seja só faixa;
- remover box muito vertical que seja coluna inteira;
- remover box quase branco/vazio;
- remover duplicados por IoU.

Criar função:

dedupeBoxesByIoU(products, threshold = 0.65)

Se dois boxes sobrepõem muito:

- manter o de maior confidence;
- se confidence igual, manter o de melhor qualityScore.

================================================== 8. QualityScore local continua obrigatório
==================================================

Mesmo que o modelo retorne confidence alta, calcular qualityScore localmente.

Critérios:

- box tem tamanho suficiente;
- crop tem conteúdo visual;
- não é quase branco;
- não é faixa isolada;
- não é cabeçalho/rodapé;
- não é página inteira;
- não é coluna com múltiplos produtos.

isSearchable deve ser true somente se:

- box passou validação;
- qualityScore >= 0.60;
- confidence do modelo >= 0.45, quando veio do modelo;
- não tem rejectReason grave.

Reject reasons:

- invalid_json
- invalid_box
- too_small
- too_large
- mostly_white
- header_footer
- horizontal_bar
- vertical_column
- duplicate
- low_confidence
- low_quality
- no_products_detected
- fallback_used

================================================== 9. Atualizar detect-product-candidates.ts
==================================================

A nova ordem deve ser:

1. Tentar detector multimodal JSON.
2. Salvar PageAnalysis com rawJson, provider, model, productsCount.
3. Validar produtos/boxes.
4. Gerar crops dos boxes válidos.
5. Se o detector multimodal falhar ou retornar poucos produtos:
   - usar heurística atual como fallback.
6. Marcar sourceDetector:
   - VISION_JSON
   - HEURISTIC
   - FALLBACK
7. Retornar DetectedCandidate com metadados do produto.

Atualizar tipo DetectedCandidate para incluir:

productName?
productNamePt?
category?
functionGroup?
model?
originalText?
descriptionPt?
sourceDetector?
visionConfidence?
rawVisionJson?

================================================== 10. Atualizar process-catalog.ts
==================================================

Ao criar ProductCandidate, salvar os novos campos:

productName
productNamePt
category
functionGroup
model
originalText
descriptionPt
sourceDetector
visionConfidence
rawVisionJson

Manter:

- cropUrl
- cardUrl
- originalUrl
- isSearchable
- qualityScore
- rejectReason
- embedding

Embedding continua sendo gerado somente se:

- isSearchable = true
- qualityScore >= 0.60

Não gerar embedding para debug/rejeitado.

================================================== 11. Fallback heurístico
==================================================

Manter detector heurístico atual como fallback.

Mas ele não deve ser método principal quando VISION_DETECTOR_API_KEY estiver configurada.

Estratégia:

if vision detector succeeds and returns enough valid boxes:
use vision boxes
else:
use heuristic fallback

Logs por página:

- pageNumber
- visionRawProducts
- visionValidProducts
- fallbackUsed
- finalSearchable
- finalRejected

================================================== 12. Atualizar UI de catálogo/debug
==================================================

Na página do catálogo, mostrar nos cards:

- productNamePt ou productName;
- category;
- functionGroup;
- model;
- sourceDetector;
- visionConfidence;
- qualityScore;
- rejectReason;
- isSearchable.

Separar visualmente:

- Pesquisáveis
- Rejeitados / Debug

A tela continua sendo apenas diagnóstico técnico.
Não criar revisão manual.
Não criar botão para editar produto.

================================================== 13. Atualizar busca por imagem para preparar busca híbrida
==================================================

Não precisa implementar ranking híbrido completo agora.

Mas a API de busca deve retornar junto com cada resultado:

- productNamePt
- productName
- category
- functionGroup
- model
- descriptionPt
- supplierName
- catalogFileName
- similarity
- qualityScore
- sourceDetector

Assim a UI já mostra dados estruturados.

A busca ainda pode ordenar por embedding visual por enquanto.

================================================== 14. Atualizar UI de busca
==================================================

Na página de busca, mostrar:

- imagem do resultado;
- fornecedor;
- catálogo;
- similaridade;
- productNamePt/productName;
- category;
- functionGroup;
- model;
- descriptionPt, se existir.

Não dizer “em estoque”.
Usar texto:
“Encontrado no catálogo”.

================================================== 15. Não implementar revisão humana
==================================================

Não criar:

- editor de template;
- editor manual de crop;
- tela de aprovação;
- correção humana obrigatória;
- revisão produto por produto.

O sistema deve ser automático.

Debug é permitido apenas para auditoria técnica.

================================================== 16. Não mexer fora do escopo
==================================================

Não implementar:

- estoque;
- pedido;
- WhatsApp;
- marketplace;
- CRM;
- nota fiscal;
- pagamento;
- scraping;
- app mobile;
- treinamento de modelo próprio.

================================================== 17. Critérios de aceite
==================================================

Com VISION_DETECTOR_API_KEY configurada:

LUKTON:

- páginas 3x3 devem gerar perto de 9 ProductCandidates pesquisáveis.
- faixas verdes não devem virar pesquisáveis.
- produtos devem ter productNamePt/category/functionGroup quando possível.

ELETROMEX:

- não gerar colunas verticais gigantes como pesquisáveis.
- produtos em cards separados devem virar candidatos separados.
- cards laranja/preto devem ser aceitos.

LEHMOX:

- cards arredondados laranja devem ser detectados.
- capa/sumário não deve gerar produtos.
- cards de produto devem ter metadados.

Geral:

- cada produto visível deve virar aproximadamente um ProductCandidate.
- cada ProductCandidate deve ter cropUrl.
- embedding só para isSearchable=true.
- search.ts deve continuar buscando apenas candidatos pesquisáveis.
- sem API key, sistema deve cair para fallback e avisar nos logs.

================================================== 18. Rodar validações
==================================================

Ao final, rodar:

pnpm prisma generate
pnpm lint
pnpm build

Se criar migration, explicar o comando para aplicar.

Se build falhar por env ausente, explicar.
Se falhar por TypeScript, corrigir.

================================================== 19. Entrega esperada
==================================================

Ao final, me diga:

- arquivos alterados;
- campos adicionados no Prisma;
- como configurar as variáveis de ambiente;
- qual provider/modelo foi implementado;
- como o JSON multimodal é gerado;
- como os boxes são validados;
- quando cai para fallback;
- como testar com LUKTON, ELETROMEX e LEHMOX;
- limitações atuais.
