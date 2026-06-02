Temos dois ajustes importantes no fluxo PageProductMention.

Contexto:
O analyzer de página funcionou: página 4 retornou 9 produtos e página 5 retornou 9 produtos. Porém, na UI de /catalogos/[catalogId], a lista de produtos por página está confusa porque parece não seguir a ordem visual dos produtos na página. Além disso, o modelo está marcando isKit=true em produtos comuns que só aparecem com caixa/cabo/acessórios.

Não mudar estratégia. Não voltar para crops/boxes. Continuamos com page_mentions.

Correções necessárias:

1. Preservar ordem visual dos produtos na página

Hoje a tela parece ordenar os productMentions por confidence desc. Isso atrapalha a revisão manual.

Adicionar campo no Prisma:

model PageProductMention {
...
displayOrder Int?
...
@@index([pageId, displayOrder])
}

Criar migration.

No page-product-analyzer prompt, adicionar regra explícita:

"Liste os produtos na ordem visual da página: da esquerda para a direita e de cima para baixo. Em uma grade 3x3, retorne primeiro os 3 produtos da primeira linha, depois os 3 da segunda linha, depois os 3 da terceira linha."

No process-catalog.ts, ao salvar os products:

products.forEach((p, i) => {
displayOrder: i + 1
})

Na tela src/app/catalogos/[catalogId]/page.tsx, alterar orderBy de productMentions para:

orderBy: [
{ pageNumber: "asc" },
{ displayOrder: "asc" },
{ confidence: "desc" }
]

E ao agrupar por página, manter essa ordem.

2. Corrigir regra de isKit

O modelo está marcando isKit=true quando o produto aparece com caixa, cabo USB, manual, carregador ou acessórios básicos. Isso está errado.

Atualizar o prompt em src/features/catalog-processing/page-product-analyzer.ts:

Regra nova:

- "isKit" deve ser true SOMENTE quando o item for vendido explicitamente como kit, combo, conjunto ou pacote com múltiplos produtos principais.
- Caixa, embalagem, manual, cabo USB, carregador, escova de limpeza, estojo ou acessórios básicos incluídos NÃO tornam o produto um kit.
- Se for apenas um produto principal com acessórios inclusos, use isKit=false.
- Não coloque a palavra "Kit" no namePt a menos que o catálogo realmente indique kit/combo/conjunto.

Exemplos:

- Barbeador elétrico com cabo USB e caixa → isKit=false.
- Câmera infantil com cabo USB e embalagem → isKit=false.
- Kit câmera + cartão + tripé → isKit=true.
- Kit escolar com lápis + borracha + régua → isKit=true.
- Barbeador com estojo → isKit=false, a menos que o catálogo diga explicitamente kit.

3. Pós-processamento defensivo

Depois de parsePageAnalyzerResponse, normalizar produtos:

Se p.isKit === true mas:

- p.namePt não contém kit/combo/conjunto/pacote
- p.originalName não contém kit/combo/conjunto/pacote
- p.evidenceText não contém kit/combo/conjunto/pacote
- p.kitContains tem apenas acessórios básicos como cabo USB, manual, caixa, embalagem, carregador, escova, estojo

Então forçar:
isKit=false
kitContains=[]

Criar helper:

function normalizeKitFlag(product: PageProductMentionInput): PageProductMentionInput

4. Ajustar UI

Na lista de produtos detectados de cada página, mostrar o número de ordem:

1. Esponja facial elétrica
2. Barbeador elétrico 3 em 1
3. Barbeador elétrico
   ...

Isso ajuda a revisar se o analyzer está seguindo a ordem visual.

5. Rodar testes

Depois rodar:

pnpm lint
pnpm build
npx prisma generate
npx prisma migrate dev --name add-page-product-display-order

Depois testar:

npx tsx scripts/test-page-analyzer.ts ~/Downloads/catalogo.pdf 4 5

Critério de aceite:

- Página 4 lista os 9 produtos na ordem visual da página.
- O produto do canto superior esquerdo aparece como item 1.
- O produto do canto superior central aparece como item 2.
- O produto do canto superior direito aparece como item 3.
- Produtos comuns com cabo/caixa não aparecem como kit.
- "Kit" só aparece quando for realmente kit/combo/conjunto vendido como tal.
