Você vai trabalhar no repositório buscador-inteligente.

Recebi o PDF real ELETROMEX-13.05.2026.pdf e ele confirmou que o problema não é um PDF isolado. O detector precisa funcionar com vários tipos de catálogo, não só com uma cor/layout específico.

Problema atual:
O PDF_LAYOUT está gerando vários crops bons no começo, mas depois começa a aprovar crops grandes com 2, 4, 6 ou mais produtos como se fossem 1 produto. Isso aparece como Busca: SIM / pdf layout em crops tipo:

- 750x557
- 750x595
- 869x857
- 1058x616
- 869x1139
- 1350x835

Isso é inaceitável porque crop multi-produto gera embedding misturado e destrói a busca por imagem.

A correção não deve ser baseada no ELETROMEX especificamente.
Não usar regra fixa por cor laranja.
Não usar regra fixa por fornecedor.
Não depender de IA para corrigir isso.
Não aumentar custo com vision.

Objetivo:
Transformar o detector em uma pipeline estrutural genérica para catálogos em PDF:

PDF page
→ classificar tipo de página
→ inferir layout da página
→ detectar unidades comerciais individuais
→ validar se cada crop tem exatamente 1 produto
→ indexar somente crops válidos

==================================================

1. # Criar Page Type Classifier

Criar arquivo:

src/features/catalog-processing/page-type-classifier.ts

Exportar:

type CatalogPageType =
| "cover"
| "summary"
| "category_grid"
| "partial_grid"
| "single_product"
| "non_product"
| "unknown";

function classifyCatalogPage(args: {
pageNumber: number;
pageText: string;
pageLayout?: PdfLayoutPage;
renderedWidth: number;
renderedHeight: number;
}): CatalogPageType

Regras genéricas:

cover:

- página com pouco texto de produto;
- palavras como "PRODUTOS", nome da marca grande;
- sem muitos códigos/preços;
- imagem/arte grande;
- normalmente página 1, mas não depender só do número.

summary:

- contém "SUMÁRIO", "Sumario", "Índice", "Index";
- várias linhas com categoria + número de página;
- muitos nomes de categoria;
- poucos ou nenhum código de produto real;
- não deve gerar candidatos pesquisáveis.

category_grid:

- muitos sinais repetidos de produto:
  - códigos tipo EL-1234, KM-1234, LU-1234, J-60, etc.
  - "R$"
  - "PCS/CX"
  - "UNID.CX"
  - bullets/lista de descrição
- normalmente 6 a 9 produtos.

partial_grid:

- mesma lógica da category_grid, mas com poucos produtos e muito espaço vazio.
- exemplos: páginas com 3, 4 ou 5 produtos.

single_product:

- 1 produto dominante, 1 código, 1 preço.

non_product:

- páginas de índice, capa, tabela, categoria sem produto, página vazia.

unknown:

- quando não tiver certeza.

IMPORTANTE:
A classificação não deve depender de cor. Deve usar texto extraído do PDF, quantidade de padrões repetidos e layout.

================================================== 2. Criar Product Signal Extractor
==================================================

Criar arquivo:

src/features/catalog-processing/product-signals.ts

Exportar funções:

extractProductSignals(args: {
text: string;
}): {
productCodes: string[];
priceCount: number;
pcsCxCount: number;
unitCxCount: number;
bulletCount: number;
categoryWords: string[];
}

Padrões importantes:

- códigos de produto:
  - /\b[A-Z]{1,4}[- ]?\d{2,5}(?:[- ][A-Z0-9]{1,5})?\b/g
  - aceitar EL-1108, EL-4043-CC, EL-1407-5G, J-60, PRO6, etc.
- preços:
  - R$ 15,9
  - R$ 1133
- embalagem:
  - PCS/CX
  - UNID.CX
  - Unid.CX
- bullets:
  - linhas começando com •
  - listas numeradas

Essa função será usada tanto por página inteira quanto por crop.

================================================== 3. Criar detector estrutural de grid por texto + geometria
==================================================

Criar arquivo:

src/features/catalog-processing/grid-layout-detector.ts

Objetivo:
Detectar cards individuais usando posições reais de texto/layout do PDF, não só imagem.

Entrada:

- pageLayout
- renderedWidth
- renderedHeight
- pageText
- pageType

Saída:
Array de boxes de produto individuais.

Estratégia:

1. Usar blocos de texto que contêm:
   - código de produto;
   - preço;
   - PCS/CX;
   - UNID.CX.
