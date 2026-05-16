import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import { getCatalogById } from "@/features/catalogs/queries";
import { formatBytes, formatCatalogStatus } from "@/features/catalogs/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type CatalogPageProps = {
  params: Promise<{
    catalogId: string;
  }>;
};

export default async function CatalogPage({ params }: CatalogPageProps) {
  const { catalogId } = await params;

  const catalog = await getCatalogById(catalogId);

  if (!catalog) {
    notFound();
  }

  const pagesCount = catalog.pages.length;
  const totalPageCount =
    catalog.pageCount ?? (pagesCount > 0 ? pagesCount : null);

  const ocrPagesCount = catalog.pages.filter((page) => page.rawText).length;

  const rawProducts = catalog.pages.flatMap((page) => page.rawProducts);

  const rawProductsCount = rawProducts.length;

  const pendingReviewCount = rawProducts.filter(
    (product) => product.status === "PENDING_REVIEW"
  ).length;

  const approvedCount = rawProducts.filter(
    (product) => product.status === "APPROVED"
  ).length;

  const rejectedCount = rawProducts.filter(
    (product) => product.status === "REJECTED"
  ).length;

  const supplierOffersCount = catalog.offers?.length ?? 0;

  const hasPages = pagesCount > 0;
  const hasRawProducts = rawProductsCount > 0;
  const hasPendingReview = pendingReviewCount > 0;
  const hasOffers = supplierOffersCount > 0;

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <Button variant="ghost" asChild className="mb-3 px-0">
            <Link href={`/fornecedores/${catalog.supplierId}`}>
              ← Voltar para fornecedor
            </Link>
          </Button>

          <h1 className="text-2xl font-semibold">{catalog.fileName}</h1>

          <p className="text-muted-foreground mt-1 text-sm">
            Fornecedor: {catalog.supplier.name}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {hasPages ? (
            <Button variant="outline" asChild>
              <Link href={`/catalogos/${catalog.id}/paginas`}>Ver páginas</Link>
            </Button>
          ) : null}

          {!hasPages ? (
            <form action={`/api/catalogs/${catalog.id}/process`} method="post">
              <Button type="submit" disabled={catalog.status === "PROCESSING"}>
                {catalog.status === "PROCESSING"
                  ? "Processando..."
                  : "Processar páginas"}
              </Button>
            </form>
          ) : null}

          {hasPages && !hasRawProducts ? (
            <form
              action={`/api/catalogs/${catalog.id}/extract-card-products`}
              method="post"
            >
              <Button type="submit">Extrair produtos do catálogo</Button>
            </form>
          ) : null}

          {hasRawProducts ? (
            <Button asChild>
              <Link href={`/catalogos/${catalog.id}/revisao`}>
                Revisar produtos
              </Link>
            </Button>
          ) : null}

          {hasOffers ? (
            <Button variant="outline" asChild>
              <Link href="/busca">Buscar produtos</Link>
            </Button>
          ) : null}

          <form action={`/api/catalogs/${catalog.id}/delete`} method="post">
            <Button type="submit" variant="destructive">
              Excluir catálogo
            </Button>
          </form>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Status</CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant="secondary">
              {formatCatalogStatus(catalog.status)}
            </Badge>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Páginas</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold">
              {pagesCount}/{totalPageCount ?? "-"}
            </p>
            <p className="text-muted-foreground text-xs">processadas</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">OCR auxiliar</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold">
              {ocrPagesCount}/{pagesCount}
            </p>
            <p className="text-muted-foreground text-xs">páginas com texto</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">
              Produtos brutos
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold">{rawProductsCount}</p>
            <p className="text-muted-foreground text-xs">cards extraídos</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Revisão</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold">{pendingReviewCount}</p>
            <p className="text-muted-foreground text-xs">
              pendentes · {approvedCount} aprovados · {rejectedCount} rejeitados
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Ofertas</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold">{supplierOffersCount}</p>
            <p className="text-muted-foreground text-xs">criadas para busca</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Próxima ação</CardTitle>
        </CardHeader>

        <CardContent className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            {!hasPages ? (
              <>
                <p className="font-medium">Processar páginas do PDF</p>
                <p className="text-muted-foreground text-sm">
                  O catálogo ainda precisa ser convertido em imagens antes de
                  extrair produtos.
                </p>
              </>
            ) : !hasRawProducts ? (
              <>
                <p className="font-medium">Extrair produtos do catálogo</p>
                <p className="text-muted-foreground text-sm">
                  As páginas já existem. Agora gere os cards/produtos brutos
                  para revisão.
                </p>
              </>
            ) : hasPendingReview ? (
              <>
                <p className="font-medium">Revisar produtos pendentes</p>
                <p className="text-muted-foreground text-sm">
                  A extração automática só vira base confiável depois da
                  aprovação humana.
                </p>
              </>
            ) : hasOffers ? (
              <>
                <p className="font-medium">Buscar produtos aprovados</p>
                <p className="text-muted-foreground text-sm">
                  As ofertas já foram criadas. Agora valide se a busca textual
                  encontra os produtos certos.
                </p>
              </>
            ) : (
              <>
                <p className="font-medium">Revisar resultado da extração</p>
                <p className="text-muted-foreground text-sm">
                  Não existem pendências nem ofertas suficientes. Revise os
                  produtos rejeitados ou extraia novamente.
                </p>
              </>
            )}
          </div>

          {!hasPages ? (
            <form action={`/api/catalogs/${catalog.id}/process`} method="post">
              <Button type="submit" disabled={catalog.status === "PROCESSING"}>
                {catalog.status === "PROCESSING"
                  ? "Processando..."
                  : "Processar páginas"}
              </Button>
            </form>
          ) : !hasRawProducts ? (
            <form
              action={`/api/catalogs/${catalog.id}/extract-card-products`}
              method="post"
            >
              <Button type="submit">Extrair produtos</Button>
            </form>
          ) : hasPendingReview ? (
            <Button asChild>
              <Link href={`/catalogos/${catalog.id}/revisao`}>
                Ir para revisão
              </Link>
            </Button>
          ) : hasOffers ? (
            <Button asChild>
              <Link href="/busca">Ir para busca</Link>
            </Button>
          ) : (
            <Button variant="outline" asChild>
              <Link href={`/catalogos/${catalog.id}/revisao`}>Ver revisão</Link>
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Metadados do arquivo</CardTitle>
        </CardHeader>

        <CardContent>
          <div className="grid gap-3 text-sm">
            <div className="grid gap-1">
              <span className="text-muted-foreground">ID do catálogo</span>
              <code className="bg-muted rounded px-2 py-1">{catalog.id}</code>
            </div>

            <div className="grid gap-1">
              <span className="text-muted-foreground">Caminho local</span>
              <code className="bg-muted rounded px-2 py-1">
                {catalog.filePath || "-"}
              </code>
            </div>

            <div className="grid gap-1">
              <span className="text-muted-foreground">Tipo do arquivo</span>
              <span>{catalog.mimeType || "-"}</span>
            </div>

            <div className="grid gap-1">
              <span className="text-muted-foreground">Tamanho</span>
              <span>{formatBytes(catalog.fileSize)}</span>
            </div>

            <div className="grid gap-1">
              <span className="text-muted-foreground">Enviado em</span>
              <span>
                {new Intl.DateTimeFormat("pt-BR").format(catalog.createdAt)}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Páginas extraídas</CardTitle>
        </CardHeader>

        <CardContent>
          {catalog.pages.length === 0 ? (
            <div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm">
              Nenhuma página extraída ainda. Primeiro processe o PDF para gerar
              imagens das páginas.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Página</TableHead>
                  <TableHead>Imagem</TableHead>
                  <TableHead>Texto bruto</TableHead>
                  <TableHead>Produtos brutos</TableHead>
                  <TableHead>Criada em</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {catalog.pages.map((page) => (
                  <TableRow key={page.id}>
                    <TableCell>{page.pageNumber}</TableCell>

                    <TableCell>
                      {page.imageUrl ? (
                        <Image
                          src={`/api/catalog-pages/${page.id}/image`}
                          alt={`Página ${page.pageNumber}`}
                          width={120}
                          height={160}
                          unoptimized
                          className="rounded border object-contain"
                        />
                      ) : (
                        "-"
                      )}
                    </TableCell>

                    <TableCell>
                      {page.rawText ? "Texto extraído" : "-"}
                    </TableCell>

                    <TableCell>{page.rawProducts.length}</TableCell>

                    <TableCell>
                      {new Intl.DateTimeFormat("pt-BR").format(page.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
