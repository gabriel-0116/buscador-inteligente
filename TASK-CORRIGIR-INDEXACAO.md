Você vai trabalhar no repositório:

https://github.com/gabriel-0116/buscador-inteligente

Contexto:
Este projeto é um buscador interno de produtos em catálogos PDF. O usuário sobe um catálogo de fornecedor, o sistema recorta produtos, gera embeddings visuais e permite buscar por imagem.

Problema atual:
O commit anterior melhorou a pipeline porque agora renderiza páginas do PDF com pdftoppm e cria ProductCandidate. Mas o resultado ainda está ruim.

Na busca aparecem:

- cards inteiros;
- faixas verdes;
- pedaços vazios de página;
- textos;
- produtos de outra função;
- blocos visuais que não são produto.

Isso acontece porque o detector atual pega “áreas não brancas”. Isso não é detecção de produto. Texto, logo, faixa verde, preço e card inteiro também são áreas não brancas.

Objetivo desta tarefa:
Fazer uma correção completa da INDEXAÇÃO dos produtos.

Não quero uma correção pequena.
Não quero só mexer no ranking.
Não quero só trocar limiar de similaridade.
Não quero só esconder resultados ruins na tela.

Quero corrigir o que entra no banco e o que recebe embedding.

Fluxo correto desejado:

PDF
→ renderizar páginas
→ detectar regiões/cards
→ criar crop pesquisável do produto dentro do card
→ avaliar qualidade do crop
→ salvar crops bons como pesquisáveis
→ salvar crops ruins apenas para debug
→ gerar embedding somente para crop pesquisável
→ busca retornar somente candidatos pesquisáveis
→ permitir reprocessar catálogo apagando candidatos antigos ruins

==================================================
REGRA PRINCIPAL
==================================================

Crop ruim pode existir para debug.
Crop ruim NÃO pode entrar na busca.

O sistema não pode gerar embedding para:

- faixa verde;
- card inteiro ruim;
- texto puro;
- página quase vazia;
- logo;
- rodapé;
- cabeçalho;
- tabela;
- área muito horizontal;
- imagem quase toda branca;
- crop sem produto claro.

==================================================

1. # Ajustar banco de dados

Atualize o model ProductCandidate para suportar controle de qualidade.

Adicionar campos:

isSearchable Boolean @default(false)
qualityScore Float?
rejectReason String?
cardUrl String?

Explicação:

- cropUrl deve ser a imagem principal usada no resultado/debug.
- cardUrl pode guardar o card maior de origem, quando existir.
- isSearchable define se entra ou não na busca.
- qualityScore mede qualidade do crop.
- rejectReason explica por que não entra na busca.

Manter os campos atuais:

- originalUrl
- cropUrl
- cropX
- cropY
- cropWidth
- cropHeight
- confidence
- sourceType
- embedding

Importante:

- Default de isSearchable deve ser false.
- Só marcar true quando o crop passar nos filtros de qualidade.
- Criar migration Prisma.
- Rodar prisma generate.

================================================== 2. Atualizar detector de candidatos
==================================================

Arquivo principal:

src/features/catalog-processing/detect-product-candidates.ts

O detector atual está muito fraco. Ele usa pixels não brancos e acaba pegando qualquer coisa. Reescreva/refatore a lógica para separar:

1. região/card maior;
2. crop pesquisável do produto;
3. avaliação de qualidade.

A função deve retornar algo assim:

type DetectedCandidate = {
imagePath: string;
cardImagePath?: string;
x: number;
y: number;
width: number;
height: number;
confidence: number;
qualityScore: number;
isSearchable: boolean;
rejectReason?: string;
};

================================================== 3. Criar filtros obrigatórios de qualidade
==================================================

Criar funções claras no detector:

- isMostlyWhiteCrop
- isGreenBarDominant
- isTooHorizontal
- isTooVertical
- hasEnoughVisualMass
- hasCentralObjectMass
- estimateTextLikeDensity
- calculateCropQuality
- shouldIndexCrop

Critérios mínimos:

A) Rejeitar crop muito pequeno:

- width < 180
- height < 180

B) Rejeitar crop muito horizontal:

- aspect ratio maior que 3.2
- especialmente quando altura for baixa

C) Rejeitar faixa verde:
Detectar verde dominante:

- muitos pixels com G alto e R/B baixos;
- crop com muita concentração de verde;
- crop horizontal com verde dominante.

Se parecer barra verde do catálogo, rejectReason = "green_bar".

D) Rejeitar crop quase branco:

- mais de 88% branco ou quase branco.

E) Rejeitar crop de texto/tabela:
Heurística:

- muitos componentes pequenos;
- muita alternância de pixels escuros em linhas;
- baixa massa visual central;
- pouca área de objeto grande.

Não precisa ser perfeito, mas precisa parar de indexar texto puro.

F) Rejeitar card/página inteira:
Se o crop ocupa quase a página inteira e contém cabeçalho/rodapé/faixas, ele pode ser salvo para debug, mas não pode ser searchable.
rejectReason = "card_too_large" ou "page_like_crop".

G) Exigir massa visual central:
O crop pesquisável precisa ter conteúdo relevante no centro, não só bordas/tarjas.

================================================== 4. Separar cardCrop de searchCrop
==================================================

Quando detectar um card grande, não use esse card diretamente para embedding.

Faça:

- cardCrop: região maior, usada para referência/debug;
- searchCrop: região menor, tentando pegar o produto principal.

Para gerar searchCrop dentro do card:

- remover topo com logo/código/título;
- remover rodapé com preço/faixa verde;
- remover barras horizontais verdes;
- procurar região com maior massa visual de objeto;
- priorizar região central;
- evitar regiões só com texto;
- gerar no máximo 1 ou 2 crops pesquisáveis por card.

Exemplo:
Se o card tem imagem do produto + texto + embalagem + preço:

- o card pode ficar salvo como cardUrl;
- o cropUrl deve tentar focar no produto/embalagem principal, não no card inteiro.

================================================== 5. Não gerar embedding para lixo
==================================================

Atualizar:

src/features/catalog-processing/process-catalog.ts

Antes de gerar embedding:

if (!candidate.isSearchable || candidate.qualityScore < 0.50) {
salvar ProductCandidate para debug, se fizer sentido;
NÃO gerar embedding;
embedding deve ficar null;
}

Só gerar embedding quando:

- isSearchable = true
- qualityScore >= 0.50
- crop passou nos filtros.

Isso é obrigatório.

Hoje o erro é salvar e indexar qualquer fallback. Pare com isso.

================================================== 6. Limitar candidatos por página
==================================================

Não poluir o banco.

Regras:

- no máximo 3 candidatos pesquisáveis por página;
- no máximo 6 candidatos totais por página incluindo debug;
- ordenar por qualityScore;
- salvar os melhores primeiro;
- fallback ruim deve ser debug, não searchable.

================================================== 7. Atualizar busca
==================================================

Arquivo:

src/features/visual-search/search.ts

A busca deve consultar somente ProductCandidate com:

embedding IS NOT NULL
isSearchable = true
qualityScore >= 0.50

Não retornar:

- debug crop;
- fallback ruim;
- tarja;
- página;
- card rejeitado.

A query deve filtrar isso no SQL, não apenas no frontend.

Exemplo:

WHERE pc.embedding IS NOT NULL
AND pc."isSearchable" = true
AND pc."qualityScore" >= 0.50

================================================== 8. Atualizar UI da busca
==================================================

A página de busca deve continuar mostrando:

- cropUrl;
- fornecedor;
- catálogo;
- similaridade;
- link para página original.

Adicionar, se disponível:

- qualityScore;
- detectedLabel/functionGroup se existirem.

Não mostrar resultados que não sejam searchable, porque a API já deve filtrar.

================================================== 9. Atualizar página do catálogo/debug
==================================================

Na página do catálogo, eu preciso ver claramente:

Para cada candidato:

- imagem cropUrl;
- se é pesquisável ou não;
- qualityScore;
- confidence;
- rejectReason;
- sourceType;
- dimensões;
- link para página original;
- cardUrl, se existir.

Visualmente:

- mostrar badge "Busca: SIM" para isSearchable true;
- mostrar badge "Debug/Rejeitado" para isSearchable false;
- mostrar rejectReason quando rejeitado.