2. Agrupar esses sinais em clusters espaciais.
3. Inferir linhas e colunas pelos centros dos sinais.
4. Criar boxes de célula a partir dos limites entre colunas/linhas.
5. Remover header da categoria e footer/page number.
6. Para cada célula, verificar se contém pelo menos um sinal de produto.
7. Aceitar células vazias como vazias, não como produto.
8. Em página 3x3, gerar até 9 cards.
9. Em página parcial, gerar só as células que têm produto.

Não usar cores como fonte principal.
Cores podem ser usadas apenas como sinal auxiliar.

Exportar:

detectGridProductBoxes(args: {
pageLayout: PdfLayoutPage;
pageText: string;
pageType: CatalogPageType;
renderedWidth: number;
renderedHeight: number;
}): Array<{
x: number;
y: number;
width: number;
height: number;
confidence: number;
source: "GRID_LAYOUT";
reason: string;
}>

Critérios:

- Se pageType for cover/summary/non_product, retornar [].
- Se pageType for category_grid ou partial_grid, usar sinais de produto para montar grid.
- Se não conseguir inferir grid, retornar [] e deixar fallback tentar.

================================================== 4. Alterar a ordem do pipeline
==================================================

Arquivo:
src/features/catalog-processing/detect-product-candidates.ts

Ordem nova:

1. Classificar página com classifyCatalogPage.
2. Se página for cover/summary/non_product:
   - não gerar candidato pesquisável.
   - opcionalmente gerar debug com rejectReason = "non_product_page".
   - não chamar vision.
3. Se pageLayout existir:
   - tentar GRID_LAYOUT primeiro.
   - se GRID_LAYOUT gerar candidatos bons, usar ele.
4. Se GRID_LAYOUT falhar:
   - tentar PDF_LAYOUT.
5. Se PDF_LAYOUT gerar crop suspeito:
   - subdividir ou rejeitar.
6. Heurística só depois.
7. Vision só fallback controlado.

A prioridade correta deve ser:

PAGE_CLASSIFIER
→ GRID_LAYOUT
→ PDF_LAYOUT com validação forte
→ HEURISTIC
→ VISION fallback

Não deixar PDF_LAYOUT aceitar lixo só porque achou 1 candidato.

================================================== 5. Corrigir evaluatePdfLayoutQuality
==================================================

Arquivo:
src/features/catalog-processing/detect-product-candidates.ts

Hoje ela aceita se searchableCount >= 1.
Remover essa lógica.

Nova lógica:

- Se pageType é cover/summary/non_product: PDF_LAYOUT nunca deve ser aceito como produto.
- Se pageType é category_grid:
  - precisa retornar uma quantidade compatível com sinais da página.
  - Se a página tem 9 códigos/preços e o PDF_LAYOUT gerou 1, 2 ou 3 crops, rejeitar.
- Se pageType é partial_grid:
  - aceitar menos, mas não aceitar crop gigante.
- Se qualquer candidato pesquisável parecer multi-card, rejeitar PDF_LAYOUT.
- Se houver crop com mais de 1 código de produto ou mais de 1 preço interno, marcar como multi_card_crop.

================================================== 6. Criar validação forte por crop
==================================================

Criar função:

validateSingleProductCrop(args: {
cropImagePath: string;
cropText?: string;
cropBox: { x: number; y: number; width: number; height: number };
pageWidth: number;
pageHeight: number;
}): Promise<{
valid: boolean;
rejectReason?: string;
singleProductScore: number;
signalCount: {
productCodes: number;
prices: number;
pcsCx: number;
unitCx: number;
};
}>

Regras:

- Se crop tem 0 sinal de produto e não tem imagem clara: rejectReason = "no_product_signal".
- Se crop tem 2 ou mais códigos de produto fortes: rejectReason = "multi_card_crop".
- Se crop tem 2 ou mais preços R$: rejectReason = "multi_card_crop".
- Se crop ocupa área grande demais da página e tem múltiplas regiões densas: rejectReason = "multi_card_crop".
- Se parece índice/capa/tabela: rejectReason = "non_product_page".
- Se contém exatamente 1 grupo principal de produto: válido.

Adicionar rejectReasons:

- "multi_card_crop"
- "non_product_page"
- "no_product_signal"
- "grid_detection_failed"

Adicionar todos os graves em SEVERE_REJECTS.

================================================== 7. Subdividir PDF_LAYOUT composite
==================================================

