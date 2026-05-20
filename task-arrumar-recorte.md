Você vai trabalhar no repositório buscador-inteligente.

Contexto:
O sistema processa catálogos PDF de fornecedores, renderiza páginas e extrai ProductCandidate para busca por imagem.

O commit atual melhorou a estrutura:

- ProductCandidate tem isSearchable, qualityScore, rejectReason e cardUrl.
- processCatalog só gera embedding para isSearchable=true com qualityScore >= 0.50.
- search.ts filtra isSearchable=true.
- existe reprocessamento.

Mas o detector ainda está errado.

Problemas vistos no teste real:

1. Vários cards bons estão sendo marcados como Debug / muito pequeno.
2. O sistema está limitando poucos candidatos pesquisáveis por página.
3. A maioria dos catálogos usa grade de cards, geralmente 3 colunas x 3 linhas.
4. O detector ainda tenta achar produto por pixel não-branco, mas para estes PDFs o correto é primeiro detectar o card do produto.
5. Para o MVP, o recorte correto é um card limpo por produto. Depois melhoramos busca/categoria.

Objetivo desta tarefa:
Corrigir a extração de cards/crops para que cada produto do catálogo vire um ProductCandidate pesquisável, quando o card estiver limpo.

Não mexer agora na busca semântica.
Não mexer em IA.
Não mexer em categoria.
Não implementar OCR.
Não mexer em funcionalidades fora do MVP.

Foco exclusivo:
recorte de cards de produto.

Arquivos principais:
src/features/catalog-processing/detect-product-candidates.ts
src/features/catalog-processing/process-catalog.ts
src/app/catalogos/[catalogId]/page.tsx

==================================================

1. # Corrigir limite de candidatos por página

Hoje existe limite baixo demais:

MAX_SEARCHABLE_PER_PAGE = 3
MAX_TOTAL_PER_PAGE = 6

Isso está errado. Os PDFs têm páginas com até 9 produtos.

Alterar para:

MAX_SEARCHABLE_PER_PAGE = 12
MAX_TOTAL_PER_PAGE = 18

Ou criar limite dinâmico baseado no número de cards detectados.

Não pode descartar produto bom só porque já achou 3 na página.

================================================== 2. Corrigir bug de escala no "muito pequeno"
==================================================

O detector usa ANALYSIS_WIDTH = 800 e reduz a imagem para análise.

O problema:
calculateCropQuality compara bW e bH com MIN_CROP_PX = 180 em coordenadas da imagem reduzida.

Isso faz cards bons serem rejeitados como "too_small".

Corrigir de uma destas formas:

Opção A:
Passar scale para calculateCropQuality e comparar assim:
minWidth = MIN_CROP_PX _ scale
minHeight = MIN_CROP_PX _ scale

Opção B:
Avaliar tamanho mínimo usando coordenadas originais, não coordenadas da imagem reduzida.

Critério:
Um card original com mais de 250px de largura e 250px de altura não deve ser rejeitado como "too_small".

================================================== 3. Criar estratégia de extração por grade de cards
==================================================

A maioria dos catálogos enviados usa layout de grade:

- 3 colunas;
- até 3 linhas;
- cards separados por espaços brancos;
- cabeçalho grande no topo;
- rodapé ou número de página embaixo;
- barras coloridas dentro dos cards.

Criar uma função no detector:

detectCardGridFromPage(...)

Essa função deve tentar detectar cards retangulares da página.

Estratégia sugerida:

1. Ignorar cabeçalho da página.
2. Ignorar rodapé da página.
3. Encontrar região útil onde ficam os cards.
4. Detectar colunas por espaços verticais brancos.
5. Detectar linhas por espaços horizontais brancos.
6. Formar células/cards.
7. Filtrar células vazias.
8. Retornar boxes dos cards.

Se uma página tiver 9 produtos, deve retornar perto de 9 cards.
Se tiver 6 produtos, deve retornar perto de 6.
Se tiver 2 produtos, deve retornar perto de 2.

Não forçar sempre 9. Mas também não limitar em 3.

================================================== 4. Tratar modelos de catálogo
==================================================

Os PDFs têm alguns modelos parecidos:

Modelo LUKTON:

- fundo branco;
- cabeçalho verde forte;
- rodapé verde;
- cards com barra verde de preço;
- geralmente 3 colunas.

Modelo laranja/preto:

- cabeçalho laranja;
- cards com moldura ou barra laranja/preta;
- geralmente 3 colunas.

Modelo LEHMOX:

- cards com borda laranja arredondada;
- 3 colunas;
- título de categoria no topo.

Não precisa criar detector perfeito por fornecedor, mas pode usar cor dominante para ajudar:

- verde forte => provavelmente LUKTON;
- laranja forte => provavelmente ELETROMEX / LEHMOX / promoção.

