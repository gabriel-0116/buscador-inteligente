# Status do Projeto

> Documento vivo. Atualizar a cada sessão de trabalho ou rodada de testes.
> Histórico antigo vai pra `docs/archive/`.

---

## Estado atual (04/06/2026)

### O que está funcionando

Pipeline `page_mentions` (default e único, após cleanup do `legacy_crops`):

- **Upload de catálogo PDF** → render via `pdftoppm -jpeg -r 180` → páginas
  salvas no Supabase Storage em `{catalogId}/pages/`.
- **Análise multimodal por página** (`page-product-analyzer.ts`) extrai por
  produto: `namePt`, `originalName`, `brand`, `modelCodes`, `aliases`,
  `functionGroup`, `colors`, `notConfuseWith`, `displayOrder` — validado
  com Zod.
- **Embeddings duplos**: textual (`text-embedding-3-small`, 1536d) em
  `PageProductMention.embedding`; visual (DINOv2, 768d) em
  `CatalogPage.visualEmbedding`.
- **Busca híbrida** (`searchPagesByQueryProfile`): paraleliza profile da
  query + DINOv2 da query, faz pgvector cosine em duas colunas, combina
  semântico + visual.
- **Reranker comercial** com hierarquia
  `functionGroup → main product → category → technical attrs → visual attrs → color → appearance`.
- **Regras especializadas** já no reranker:
  - `isStrongModelCode` vence `mustNotMatch`
  - `visibleText → code` entra como bônus, não como hard match
  - `powered-vs-manual` derruba "barbeador elétrico × manual" para
    `related_but_not_match`
- **UI**: `/busca` mostra resultado com "busca interpretada"
  (função + texto visível + não confundir com), tipo de match
  (`exact`/`equivalent`/`variant`/`kit_contains`/`accessory`/
  `related_but_not_match`), confiança, motivo e similaridade visual.
- **Debug**: `npx tsx scripts/debug-catalog-processing.ts <catalogId>`
  mostra `pageCount`, `pageProductCount`, `Catalog.error` e
  `PageAnalysis` com erro.

### Validação real (04/06/2026)

**Catálogos processados**

| Catálogo                  | Páginas | Produtos detectados | Tempo   | Custo (OpenAI) |
| ------------------------- | ------- | ------------------- | ------- | -------------- |
| ELETROMEX-13.05.2026.pdf  | 88      | 684                 | ~60 min | ~$1.21         |
| Segundo catálogo (LUKTON) | —       | —                   | —       | —              |

Média: ~7,77 produtos/página (densidade realista pra catálogo chinês
de eletrônicos). Capa e sumário corretamente identificados como
sem-produto.

**Primeiros 5 testes de busca** (fotos do Google Imagens / screenshots):

| #   | Query (foto)                  | Função interpretada | Resultado #1                                                 | Acertou |
| --- | ----------------------------- | ------------------- | ------------------------------------------------------------ | ------- |
| 1   | Escova secadora rosa/preta    | `escova_secadora`   | Pág 23 LUKTON (escovas modeladoras)                          | ✅      |
| 2   | Cabo USB branco ELETRON       | `cabo_usb`          | Pág "Cabo de Celular" ELETROMEX (15 resultados, todos cabos) | ✅      |
| 3   | Fita LED RGB (rolo)           | `fita_led`          | Pág "Iluminação" (EL-8002/EL-8003 — fitas LED)               | ✅      |
| 4   | Controle remoto preto EL-724C | `controle_remoto`   | Pág 68 EL-7974 LCD — "Produto exato / Confiança Alta"        | ✅      |
| 5   | Teclado USB preto             | `teclado`           | Pág Mercearias (EL-2116)                                     | ✅      |

**Precision@1 = 5/5 (100%)** nesta primeira rodada.

**Observações qualitativas**

- A "busca interpretada" (overlay com função + texto + "não confundir com")
  está extraindo informação cirúrgica das fotos. É a peça que mais agrega.
- O reranker classifica corretamente "Produto exato" vs "Variação" vs
  "Kit contém" vs "Confiança Alta/Média". Isso é o que faz a busca útil
  na prática (não só "achou algo parecido").