Criar arquivo:

src/features/catalog-processing/composite-card-splitter.ts

Exportar:

splitCompositeProductBox(args: {
pageImagePath: string;
pageLayout?: PdfLayoutPage;
pageText?: string;
box: { x: number; y: number; width: number; height: number };
pageWidth: number;
pageHeight: number;
}): Promise<Array<{
x: number;
y: number;
width: number;
height: number;
confidence: number;
reason: string;
}>>

Estratégias:

1. Se o box contém múltiplos códigos/preços pelo texto do layout, usar as posições desses sinais para dividir.
2. Se contém 2 colunas, dividir verticalmente.
3. Se contém 2 linhas, dividir horizontalmente.
4. Testar splits:
   - 2x1
   - 1x2
   - 2x2
   - 3x1
   - 1x3
   - 3x2
   - 3x3
5. Manter apenas subboxes que passam validateSingleProductCrop.
6. Se gerar 2 ou mais subcards válidos, descartar o box original.
7. Se não conseguir subdividir, manter o original apenas em Debug com rejectReason = "multi_card_crop".

================================================== 8. Não indexar crop suspeito
==================================================

Regra absoluta:
Candidato com qualquer um desses rejectReasons não pode ter isSearchable=true:

- multi_card_crop
- non_product_page
- no_product_signal
- grid_detection_failed
- page_like_crop
- too_vertical
- too_horizontal
- header_footer
- mostly_white
- empty_cell

Na dúvida:
isSearchable=false.

É melhor perder um produto temporariamente do que indexar crop misturado.

================================================== 9. Logs obrigatórios
==================================================

Adicionar logs:

[page-classifier] page N type=category_grid codes=9 prices=9 pcs=9
[grid-layout] page N boxes=9 searchable=9
[pdf-layout] page N rawCards=3 accepted=false reason=below_expected_grid
[pdf-layout-split] page N card 2 750x595 -> 2 subcards
[crop-validate] page N crop K reject=multi_card_crop codes=4 prices=4
[crop-validate] page N crop K valid singleProductScore=0.93

Adicionar env:

CATALOG_DEBUG_PAGES="3,4,5,17,26,28,58,60,80,87"

Quando setado, logar:

- pageType
- sinais extraídos
- boxes brutos
- boxes finais
- motivos de rejeição

================================================== 10. Testes mínimos com ELETROMEX
==================================================

Testar usando o PDF ELETROMEX-13.05.2026.pdf.

Casos esperados:

- Página 1: cover, 0 pesquisáveis.
- Página 2: summary, 0 pesquisáveis.
- Página 3: category_grid, 9 pesquisáveis.
- Página 4: category_grid, 9 pesquisáveis.
- Página 5: partial_grid, 4 pesquisáveis.
- Página 6: category_grid, 9 pesquisáveis.
- Página 17: partial_grid, 7 pesquisáveis.
- Página 26: partial_grid, 5 pesquisáveis.
- Página 28: partial_grid, 3 pesquisáveis.
- Página 58: partial_grid, 3 pesquisáveis.
- Página 60: category_grid, 9 pesquisáveis.
- Página 61: single_product ou partial_grid, 1 pesquisável.
- Página 62: single_product, 1 pesquisável.
- Página 80: single_product, 1 pesquisável.
- Página 87: partial_grid, 2 pesquisáveis.

Não pode aparecer como Busca: SIM:

- capa;
- sumário;
- índice;
- tabela de categorias;
- crop com 2 produtos;
- crop com 4 produtos;
- crop com 6 produtos;
- crop vertical gigante;
- crop horizontal gigante;
- página inteira.

================================================== 11. Não quebrar o resto
==================================================

Não mexer em:

- schema do banco, exceto se absolutamente necessário;
- busca textual;
- embeddings;
- OCR;
- upload;
- Supabase;
- Prisma;
- UI grande.

Pode adicionar badges novos na UI:

- grid layout
- página ignorada
- multi-produto
- sem sinal de produto

================================================== 12. Rodar validações
==================================================

Rodar:

pnpm prisma generate
pnpm lint
pnpm build

Corrigir erros reais.

================================================== 13. Entrega esperada
==================================================

Ao final, responder:

- arquivos criados;
- arquivos alterados;
- como o page classifier funciona;
- como o grid layout detector funciona;
- como valida crop único;
- como evita multi_card_crop;
- logs esperados;
- resultado dos testes com ELETROMEX;
- resultado do build/lint.
