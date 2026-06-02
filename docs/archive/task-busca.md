Ajustar reranker para não mostrar produto manual como variação pública de produto elétrico.

Erro observado:
Na busca por imagem de um barbeador elétrico Kemei, os primeiros resultados foram bons, mas apareceu na busca pública:

p.26 | Barbeador manual | variant | low

Isso não deve aparecer como resultado público. Para a query functionGroup=barbeador_eletrico, barbeador manual não é variante comercial aceitável. Deve ser related_but_not_match ou rejected/debug.

Correção:

1. Criar regra de incompatibilidade por functionGroup.
2. Se query.functionGroup === "barbeador_eletrico" e candidate.functionGroup estiver relacionado a barbeador_manual/navalha/lâmina/barbeador_descartavel, não classificar como variant público.
3. Retornar related_but_not_match | low ou rejected.
4. Adicionar regra genérica:
   - produto elétrico/recarregável ≠ produto manual;
   - carregador ≠ cabo;
   - antena ≠ cabo USB;
   - câmera ≠ fone/case;
   - máquina de cortar cabelo ≠ barbeador manual;
   - barbeador elétrico ≠ barbeador manual.
5. PUBLIC_MATCH_TYPES continua permitindo variant, mas variant só deve valer quando a função comercial base for realmente compatível.
6. Atualizar reason:
   "função parecida, mas produto manual não é equivalente ao produto elétrico".
7. Rodar:
   pnpm lint
   pnpm build
   npx tsc --noEmit

Depois testar de novo:
npx tsx scripts/test-page-search.ts --image "/Users/gabrielsantos/Downloads/Captura de Tela 2026-05-29 às 17.44.44.png" --debug

Critério:

- p.26 Barbeador manual não aparece nos results públicos.
- Se aparecer, aparece apenas no debug como related_but_not_match ou rejected.