- O score visual varia entre 47% e 79%, o que é saudável — mostra que o
  reranker está graduando confiança em vez de dar tudo como match.

### Conhecidos pendentes (não bloqueantes)

1. **Falso positivo de função no #2 de "Fita LED RGB"**: trouxe uma página
   de "Fita Adesiva" como segundo resultado. Função diferente
   (`fita_adesiva` vs `fita_led`), mesma palavra-chave ("fita"). O #1
   estava correto. Correção provável: generalizar a regra
   "mismatched functionGroup → derruba para `related_but_not_match`",
   semelhante à regra `powered-vs-manual`. Adiar até ver se o caso
   aparece nas buscas do Rafael.
2. **Tempo de indexação**: ~40 s/página é caro. Aceitável pros 20
   catálogos do Rafael (~11h total se rodado de noite), mas reprocesso
   completo do acervo demora ~1 dia. Otimizações possíveis (não agora):
   batch API da OpenAI (50% mais barato, async 24h), paralelização de
   páginas dentro de um catálogo.

---

## Próxima sessão

### Tarefa

Segunda rodada de validação com 10 buscas adicionais antes de pedir
catálogos do Rafael. Critério das 10 buscas:

- 3 em categorias ainda não testadas (brinquedo, lanterna, carregador,
  umidificador, etc — escolher 3 das 7 não testadas)
- 3 "armadilha": mesmo produto em ângulo/fundo/qualidade diferente
- 2 de "confusão" deliberada (ex: fita métrica vs fita LED vs fita
  adesiva no mesmo dia; fone JBL vs fone genérico)
- 2 com código do modelo legível na foto (testa `isStrongModelCode`)

Anotar em tabela igual à de cima.

### Critério de aceite

- Se precision@1 ≥ 80% nas 10 buscas novas → **pedir catálogos
  reais ao Rafael e marcar sessão de teste presencial.**
- Se precision@1 < 80% → analisar os 2-3 casos que falharam, identificar
  padrão (função? embedding textual? reranker?), corrigir, repetir.

Não polir nada antes de chegar nesse número.

---

## Decisões arquiteturais recentes

- **04/06/2026** — Cleanup do `legacy_crops` mergeado em `main`. ~3.6k
  linhas removidas. Página inteira como resultado, produto detectado
  como unidade de inteligência: decisão consolidada.
- **04/06/2026** — Velocidade vs qualidade: aceito 1h/catálogo como
  custo de extrair produtos com `functionGroup`, `mustNotMatch` e
  `modelCodes` confiáveis. Otimizações de tempo ficam pra depois da
  validação com Rafael.
- **04/06/2026** — Polimento adiado até feedback de usuário real.
  Caso "Fita LED → Fita Adesiva" registrado como conhecido, não
  corrigido.

---

## Operação

### Pré-requisitos para subir catálogo

- Crédito OpenAI: ~$1.20 a $1.50 por catálogo de 80-90 páginas.
  Garantir saldo antes de subir lote (20 catálogos do Rafael = ~$25).
- Tempo: ~40 s/página. Catálogo de 90 páginas = ~1 h. Lote grande,
  rodar de noite.

### Comandos úteis

```bash
pnpm dev                                            # dev server
pnpm build                                          # build de produção
npx prisma migrate deploy                           # aplica migrations
npx tsx scripts/debug-catalog-processing.ts <id>    # debug de catálogo
npx tsx scripts/test-page-analyzer.ts <pdf> <pags>  # debug do analyzer
npx tsx scripts/test-page-search.ts --image <img>  # debug da busca
```

### Antes de mostrar pro Rafael

1. Rodar `pnpm build` localmente — confirmar zero erros de tsc/eslint
2. Verificar logs do Supabase (sem warnings inesperados)
3. Confirmar que `.env.local` aponta pra produção (Supabase prod já está)
4. Crédito da OpenAI suficiente pros catálogos dele
5. Planilha de ground truth preparada (template em
   `docs/archive/template-ground-truth.md` — TODO criar)
