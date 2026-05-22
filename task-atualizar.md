Você vai trabalhar no repositório:

https://github.com/gabriel-0116/buscador-inteligente

Contexto do projeto:
O sistema é um buscador interno de produtos em catálogos PDF. O usuário sobe catálogos de fornecedores, o sistema precisa encontrar produtos nos PDFs, recortar cada produto/card, gerar embedding visual e permitir busca por imagem.

Decisão importante:
Neste momento, o MAIS IMPORTANTE é o crop/imagem correta do produto.

Não precisamos agora de:

- nome do produto;
- categoria;
- descrição traduzida;
- functionGroup;
- modelo;
- texto original;
- metadados ricos.

Essas coisas podem ficar para depois.

O MVP agora deve priorizar:

1. Recorte correto do produto/card.
2. Embedding visual do recorte.
3. Busca por imagem em cima dos crops corretos.

Problema atual:
O detector multimodal está retornando JSON rico com nome, categoria, descrição, modelo e functionGroup. Isso aumentou custo, aumentou tokens e não resolveu o principal. Em vários casos o modelo entende o produto, mas o bounding box vem errado ou contaminado com parte de outro card.

A tarefa agora é simplificar.

Novo objetivo:
O detector multimodal deve retornar APENAS bounding boxes dos cards/produtos.

Não pedir nome.
Não pedir categoria.
Não pedir descrição.
Não pedir tradução.
Não pedir função comercial.
Não pedir modelo.

A IA deve responder só:

{
"pageNumber": 1,
"boxes": [
{ "x": 100, "y": 200, "width": 420, "height": 390, "confidence": 0.92 }
]
}

O sistema deve usar essas boxes para recortar os cards e gerar ProductCandidate.

==================================================
REGRA PRINCIPAL
==================================================

A verdade do MVP é a imagem.

Produto válido = crop correto + fornecedor + catálogo + página + embedding.

Metadados textuais são opcionais e devem ficar para depois.

Não gastar tokens tentando descrever produto enquanto o crop ainda está instável.

==================================================

1. # Simplificar o detector multimodal

Arquivo principal atual:

src/features/catalog-processing/vision-json-detector.ts

Refatorar para que o detector visual tenha uma função focada em boxes:

detectProductBoxesWithVision(args: {
pageImagePath: string;
pageNumber: number;
pageWidth: number;
pageHeight: number;
modelOverride?: string;
}): Promise<{
provider: string;
model: string;
rawJson: unknown;
rawText: string;
boxes: Array<{
x: number;
y: number;
width: number;
height: number;
confidence: number;
}>;
}>

Pode manter detectProductsJsonWithVision temporariamente se for necessário para compatibilidade, mas o pipeline principal deve usar detectProductBoxesWithVision.

Não pedir nem retornar:

- productName
- productNamePt
- category
- functionGroup
- model
- originalText
- descriptionPt

Esses campos podem continuar no banco como opcionais, mas não devem ser preenchidos nessa etapa.

================================================== 2. Novo prompt do modelo
==================================================

Substituir o prompt atual por um prompt muito mais curto e direto.

Prompt sugerido:

Você está analisando uma página renderizada de um catálogo de fornecedor.

A imagem tem {width} pixels de largura e {height} pixels de altura.
Página: {pageNumber}.

Sua tarefa é detectar os cards/produtos vendidos nesta página.

Retorne SOMENTE JSON válido, sem markdown e sem explicação:

{
"pageNumber": {pageNumber},
"boxes": [
{ "x": number, "y": number, "width": number, "height": number, "confidence": number }
]
}

Regras:

- Cada produto/card comercial deve virar uma box separada.
- Não junte vários produtos na mesma box se eles aparecem separados.
- Ignore cabeçalho, rodapé, logo do catálogo, número da página, faixas decorativas e espaços vazios.
- Se a página tiver uma grade 3x3, retorne 9 boxes.
- Se tiver 2 produtos, retorne 2 boxes.
- Se a página não tiver produtos, retorne "boxes": [].
- A box deve cobrir o card/produto completo o suficiente para busca visual.
- Não tente descrever o produto.
- Não extraia texto.
- Não classifique categoria.
- Não traduza nada.
- As coordenadas devem estar em pixels da imagem recebida.
- Confidence deve estar entre 0 e 1.

Responda apenas com JSON.

================================================== 3. Reduzir custo da imagem enviada ao modelo
==================================================

Hoje o sistema envia a página renderizada inteira para o modelo. Isso pode ficar caro.

Antes de enviar ao modelo, criar uma versão reduzida/comprimida da página somente para visão.

Criar helper:

prepareVisionInputImage(args: {
pageImagePath: string;
maxWidth: number;
jpegQuality: number;
}): Promise<{
imagePath: string;
width: number;
height: number;
scaleX: number;
scaleY: number;
}>

Comportamento:

- gerar uma imagem temporária JPEG;
- largura máxima padrão: 1280px;
- qualidade JPEG padrão: 75;
- manter proporção;
- se a página original for menor, pode manter tamanho;
- enviar essa imagem reduzida ao modelo;
- o prompt deve informar largura/altura da imagem reduzida;
- o modelo retorna coordenadas na imagem reduzida;
- depois o código precisa converter as boxes de volta para coordenadas da página original usando scaleX/scaleY.

Adicionar envs:

VISION_DETECTOR_MAX_IMAGE_WIDTH=1280
VISION_DETECTOR_JPEG_QUALITY=75
VISION_DETECTOR_MAX_OUTPUT_TOKENS=800

Default:

- max width: 1280
- jpeg quality: 75
- max output tokens: 800

Importante:
Não recortar a partir da imagem reduzida.
A imagem reduzida é só para o modelo.
O crop final deve ser feito na página original renderizada, com coordenadas escaladas.

================================================== 4. Criar schema Zod específico para boxes
==================================================

Criar ou ajustar arquivo:

src/features/catalog-processing/product-json-schema.ts

Adicionar schema:

VisionBoxSchema:

- x number
- y number
- width number
- height number
- confidence number entre 0 e 1

PageBoxesSchema:

- pageNumber number
- boxes array de VisionBoxSchema

Criar parser:

parseVisionBoxesResponse(text: string)

Ele deve:

1. tentar JSON.parse direto;
2. se falhar, extrair primeiro objeto JSON entre { e };
3. validar com Zod;
4. normalizar confidence ausente para 0.75;
5. se vier products antigo com product.box, aceitar temporariamente e converter para boxes;
6. retornar sempre:
   {
   pageNumber,
   boxes
   }

Não quebrar o processamento inteiro por uma página inválida.
Erro deve ser controlado.

================================================== 5. Atualizar provider OpenAI/Anthropic
==================================================

No provider, reduzir max_tokens.

Hoje o modelo pode estar configurado com max_tokens alto porque retornava descrições.

Agora usar:

max_tokens: Number(process.env.VISION_DETECTOR_MAX_OUTPUT_TOKENS ?? 800)

Não precisa de 4096 tokens para boxes.

Se a API retornar usage/tokens, logar:

- input_tokens;
- output_tokens;
- total_tokens;
- model.

Não precisa salvar no banco agora, mas logar ajuda a controlar custo.

================================================== 6. Atualizar pipeline vision
==================================================

Arquivo:

src/features/catalog-processing/detect-product-candidates.ts

Hoje runVisionDetector espera produtos com metadados.

Alterar para trabalhar com boxes.

Fluxo novo do runVisionDetector:

1. Preparar imagem reduzida para visão.
2. Chamar detectProductBoxesWithVision usando imagem reduzida.
3. Converter boxes da imagem reduzida para coordenadas da página original.
4. Validar boxes.
5. Deduplicar por IoU.
6. Refinar apenas de forma conservadora, se já existir refinamento.
7. Recortar na página original.
8. Avaliar qualidade do crop.
9. Marcar isSearchable somente se passar qualidade.

O DetectedCandidate vindo de visão deve ter:

- sourceDetector = VISION_BOXES_CHEAP ou VISION_BOXES_PREMIUM
- visionConfidence
- rawVisionJson
- cropUrl depois no processCatalog
- productName/category/etc undefined

Não preencher metadados textuais nessa etapa.

================================================== 7. SourceDetector
==================================================

Atualizar tipos para aceitar:

- HEURISTIC
- FALLBACK
- VISION_BOXES_CHEAP
- VISION_BOXES_PREMIUM

Pode manter:

- VISION_JSON_CHEAP
- VISION_JSON_PREMIUM

por compatibilidade com dados antigos.

Mas novos candidates devem usar VISION_BOXES_CHEAP/PREMIUM.

Na UI, labels:

- HEURISTIC: "heurístico"
- VISION_BOXES_CHEAP: "vision boxes"
- VISION_BOXES_PREMIUM: "vision premium"
- FALLBACK: "fallback"

================================================== 8. Refinamento de box deve ser conservador
==================================================

O refinamento atual pode rejeitar muitos boxes como "borda contaminada".

Ajustar comportamento:

- O modelo deve retornar card completo.
- O refinamento local não deve deslocar agressivamente o box.
- Se o refinamento piorar muito, manter box original.
- Se o box do modelo já parece bom, não mexer.

Regras:

- Não expandir demais para pegar card vizinho.
- Não mover topo/base mais que 15% da altura original.
- Não alterar área final para menos de 70% ou mais de 140% da área original, salvo caso muito claro.
- Se boundaryScore falhar mas o crop visual ainda for um card plausível, mandar para Debug, não para busca.
- Não deixar crop contaminado entrar como searchable.

O foco é estabilidade do crop, não perfeição pixel a pixel.

================================================== 9. Atualizar avaliação de qualidade
==================================================

A qualidade deve avaliar principalmente se o crop serve para busca visual.

