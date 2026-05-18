# Validação da busca por imagem

## Configuração

- Modelo usado:
- Data do teste:
- Total gasto aproximado na OpenAI:
- Quantidade de imagens testadas: 10

## Testes

| #   | Produto da imagem       | IA identificou como         | Resultado correto apareceu? | Falsos positivos? | Observação                           |
| --- | ----------------------- | --------------------------- | --------------------------- | ----------------- | ------------------------------------ |
| 1   | Liquidificador portátil | Liquidificador portátil     | Sim                         | Não               | Trouxe duplicado ZZJ-01              |
| 2   | Câmera infantil         | Câmera fotográfica infantil | Sim                         | Baixo             | Trouxe variações da mesma categoria  |
| 3   | Antena de TV            | Antena interna para TV      | Sim                         | Baixo             | Resultado útil                       |
| 4   | Suporte metálico        | Suporte metálico            | Parcial                     | Sim               | Puxou suporte de TV                  |
| 5   | Microfone sem código    | Microfone de lapela sem fio | Não/Inconclusivo            | Não               | Verificar se existe oferta aprovada  |
| 6   | Print de microfone      | Microfone sem fio USB-C     | Parcial                     | Sim               | TYPE-C puxou resultado errado        |
| 7   | Depilador KM-7103       | Depilador elétrico KM-7103  | Sim                         | Não               | Melhor caso                          |
| 8   | Cola branca             | Cola branca líquida         | Não/Inconclusivo            | Não               | Verificar se existe na base          |
| 9   | Print com vários itens  | Depende do recorte          | Parcial                     | Possível          | Produto principal pode ficar ambíguo |
| 10  | iPhone                  | iPhone                      | Sim                         | Não               | Correto não retornar candidato       |

## Problemas encontrados

| Problema                                | Exemplo                          | Gravidade | Próxima ação                        |
| --------------------------------------- | -------------------------------- | --------- | ----------------------------------- |
| Código genérico usado como modelo       | TYPE-C, 100PC/CX                 | Alta      | Filtrar códigos fracos              |
| Resultado duplicado                     | ZZJ-01 repetido                  | Média     | Deduplicar candidatos               |
| Termo genérico puxando categoria errada | suporte metálico → suporte de TV | Alta      | Melhorar score por função/categoria |
| Produto correto não encontrado          | cola/microfone                   | Média     | Verificar se está aprovado/ofertado |

## Decisão

A busca por imagem v0 é promissora, mas precisa filtrar códigos genéricos e deduplicar resultados antes de ser apresentada como fluxo confiável.