Isso é essencial para depurar.

================================================== 10. Criar reprocessamento de catálogo
==================================================

Preciso de um jeito simples de reprocessar catálogo, porque os candidatos antigos ruins já estão no banco.

Criar uma rota ou botão simples:

POST /api/catalogs/[catalogId]/reprocess

Fluxo:

1. buscar catálogo;
2. apagar ProductCandidate antigo;
3. apagar CatalogPage antigo;
4. apagar arquivos antigos do Supabase Storage dentro da pasta {catalogId}/pages e {catalogId}/candidates, se possível;
5. marcar Catalog status PROCESSING;
6. rodar processCatalog de novo.

Problema:
Hoje o PDF original provavelmente é apagado do /tmp depois do processamento.

Solução mínima aceitável:

- passar a salvar também o PDF original no Supabase Storage em:
  product-images/{catalogId}/original/catalog.pdf

ou criar bucket/pasta própria para PDFs:
catalog-files/{catalogId}/original.pdf

Depois disso, o reprocess consegue baixar/ler o PDF salvo e processar de novo.

Se implementar reprocessar ficar grande demais:

- pelo menos crie DELETE limpo do catálogo antigo;
- documente que o usuário precisa reenviar o PDF.
  Mas o ideal é salvar o PDF original para permitir reprocessamento.

================================================== 11. Ajustar upload do catálogo
==================================================

No upload do PDF:

src/app/api/catalogs/route.ts

Além de salvar temporariamente em /tmp para processar:

- salvar o PDF original no Supabase Storage;
- guardar a URL ou path no Catalog.

Adicionar no Catalog, se necessário:

pdfUrl String?
pdfStoragePath String?

Assim o catálogo pode ser reprocessado depois.

================================================== 12. Limpar dados antigos ruins
==================================================

Como já existem candidatos ruins no banco, a correção precisa deixar claro que:

- candidatos antigos sem isSearchable/qualityScore não devem aparecer na busca;
- com default isSearchable=false, eles devem sumir da busca;
- depois é necessário reprocessar o catálogo.

Não tente manter compatibilidade com resultado ruim antigo.

================================================== 13. Não mexer em coisas fora do escopo
==================================================

Não implementar agora:

- marketplace;
- pedido;
- estoque;
- CRM;
- WhatsApp;
- app mobile;
- pagamento;
- nota fiscal;
- scraping automático;
- treinamento de modelo próprio;
- área para cliente final.

Também não implementar agora uma IA gigante para classificar categoria.

O foco desta tarefa é:
corrigir indexação, crop, qualidade, searchable e reprocessamento.

================================================== 14. Comandos obrigatórios
==================================================

Depois de alterar:

pnpm prisma generate
pnpm lint
pnpm build

Se migration precisar ser aplicada:

- criar migration Prisma;
- explicar comando necessário.

Se build falhar por variável de ambiente ausente, explicar.
Mas erros reais de TypeScript devem ser corrigidos.

================================================== 15. Critério de aceite
==================================================

Após esta correção e reprocessamento do catálogo:

1. A busca não pode retornar faixas verdes.
2. A busca não pode retornar página quase vazia.
3. A busca não pode retornar texto puro.
4. A busca não pode retornar card inteiro como principal se houver crop melhor.
5. Crop ruim pode aparecer no debug, mas com isSearchable=false.
6. Embedding só deve existir para crop pesquisável.
7. A tela do catálogo deve mostrar o motivo de rejeição dos crops ruins.
8. A busca deve usar somente isSearchable=true.
9. Ao reenviar ou reprocessar o catálogo LUKTON, os resultados precisam ser visivelmente mais limpos.

================================================== 16. Entrega esperada
==================================================

Ao final, me diga:

- arquivos alterados;
- campos adicionados no Prisma;
- como ficou a nova pipeline;
- como o sistema decide se um crop entra ou não na busca;
- como reprocessar um catálogo;
- quais comandos foram rodados;
- resultado de lint/build;
- limitações atuais do detector.

Importante:
Não entregue uma solução que apenas “parece melhor”.
A correção só vale se impedir lixo de entrar na busca.