Um crop pesquisável deve:

- ter produto/card visível;
- não ser faixa horizontal isolada;
- não ser cabeçalho/rodapé;
- não ser página inteira;
- não ser coluna com vários cards;
- não pegar 1,5 card;
- não estar quase vazio.

Não rejeitar só porque tem texto ou preço.
Card de catálogo sempre tem texto/preço.

================================================== 10. Não usar IA para metadados agora
==================================================

Remover do prompt e da resposta:

- productName
- productNamePt
- category
- functionGroup
- model
- originalText
- descriptionPt

No ProductCandidate, esses campos podem continuar existindo, mas devem ficar null/undefined para os novos candidates gerados por VISION_BOXES.

Não remover colunas do banco.
Não criar migration para apagar nada.

================================================== 11. Atualizar PageAnalysis
==================================================

PageAnalysis.rawJson deve salvar o JSON de boxes.

productsCount pode continuar existindo, mas agora deve contar boxes.

Se quiser renomear internamente para boxesCount no código, tudo bem, mas não precisa migration agora.

================================================== 12. Manter cascata de custo
==================================================

Não remover modo auto.

A estratégia continua:

1. Heurística primeiro.
2. Se heurística for boa, usa heurística e não chama IA.
3. Se heurística for ruim, chama VISION_BOXES_CHEAP.
4. Premium só se habilitado.

Manter envs:

VISION_DETECTOR_MODE=auto
VISION_DETECTOR_MODEL_CHEAP=...
VISION_DETECTOR_MODEL_PREMIUM=...
VISION_USE_PREMIUM_FALLBACK=false
CATALOG_MAX_VISION_PAGES=...

Adicionar/usar:

VISION_DETECTOR_MAX_IMAGE_WIDTH=1280
VISION_DETECTOR_JPEG_QUALITY=75
VISION_DETECTOR_MAX_OUTPUT_TOKENS=800

================================================== 13. Atualizar UI de catálogo
==================================================

Na página do catálogo:

- não depender de productName/category para exibir card;
- se não tiver nome, não mostrar campo vazio;
- mostrar sourceDetector corretamente;
- mostrar qualityScore;
- mostrar visionConfidence;
- mostrar rejectReason;
- mostrar dimensões;
- manter Pesquisáveis e Rejeitados/Debug.

Para novos VISION_BOXES, pode aparecer só:

- Busca: SIM
- vision boxes
- qual. XX%
- vision XX%
- dimensões
- Page Crop
- Página original

Isso é suficiente agora.

================================================== 14. Atualizar busca
==================================================

Não precisa mudar ranking agora.

A API de busca pode continuar retornando productName/category/etc quando existirem, mas UI precisa lidar com null.

O importante:

- busca continua usando apenas ProductCandidate com embedding;
- embedding só é gerado para isSearchable=true;
- resultado mostra crop correto.

================================================== 15. Não mexer fora do escopo
==================================================

Não implementar:

- OCR;
- tradução;
- classificação de função;
- categoria;
- produto canônico;
- estoque;
- pedido;
- WhatsApp;
- marketplace;
- CRM;
- app mobile.

Não tentar resolver busca semântica agora.

Esta task é somente:

- reduzir custo do detector visual;
- focar em boxes;
- melhorar estabilidade do crop;
- parar de gastar tokens com metadados.

================================================== 16. Critério de aceite
==================================================

Depois de reprocessar LUKTON:

1. Cards bons podem vir por heurística.
2. Páginas difíceis podem vir por VISION_BOXES_CHEAP.
3. VISION_BOXES_CHEAP deve retornar crops de cards/produtos, não descrições.
4. Debug não deve ficar lotado por causa de metadados.
5. Custo por PDF deve cair bastante comparado ao JSON rico.
6. A tela deve mostrar sourceDetector "vision boxes" nos candidatos vindos do modelo.
7. Os candidatos pesquisáveis devem ter crop visual correto.
8. Campos productName/category/model podem ficar vazios. Isso é esperado.

Depois de reprocessar ELETROMEX:

1. Páginas onde heurística junta vários produtos devem escalar para VISION_BOXES_CHEAP.
2. O modelo deve retornar boxes separadas.
3. Candidatos com crop contaminado devem ir para Debug.
4. O sistema não deve gastar modelo premium por padrão.

================================================== 17. Validações obrigatórias
==================================================

Rodar:

pnpm prisma generate
pnpm lint
pnpm build

Corrigir erros reais.

Não criar migration se não for necessário.

================================================== 18. Entrega esperada
==================================================

Ao final, me diga:

- arquivos alterados;
- como ficou o novo prompt de visão;
- como funciona o parser de boxes;
- como a imagem é reduzida antes de enviar ao modelo;
- como as coordenadas são escaladas de volta;
- quais envs novas existem;
- como ficou sourceDetector;
- resultado de pnpm build;
- como testar reprocessando um catálogo;
- limitações atuais.
