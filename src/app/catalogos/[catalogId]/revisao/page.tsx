import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getRawProductsReviewByCatalogId } from "@/features/raw-products/queries";
import {
  approveConfidentRawProductsFromCatalog,
  approveRawProduct,
  rejectRawProduct,
} from "@/features/raw-products/actions";
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
import {
  createSupplierOfferFromRawProduct,
  createSupplierOffersFromApprovedRawProducts,
} from "@/features/supplier-offers/actions";

type CatalogReviewPageProps = {
  params: Promise<{
    catalogId: string;
  }>;
};

function formatStatus(status: string) {
  const labels: Record<string, string> = {
    PENDING_REVIEW: "Pendente",
    APPROVED: "Aprovado",
    REJECTED: "Rejeitado",
    MERGED: "Mesclado",
  };

  return labels[status] ?? status;
}

function getStatusBadgeVariant(status: string) {
  if (status === "APPROVED") return "default";
  if (status === "REJECTED") return "destructive";

  return "secondary";
}

function formatConfidence(confidence: number | null) {
  if (confidence === null) return "-";

  return `${Math.round(confidence * 100)}%`;
}

export default async function CatalogReviewPage({
  params,
}: CatalogReviewPageProps) {
  const { catalogId } = await params;

  const catalog = await getRawProductsReviewByCatalogId(catalogId);

  if (!catalog) {
    notFound();
  }

  const rawProducts = catalog.pages.flatMap((page) =>
    page.rawProducts.map((product) => ({
      ...product,
      pageNumber: page.pageNumber,
    }))
  );

  const pendingCount = rawProducts.filter(
    (product) => product.status === "PENDING_REVIEW"
  ).length;

  const approvedCount = rawProducts.filter(
    (product) => product.status === "APPROVED"
  ).length;

  const rejectedCount = rawProducts.filter(
    (product) => product.status === "REJECTED"
  ).length;

  const offersCreatedCount = rawProducts.filter(
    (product) => product.supplierOffer
  ).length;

  const approvedWithoutOfferCount = rawProducts.filter(
    (product) => product.status === "APPROVED" && !product.supplierOffer
  ).length;

  const confidentPendingCount = rawProducts.filter(
    (product) =>
      product.status === "PENDING_REVIEW" &&
      product.confidence !== null &&
      product.confidence >= 0.65 &&
      product.code &&
      product.translatedNamePt
  ).length;

  const returnTo = `/catalogos/${catalog.id}/revisao`;

  return (
    <main className="mx-auto flex max-w-7xl flex-col gap-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Button variant="ghost" asChild className="mb-3 px-0">
            <Link href={`/catalogos/${catalog.id}`}>
              ← Voltar para catálogo
            </Link>
          </Button>

          <h1 className="text-2xl font-semibold">Revisão de produtos</h1>

          <p className="text-muted-foreground mt-1 text-sm">
            {catalog.fileName} · Fornecedor: {catalog.supplier.name}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {approvedWithoutOfferCount > 0 ? (
            <form action={createSupplierOffersFromApprovedRawProducts}>
              <input type="hidden" name="catalogId" value={catalog.id} />
              <input type="hidden" name="returnTo" value={returnTo} />

              <Button type="submit" variant="outline">
                Criar ofertas aprovadas ({approvedWithoutOfferCount})
              </Button>
            </form>
          ) : null}

          {confidentPendingCount > 0 ? (
            <form action={approveConfidentRawProductsFromCatalog}>
              <input type="hidden" name="catalogId" value={catalog.id} />
              <input type="hidden" name="returnTo" value={returnTo} />

              <Button type="submit">
                Aprovar confiáveis ({confidentPendingCount})
              </Button>
            </form>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-5">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Total</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{rawProducts.length}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Pendentes</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{pendingCount}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Aprovados</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{approvedCount}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Rejeitados</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{rejectedCount}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">
              Ofertas criadas
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{offersCreatedCount}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Produtos extraídos</CardTitle>
        </CardHeader>

        <CardContent>
          {rawProducts.length === 0 ? (
            <div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm">
              Nenhum produto bruto foi extraído deste catálogo ainda.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Imagem</TableHead>
                  <TableHead>Página</TableHead>
                  <TableHead>Nome</TableHead>
                  <TableHead>Código</TableHead>
                  <TableHead>Marca</TableHead>
                  <TableHead>Categoria</TableHead>
                  <TableHead>Confiança</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Oferta</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {rawProducts.map((product) => (
                  <TableRow key={product.id}>
                    <TableCell>
                      {product.imageUrl ? (
                        <Image
                          src={`/api/raw-products/${product.id}/image`}
                          alt={product.translatedNamePt || "Produto bruto"}
                          width={120}
                          height={90}
                          unoptimized
                          className="rounded border object-contain"
                        />
                      ) : (
                        "-"
                      )}
                    </TableCell>

                    <TableCell>{product.pageNumber}</TableCell>

                    <TableCell className="font-medium">
                      <Link
                        href={`/produtos-brutos/${product.id}`}
                        className="underline-offset-4 hover:underline"
                      >
                        {product.translatedNamePt || "Produto bruto"}
                      </Link>
                    </TableCell>

                    <TableCell>{product.code || "-"}</TableCell>
                    <TableCell>{product.brand || "-"}</TableCell>
                    <TableCell>{product.category || "-"}</TableCell>
                    <TableCell>
                      {formatConfidence(product.confidence)}
                    </TableCell>

                    <TableCell>
                      <Badge variant={getStatusBadgeVariant(product.status)}>
                        {formatStatus(product.status)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {product.supplierOffer ? "Criada" : "-"}
                    </TableCell>

                    <TableCell>
                      <div className="flex justify-end gap-2">
                        {product.status === "APPROVED" &&
                        !product.supplierOffer ? (
                          <form action={createSupplierOfferFromRawProduct}>
                            <input
                              type="hidden"
                              name="rawProductId"
                              value={product.id}
                            />
                            <input
                              type="hidden"
                              name="returnTo"
                              value={returnTo}
                            />

                            <Button type="submit" size="sm" variant="outline">
                              Criar oferta
                            </Button>
                          </form>
                        ) : null}

                        <Button variant="outline" size="sm" asChild>
                          <Link href={`/produtos-brutos/${product.id}`}>
                            Editar
                          </Link>
                        </Button>

                        {product.status !== "APPROVED" ? (
                          <form action={approveRawProduct}>
                            <input
                              type="hidden"
                              name="rawProductId"
                              value={product.id}
                            />
                            <input
                              type="hidden"
                              name="returnTo"
                              value={returnTo}
                            />

                            <Button type="submit" size="sm">
                              Aprovar
                            </Button>
                          </form>
                        ) : null}

                        {product.status !== "REJECTED" ? (
                          <form action={rejectRawProduct}>
                            <input
                              type="hidden"
                              name="rawProductId"
                              value={product.id}
                            />
                            <input
                              type="hidden"
                              name="returnTo"
                              value={returnTo}
                            />

                            <Button
                              type="submit"
                              variant="destructive"
                              size="sm"
                            >
                              Rejeitar
                            </Button>
                          </form>
                        ) : null}
                      </div>
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
