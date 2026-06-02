Você vai trabalhar no repositório buscador-inteligente.

Contexto:
O detector multimodal com VISION_JSON_CHEAP está funcionando e gera metadados bons, mas alguns crops ficam desalinhados. O modelo identifica o produto certo, mas o bounding box às vezes pega pedaço do card de cima, faixa de preço anterior ou corta parte do card correto.

Problema real:
Hoje o código usa diretamente o box retornado pelo modelo. Isso é fraco. O modelo deve ser tratado como chute inicial, não como verdade final.

Objetivo:
Criar uma etapa de refinamento local do bounding box antes de recortar o candidato.

Não mexer em busca.
Não mexer em OCR.
Não mexer em categoria.
Não mexer em embeddings.
Não mexer em UI grande.
Não trocar modelo agora.

Arquivos principais:
src/features/catalog-processing/detect-product-candidates.ts
src/features/catalog-processing/vision-box-validator.ts

==================================================

1. # Criar refinamento de box visual

Criar função:

refineVisionBoxToCard(args: {
pageImagePath: string;
box: { x: number; y: number; width: number; height: number };
pageWidth: number;
pageHeight: number;
}): Promise<{
box: { x: number; y: number; width: number; height: number };
changed: boolean;
reason?: string;
}>

Essa função deve usar o box do modelo como ponto inicial, mas ajustar o box para coincidir melhor com o card visual.

================================================== 2. Estratégia de refinamento
==================================================

O refinamento deve:

1. Expandir uma margem ao redor do box inicial.
   Exemplo:
   - expandir 8% a 15% para cima/baixo/lados.
   - sem sair da página.

2. Dentro dessa região expandida, procurar limites naturais do card:
   - grandes faixas brancas horizontais;
   - grandes faixas brancas verticais;
   - borda do card;
   - mudança forte entre fundo branco e conteúdo;
   - gaps entre cards.

3. Ajustar:
   - topo do box para não pegar pedaço do card anterior;
   - base do box para não cortar preço/descrição do card;
   - laterais para não pegar card vizinho.

4. Se encontrar um retângulo mais plausível, usar ele.
5. Se não encontrar, manter box original.

================================================== 3. Detectar contaminação de card vizinho
==================================================

Criar validações para detectar crop ruim mesmo com qualityScore alto.

Um crop deve ser marcado como suspeito se:

- contém duas barras de preço/cabeçalho distantes;
- contém duas marcas/logos repetidas em regiões diferentes;
- tem um corte horizontal forte no meio indicando dois cards empilhados;
- tem muito conteúdo relevante encostado no topo ou na base;
- o produto principal está só na metade inferior porque a parte superior veio de outro card.

Não precisa ser perfeito, mas precisa detectar casos como:

- crop do microfone pegando faixa verde/card acima;
- crop que começa no card anterior e termina no card correto;
- crop com 1,5 cards.

Se suspeito, tentar refinar novamente ou marcar rejectReason = "bad_card_boundary".

================================================== 4. Não aceitar VISION_JSON_CHEAP automaticamente só porque tem confidence alto
==================================================

Hoje o modelo pode retornar confidence 0.95, e o crop passa.

Mas confidence do modelo não garante que o box está bom.

Adicionar regra:
isSearchable = true somente se:

- confidence >= 0.45
- qualityScore >= 0.60
- boxBoundaryScore >= 0.60
- sem rejectReason grave

Adicionar campo interno calculado:
boxBoundaryScore

Se não quiser migration, não precisa salvar no banco agora. Pode só usar no cálculo.
Se quiser salvar, adicionar campo opcional ProductCandidate.boundaryScore Float?.

================================================== 5. Aplicar refinamento antes do crop
==================================================

No runVisionDetector:

Hoje:

- valida box
- dedupe
- corta exatamente box

Novo:

- valida box
- dedupe
- refineVisionBoxToCard
- recalcula dimensões
- corta box refinado
- avalia qualityScore
- avalia boundaryScore
- decide isSearchable

================================================== 6. Melhorar dedupe depois do refinamento
==================================================

Depois de refinar boxes, rodar dedupe novamente por IoU.

Motivo:
Dois boxes diferentes do modelo podem refinar para o mesmo card.

Manter o melhor por:

- maior visionConfidence;
- maior boundaryScore;
- maior qualityScore.

================================================== 7. Manter fallback em cascata
==================================================

Não remover modo auto.
Não remover HEURISTIC.
Não remover VISION_JSON_CHEAP.
Não remover budget.

O modo auto está correto:

- heurística boa não chama IA;
- heurística ruim chama barato.

O ajuste é só melhorar os boxes vindos do VISION_JSON_CHEAP.

================================================== 8. Logs de diagnóstico
==================================================

Adicionar logs por página/candidato quando refinar:

[vision-refine] page 12 crop 3: changed=true reason=snap_to_card_boundary old=... new=...

Se detectar crop ruim:
[vision-refine] page 12 crop 3: rejected bad_card_boundary

================================================== 9. Debug visual
==================================================

Na tela do catálogo, se possível sem complicar:

- mostrar se sourceDetector é VISION_JSON_CHEAP;
- mostrar rejectReason bad_card_boundary quando houver;
- manter link para página original.

Não precisa criar editor manual.

================================================== 10. Critério de aceite
==================================================

Depois de reprocessar LUKTON:

- Cards heurísticos bons podem continuar como heurístico.
- Cards VISION_JSON_CHEAP não devem pegar pedaço do card de cima.
- Microfones não devem vir com faixa/card anterior no topo.
- Box do produto deve ficar alinhado ao card completo.
- Se o sistema não conseguir refinar, o candidato deve ir para Debug com rejectReason bad_card_boundary, não entrar como pesquisável.

Depois de reprocessar ELETROMEX:

- Cards com VISION_JSON_CHEAP devem aparecer como cards completos.
- Não pode cortar 1,5 produto.
- Não pode juntar pedaço de dois cards.

================================================== 11. Rodar validações
==================================================

Rodar:
pnpm prisma generate
pnpm lint
pnpm build

Corrigir erros reais.
