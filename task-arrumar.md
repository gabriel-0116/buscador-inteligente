Você vai trabalhar no repositório buscador-inteligente.

O detector multimodal funcionou, mas o custo ficou inviável: um PDF consumiu cerca de US$5 usando modelo caro por página.

Problema:
Hoje o sistema chama o detector visual em muitas/todas as páginas. Isso funciona, mas custa demais.

Objetivo:
Criar uma pipeline de processamento em cascata para reduzir custo, usando IA só quando necessário.

Não mexer em busca, UI grande, estoque, WhatsApp, pedido ou marketplace.

==================================================

1. # Criar estratégia de detecção em cascata

Nova ordem desejada por página:

1. Rodar detector heurístico primeiro.
2. Avaliar se o resultado heurístico é bom.
3. Se for bom, usar heurística e NÃO chamar IA.
4. Se for ruim ou duvidoso, chamar detector visual barato.
5. Se detector visual barato falhar ou retornar poucos produtos, opcionalmente chamar modelo premium.
6. Se tudo falhar, salvar debug/fallback.

Critério:
Não chamar modelo multimodal caro em página que a heurística já resolveu bem.

================================================== 2. Adicionar envs de custo
==================================================

Adicionar suporte a:

VISION_DETECTOR_MODE=

- always
- auto
- off

Default: auto

VISION_DETECTOR_MODEL_CHEAP=
exemplo: gpt-5.4-mini

VISION_DETECTOR_MODEL_PREMIUM=
exemplo: gpt-5.5

VISION_USE_PREMIUM_FALLBACK=
true/false

Default: false

CATALOG_MAX_VISION_PAGES=
número máximo de páginas com visão por catálogo durante teste

Default: 20

================================================== 3. Implementar modo auto
==================================================

Se VISION_DETECTOR_MODE=auto:

Para cada página:

1. Rodar heurística.
2. Calcular qualidade da heurística.

Considerar heurística boa se:

- searchableCount >= expectedMinProducts
- nenhum crop pesquisável tem aspecto vertical gigante
- nenhum crop pesquisável tem aspecto horizontal gigante
- qualityScore médio >= 0.80
- não há muitos rejected graves
- se a página parece grade 3x3, heurística gerou pelo menos 7 candidatos

Se heurística boa:

- usar HEURISTIC
- não chamar modelo visual

Se heurística ruim:

- chamar VISION_JSON com modelo barato.

================================================== 4. Estimar expectedMinProducts
==================================================

Criar função simples:

estimateExpectedProductCount(page)

Pode usar:

- quantidade de blocos/cards detectados pela heurística;
- densidade visual;
- se página parece catálogo com grade;
- se a heurística gerou colunas gigantes ou blocos grandes.

Não precisa perfeito. Serve só para decidir se chama IA.

================================================== 5. Modelo barato primeiro
==================================================

Quando precisar de visão, usar:

VISION_DETECTOR_MODEL_CHEAP

Não usar VISION_DETECTOR_MODEL antigo como único modelo.

Se VISION_DETECTOR_MODEL_CHEAP não existir, usar VISION_DETECTOR_MODEL.

================================================== 6. Premium fallback opcional
==================================================

Só usar modelo premium se:

VISION_USE_PREMIUM_FALLBACK=true

E se:

- modelo barato falhou;
- ou retornou 0 produtos numa página claramente com produtos;
- ou retornou boxes inválidos.

Caso contrário, não usar premium.

================================================== 7. Limite de páginas com visão
==================================================

Durante testes, respeitar:

CATALOG_MAX_VISION_PAGES

Se passar do limite:

- não chamar visão nas páginas restantes;
- usar heurística/fallback;
- logar que limite foi atingido.

Isso evita gastar US$5 sem perceber.

================================================== 8. Logs de custo
==================================================

Adicionar logs por catálogo:

- totalPages
- heuristicPages
- visionCheapPages
- visionPremiumPages
- fallbackPages
- estimatedVisionCalls
- modelUsed por página

Exemplo:
[detector] page 12: HEURISTIC accepted, no vision call
[detector] page 13: HEURISTIC rejected (vertical_columns) → VISION cheap
[detector] page 13: VISION cheap raw=9 valid=9 searchable=9

================================================== 9. Guardar sourceDetector mais específico
==================================================

Usar sourceDetector:

- HEURISTIC
- VISION_JSON_CHEAP
- VISION_JSON_PREMIUM
- FALLBACK

Se o banco aceita string, não precisa migration.

================================================== 10. Não reprocessar tudo com premium
==================================================

O sistema não deve chamar gpt-5.5 em todas as páginas.

Essa regra é obrigatória.

================================================== 11. Atualizar documentação
==================================================

Atualizar README/CLAUDE.md com configuração recomendada:

VISION_DETECTOR_PROVIDER=openai
VISION_DETECTOR_MODE=auto
VISION_DETECTOR_MODEL_CHEAP=gpt-5.4-mini
VISION_DETECTOR_MODEL_PREMIUM=gpt-5.5
VISION_USE_PREMIUM_FALLBACK=false
CATALOG_MAX_VISION_PAGES=20

Explicar:

- para teste barato, usar mini;
- para qualidade máxima em poucas páginas, habilitar premium;
- nunca usar premium em catálogo inteiro sem limite.

================================================== 12. Rodar validações
==================================================

Rodar:
pnpm prisma generate
pnpm lint
pnpm build

Corrigir erros reais.