O detector deve rejeitar uma faixa verde/laranja isolada como produto, mas deve aceitar um card inteiro que contém produto + texto + preço.

================================================== 5. Mudar o conceito de crop pesquisável neste momento
==================================================

Neste momento, o objetivo é:

1 card limpo = 1 ProductCandidate pesquisável.

Não tentar isolar só o objeto físico dentro do card agora, porque muitos cards têm:

- produto principal;
- embalagem;
- acessórios;
- foto de uso;
- código;
- descrição.

Para o MVP, o card completo é melhor do que recortar errado só metade do produto.

Então:

- se o detector encontrar um card bom, usar esse card como cropUrl;
- cardUrl pode ser igual ao cropUrl por enquanto;
- isSearchable = true;
- qualityScore alto.

Depois faremos uma segunda etapa para searchCrop interno se necessário.

================================================== 6. Rejeitar somente lixo real
==================================================

Rejeitar como Debug:

- faixa verde isolada;
- faixa laranja/preta isolada;
- página quase vazia;
- cabeçalho;
- rodapé;
- texto puro;
- card vazio;
- região sem imagem/produto;
- região muito horizontal;
- região muito estreita;
- crop quase todo branco.

Não rejeitar card bom só porque tem texto ou preço.
O card de catálogo sempre vai ter texto e preço.

Esse ponto é importante:
Texto dentro de um card não é motivo para rejeitar.
Texto puro sem produto é motivo para rejeitar.

================================================== 7. Ajustar qualityScore
==================================================

O qualityScore atual dá 95% para vários cards, mas também dá 0% para cards bons por causa do bug de tamanho.

Refatorar qualityScore para cards:

Um card bom deve ter:

- tamanho suficiente;
- proporção parecida com card de catálogo;
- alguma massa visual;
- não ser quase todo branco;
- não ser só faixa colorida;
- não ser só texto;
- conter imagem/produto ou embalagem.

Quality score esperado:

- card bom: 0.70 a 0.95;
- card duvidoso: 0.40 a 0.69;
- lixo: 0.00 a 0.39.

Regra:
isSearchable = qualityScore >= 0.60 e sem rejectReason grave.

Reject reasons graves:

- too_small;
- mostly_white;
- green_bar;
- orange_bar;
- header_footer;
- empty_cell;
- too_horizontal;
- too_vertical.

================================================== 8. Detectar barras coloridas isoladas
==================================================

Hoje algumas barras verdes aparecem como candidatos.

Criar filtro para barras verdes e laranjas:

isColorBarDominant(...)

Rejeitar se:

- aspectRatio > 3;
- altura baixa;
- cor verde ou laranja ocupa porcentagem alta;
- pouca variação visual;
- pouco conteúdo fora da barra.

Adicionar rejectReason:

- green_bar;
- orange_bar;
- color_bar.

Mas atenção:
Um card inteiro com barra verde no rodapé NÃO deve ser rejeitado.
Só rejeitar se o crop inteiro for basicamente a barra.

================================================== 9. Melhorar tela de debug
==================================================

Na tela do catálogo, facilitar análise.

Mostrar filtros simples ou seções:

1. Pesquisáveis
2. Rejeitados / Debug

Ou pelo menos ordenar:

- isSearchable=true primeiro;
- rejectReason depois.

Já existe parte disso. Só garantir que fique claro.

Mostrar:

- qualityScore;
- rejectReason;
- dimensões;
- página original;
- card/crop.

================================================== 10. Resultado esperado após reprocessar
==================================================

Ao reprocessar o catálogo LUKTON e os outros PDFs:

1. Cards bons não devem aparecer como "muito pequeno".
2. Páginas com 9 produtos devem gerar perto de 9 cards pesquisáveis.
3. Faixas verdes isoladas não devem entrar como pesquisáveis.
4. Faixas laranjas/pretas isoladas não devem entrar como pesquisáveis.
5. Cards vazios ou página quase vazia devem ficar como Debug ou nem serem salvos.
6. Cada produto visível no catálogo deve virar um candidato pesquisável.
7. Não tentar melhorar busca ainda.

================================================== 11. Não mexer agora
==================================================

Não mexer agora em:

- OCR;
- classificação de função;
- busca híbrida;
- ranking por categoria;
- produto canônico;
- tradução;
- WhatsApp;
- estoque;
- pedido;
- marketplace.

Agora é só recorte.

================================================== 12. Rodar validações
==================================================

Ao final, rodar:

pnpm prisma generate
pnpm lint
pnpm build

Se falhar por variável de ambiente, explicar.
Se falhar por TypeScript, corrigir.

================================================== 13. Entrega
==================================================

Ao final, me diga:

- arquivos alterados;
- como o detector agora encontra cards;
- o que mudou no limite por página;
- como corrigiu o "too_small";
- como rejeita barras verdes/laranjas;
- como testar reprocessando um catálogo.
