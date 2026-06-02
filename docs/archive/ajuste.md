Ajuste pequeno e importante no reranker.

Problema:
A regra atual diz: codeMatches ou visibleText→codes → exact + high + score 0.98, vencendo até mustNotMatch.

Isso é perigoso.

Correção:

1. Só modelCodes explícitos devem gerar exact/high:
   query.modelCodes ∩ candidate.modelCodes normalizados.

2. visibleText batendo em candidate.modelCodes NÃO pode sozinho gerar exact/high.
   Deve gerar apenas bônus forte se:
   - o texto visível tiver formato de código/modelo real;
   - tiver pelo menos uma letra e um número;
   - tiver comprimento normalizado >= 5;
   - não for termo genérico como USB, 5W, IPX5, RPM, 7500RPM, TYPEC, PD, FAST, CHARGE.

3. Criar helper:
   isStrongModelCode(value: string): boolean

Regra sugerida:

- normalizar uppercase sem pontuação;
- exigir length >= 5;
- exigir pelo menos 1 letra e 1 número;
- rejeitar termos genéricos:
  USB, TYPEC, TYPEA, LIGHTNING, IPX5, IPX6, IPX7, RPM, W, 5W, 10W, 20W, 30W, 7500RPM, FASTCHARGE, CHARGER.

4. Reranking:

- explicitCodeMatch = query.modelCodes fortes ∩ candidate.modelCodes fortes.
  Se true: exact/high/score alto, pode vencer mustNotMatch.
- visibleTextCodeHint = query.visibleText forte ∩ candidate.modelCodes fortes.
  Se true: bônus alto, mas ainda respeita mustNotMatch e functionGroup.
- visibleText genérico não dá bônus de código.

5. Atualizar reason:

- "mesmo código/modelo" só para explicitCodeMatch.
- "texto visível sugere código/modelo" para visibleTextCodeHint.

6. Rodar:
   pnpm lint
   pnpm build
   npx tsc --noEmit
