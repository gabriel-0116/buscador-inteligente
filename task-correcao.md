Você vai trabalhar no repositório buscador-inteligente.

Contexto:
O sistema processa catálogos PDF para criar ProductCandidate e permitir busca por imagem.

Tentamos várias abordagens:

- pdfimages;
- pdftoppm + heurística por gaps;
- detector multimodal com JSON rico;
- detector multimodal boxes-only;
- refinamento de bounding box.

O resultado ainda não está bom. A heurística aceita crops ruins como bons, e o LLM multimodal erra coordenadas/boxes em alguns casos. Além disso, usar modelo visual por página é caro.

Nova decisão:
Não usar LLM como recortador principal.
Não confiar em heurística visual simples como recortador principal.

A nova pipeline principal deve ser PDF_LAYOUT: extrair a estrutura real do PDF com PyMuPDF e agrupar os elementos em cards de produto.

Objetivo:
Implementar uma pipeline PDF-structure-first para detectar cards/produtos automaticamente, usando os objetos reais do PDF: textos, imagens, desenhos, retângulos e coordenadas.

A IA multimodal deve virar fallback, não método principal.

Não mexer em busca, ranking, estoque, WhatsApp, marketplace ou UI grande.

==================================================

1. # Diagnóstico obrigatório antes de alterar

Antes de implementar, verifique o estado atual:

- detect-product-candidates.ts
- vision-json-detector.ts
- product-json-schema.ts
- process-catalog.ts
- page.tsx do catálogo

Confirme se o código local realmente contém:

- VISION_BOXES_CHEAP
- parseVisionBoxesResponse
- prepareVisionInputImage

Se não existir, alinhar com o estado local atual antes de alterar.

================================================== 2. Criar script Python de extração estrutural
==================================================

Adicionar dependência Python:

PyMuPDF

Criar:

scripts/extract_pdf_layout.py

Entrada:

- caminho do PDF
- caminho de saída JSON

Exemplo de uso:
python scripts/extract_pdf_layout.py input.pdf output-layout.json

Saída esperada:

{
"pages": [
{
"pageNumber": 1,
"width": 595,
"height": 842,
"blocks": [
{
"type": "text",
"x": 100,
"y": 200,
"width": 120,
"height": 30,
"text": "EL-1920"
},
{
"type": "image",
"x": 130,
"y": 260,
"width": 200,
"height": 180
},
{
"type": "drawing",
"x": 80,
"y": 180,
"width": 420,
"height": 360
}
]
}
]
}

Extrair:

- blocos de texto com bbox;
- palavras ou spans com bbox quando útil;
- imagens com bbox;
- desenhos/retângulos com bbox quando disponível;
- dimensões da página em pontos PDF.

Importante:

- O PDF usa coordenadas em pontos.
- A página renderizada usa pixels.
- Salvar escala ou permitir converter depois para pixels.

Não precisa extrair conteúdo perfeito do texto agora. O foco é posição.

================================================== 3. Criar wrapper TypeScript para rodar o Python
==================================================

Criar:

src/features/catalog-processing/pdf-layout-extractor.ts

Função:

extractPdfLayout(args: {
pdfPath: string;
outputDir: string;
}): Promise<PdfLayoutDocument>

Ela deve:

- chamar o script Python com child_process spawn/execFile;
- ler o JSON gerado;
- validar estrutura básica com Zod;
- retornar pages/blocks;
- tratar erro de Python sem derrubar todo o processamento.

Não usar shell string insegura.
Usar execFile/spawn com args.

================================================== 4. Criar detector de cards por layout PDF
==================================================

Criar:

src/features/catalog-processing/pdf-layout-card-detector.ts

Função:

detectCardsFromPdfLayout(args: {
pageLayout: PdfLayoutPage;
renderedPageWidth: number;
renderedPageHeight: number;
}): Array<{
x: number;
y: number;
width: number;
height: number;
confidence: number;
source: "PDF_LAYOUT";
text?: string;
}>

Estratégia:

1. Converter coordenadas PDF para pixels da imagem renderizada.
2. Remover elementos irrelevantes:
   - cabeçalho provável;
   - rodapé provável;
   - número de página;
   - elementos muito pequenos;
   - linhas/faixas isoladas;
   - capa/sumário quando não houver produto.

3. Criar clusters espaciais:
   - imagens próximas de textos pertencem ao mesmo produto;
   - preço, código, modelo e descrição próximos entram no mesmo cluster;
   - elementos separados por grandes gaps viram clusters diferentes;
   - retângulos/desenhos podem ajudar a definir bordas de card.

4. Cada cluster gera uma bounding box.
5. Expandir a box levemente para pegar o card inteiro.
6. Rejeitar clusters ruins:
   - quase página inteira;
   - coluna inteira com vários cards;
   - faixa horizontal;
   - só texto sem imagem;
   - vazio;
   - cabeçalho/rodapé.

7. Deduplicar boxes por IoU.

Critério:
1 card/produto visível = 1 box.

Não assumir:

- sempre 3x3;
- sempre verde;
- sempre laranja;
- sempre mesmo fornecedor.

================================================== 5. Integrar PDF_LAYOUT na pipeline principal
==================================================

Atualizar process-catalog.ts:

Depois de renderizar páginas, antes de processar página por página:

1. rodar extractPdfLayout(pdfPath)
2. manter layout em memória

Atualizar detect-product-candidates.ts para nova ordem:

1. PDF_LAYOUT
2. HEURISTIC
3. VISION_BOXES_CHEAP
4. VISION_BOXES_PREMIUM opcional
5. FALLBACK

Ou seja:

- tentar PDF_LAYOUT primeiro;
- se PDF_LAYOUT gerar candidatos bons, usar esses candidatos e não chamar IA;
- se PDF_LAYOUT falhar, usar heurística;
- se heurística falhar, usar vision cheap;
- premium só se VISION_USE_PREMIUM_FALLBACK=true.

Adicionar sourceDetector:

- PDF_LAYOUT

Manter os antigos:

- HEURISTIC
- VISION_BOXES_CHEAP
- VISION_BOXES_PREMIUM
- FALLBACK

================================================== 6. Corrigir avaliador da heurística
==================================================

Hoje a heurística aceita crops ruins como bons.

Adicionar regra dura:

Candidato pesquisável não pode ter:

- width >= 750 e height >= 1000
- height / width > 1.8 quando a altura indicar coluna com vários produtos
- área maior que 35% da página
- múltiplos cards visíveis dentro do crop
- aspecto de coluna vertical

Se um crop é 869x1713 ou parecido, ele NÃO pode ser searchable.

No modo auto:
Se qualquer candidato pesquisável da heurística parece coluna/página/bloco multi-card, heurística deve ser rejeitada e escalar para PDF_LAYOUT/vision.

================================================== 7. Criar validador multi-card
==================================================

Criar função:

looksLikeMultiCardCrop(args)

Usar sinais:

- crop muito alto;
- crop contém várias faixas de preço/cabeçalho repetidas;
- crop contém grandes gaps horizontais internos;
- crop contém vários blocos visuais empilhados;
- crop tem proporção de coluna.

Se true:

- rejectReason = "multi_card_crop"
- isSearchable = false

Adicionar multi_card_crop em SEVERE_REJECTS.

================================================== 8. Criar candidates a partir de boxes PDF_LAYOUT
==================================================

Para cada box do PDF_LAYOUT:

- recortar da página renderizada original;
- calcular qualityScore;
- validar com looksLikeMultiCardCrop;
- se aprovado, isSearchable=true;
- sourceDetector=PDF_LAYOUT;
- confidence pode começar em 0.85.

Se houver texto do cluster:

- salvar originalText opcionalmente.
- Não precisa preencher productName/category agora.

================================================== 9. Manter Vision como fallback caro
==================================================

VISION_BOXES_CHEAP só deve rodar se:

- PDF_LAYOUT falhar ou gerar poucos bons candidatos;
- heurística falhar;
- budget permitir.

Não usar IA em página que PDF_LAYOUT resolveu.

Manter:
CATALOG_MAX_VISION_PAGES

================================================== 10. Atualizar UI de debug
==================================================

Na página do catálogo, mostrar badge:

- PDF_LAYOUT = "pdf layout"
- HEURISTIC = "heurístico"
- VISION_BOXES_CHEAP = "vision boxes"
- FALLBACK = "fallback"

Mostrar rejectReason:

- multi_card_crop
- too_large
- vertical_column
- page_like_crop

Na seção Pesquisáveis, não deve aparecer crop de página inteira/coluna.

================================================== 11. Atualizar documentação
==================================================

Atualizar README/CLAUDE.md:

Nova ordem:
PDF_LAYOUT → HEURISTIC → VISION_BOXES_CHEAP → FALLBACK

Explicar:

- PyMuPDF é usado para extrair estrutura real do PDF.
- IA não é recortador principal.
- Vision é fallback para páginas escaneadas ou sem estrutura.

Adicionar instrução de instalação:
pip install PyMuPDF

Se houver Dockerfile, adicionar PyMuPDF se necessário.

================================================== 12. Critério de aceite
==================================================

Após reprocessar ELETROMEX:

- crops 869x1713, 434x1713, 869x1139 não podem aparecer como searchable.
- colunas inteiras devem ir para Debug ou ser subdivididas.
- páginas com 4, 6 ou 9 cards devem gerar cards separados.
- sourceDetector ideal deve ser PDF_LAYOUT na maioria das páginas digitais.
- IA deve ser exceção, não regra.

Após reprocessar LUKTON:

- cards individuais devem continuar bons.
- faixas verdes isoladas não podem ser searchable.
- páginas com grade devem gerar cards separados.

Após reprocessar LEHMOX:

- cards laranja/arredondados devem ser separados.
- não depender de cor.

================================================== 13. Validações
==================================================

Rodar:
pnpm prisma generate
pnpm lint
pnpm build

Se houver script Python:

- testar com um PDF real;
- logar quantas páginas/blocos foram extraídos;
- logar quantos candidatos PDF_LAYOUT foram gerados por página.

================================================== 14. Entrega esperada
==================================================

Ao final, me diga:

- arquivos alterados;
- como PyMuPDF extrai estrutura;
- como converte coordenadas PDF para pixels;
- como agrupa blocos em cards;
- como detecta multi_card_crop;
- quando cai para heurística;
- quando chama Vision;
- resultado de build/lint;
- como testar reprocessando catálogo.
