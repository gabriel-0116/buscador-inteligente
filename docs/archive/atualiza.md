Você vai trabalhar no repositório:

https://github.com/gabriel-0116/buscador-inteligente

O problema atual é este:

Hoje o sistema tenta extrair imagens dos produtos usando `pdfimages`. Isso só funciona quando o PDF tem imagens embutidas. Mas alguns catálogos não têm JPG separado dos produtos dentro do PDF. Nesses casos, o sistema não consegue pegar os produtos corretamente.

Precisamos ajustar o processamento do catálogo.

Objetivo:
Quando eu subir um PDF, o sistema deve renderizar cada página do PDF como imagem e depois tentar recortar os produtos a partir da imagem da página.

Não quero recomeçar o projeto. Quero ajustar a pipeline atual.

O fluxo correto agora deve ser:

PDF enviado
→ renderizar cada página como JPG
→ salvar as páginas renderizadas
→ detectar regiões/candidatos de produtos na página
→ recortar esses candidatos
→ salvar os recortes
→ gerar embedding dos recortes
→ usar os recortes na busca por imagem

Importante:
A busca não deve ser feita em cima da página inteira nem em cima de card inteiro cheio de texto, logo e fundo. Ela deve usar o melhor recorte possível do produto.

Tarefas:

1. Criar renderização de páginas do PDF

Criar um arquivo:

src/features/catalog-processing/render-pages.ts

Ele deve usar `pdftoppm`, do poppler-utils, para transformar cada página do PDF em JPG.

Comando base:

pdftoppm -jpeg -r 180 arquivo.pdf output/page

A função deve retornar uma lista com:

{
pageNumber: number;
imagePath: string;
}

2. Ajustar o processamento do catálogo

No arquivo:

src/features/catalog-processing/process-catalog.ts

Alterar a lógica principal.

Hoje ele usa `pdfimages`. Isso pode ficar como fallback, mas não pode ser mais o método principal.

O método principal deve ser:

- renderizar as páginas do PDF;
- para cada página, salvar a imagem inteira no Supabase Storage;
- tentar criar recortes de produtos;
- salvar os recortes no Supabase Storage;
- gerar embedding dos recortes;
- salvar os recortes no banco.

3. Criar detector simples de recortes

Criar arquivo:

src/features/catalog-processing/detect-product-crops.ts

Esse detector não precisa ser perfeito. Ele precisa ser melhor que não recortar nada.

A lógica inicial pode ser simples:

- abrir a imagem da página com sharp;
- detectar a área com conteúdo que não seja fundo branco;
- remover margens brancas;
- criar um ou mais crops candidatos;
- descartar crops pequenos demais;
- descartar crops muito finos ou muito largos;
- salvar no máximo alguns candidatos por página para não poluir o banco.

Critérios iniciais:

- largura mínima: 180px
- altura mínima: 180px
- ignorar áreas quase totalmente brancas
- ignorar áreas muito pequenas
- se não encontrar vários produtos, criar pelo menos um crop central/margens removidas da página

O objetivo é que, mesmo quando o PDF não tiver imagens JPG internas, o sistema consiga gerar recortes dos produtos a partir da página renderizada.

4. Ajustar o banco se necessário

Hoje existe ProductImage.

Pode manter esse model se for mais simples, mas o ideal é adicionar campos para saber de onde veio a imagem:

- sourceType: PAGE_CROP ou EMBEDDED_IMAGE
- pageNumber
- cropX
- cropY
- cropWidth
- cropHeight

Se for simples, criar enum:

enum ImageSourceType {
PAGE_CROP
EMBEDDED_IMAGE
}

E atualizar ProductImage:

sourceType ImageSourceType @default(PAGE_CROP)
pageNumber Int?
cropX Int?
cropY Int?
cropWidth Int?
cropHeight Int?

Não precisa criar uma arquitetura enorme agora. Só preciso conseguir saber se a imagem veio de um recorte da página ou de uma imagem embutida.

5. Organizar storage

Salvar arquivos assim:

product-images/
{catalogId}/
pages/
page-001.jpg
page-002.jpg
crops/
crop-001.jpg
crop-002.jpg
embedded/
img-001.jpg

As imagens usadas na busca devem ser preferencialmente as de `crops/`.

6. Atualizar busca

A busca por imagem deve continuar usando embeddings, mas agora deve buscar principalmente imagens com:

sourceType = PAGE_CROP

Se ainda existirem imagens antigas de `EMBEDDED_IMAGE`, elas podem aparecer, mas a prioridade deve ser PAGE_CROP.

7. Atualizar tela do catálogo

Na página do catálogo, eu preciso conseguir ver:

- páginas renderizadas;
- recortes gerados;
- dimensões dos recortes;
- página de origem;
- sourceType.

Isso é importante para eu depurar se o sistema está recortando produto ou salvando lixo.

Pode ser na própria página do catálogo. Não precisa criar tela bonita. Precisa ser funcional.

8. Manter o projeto simples

Não implementar agora:

- OCR;
- classificação automática por categoria;
- produto canônico;
- revisão humana complexa;
- WhatsApp;
- estoque;
- marketplace;
- pedido;
- CRM.

Agora o foco é só um:

PDF sem imagem embutida → renderizar página → recortar produtos → gerar embedding → buscar por imagem.

9. Teste esperado

Depois da alteração, eu quero conseguir:

- subir um PDF que não tem JPG separado dos produtos;
- o sistema renderizar as páginas;
- o sistema gerar alguns recortes;
- eu abrir o catálogo e ver esses recortes;
- fazer busca por imagem usando esses recortes.

Se o sistema continuar dependendo só de `pdfimages`, a tarefa não foi resolvida.

10. Rodar validações

Depois de alterar, rode:

pnpm prisma generate
pnpm lint
pnpm build

Se algum comando falhar por variável de ambiente ausente, explique. Mas corrija erros de TypeScript e código.

Ao final, me entregue um resumo dizendo:

- quais arquivos foram alterados;
- como ficou a nova pipeline;
- se `pdfimages` ainda é usado ou virou fallback;
- como testar com um PDF;
- quais limitações ainda existem no detector de recortes.
