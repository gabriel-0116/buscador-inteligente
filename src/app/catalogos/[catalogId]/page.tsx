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

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Button variant="ghost" asChild className="mb-3 px-0">
            <Link href={`/fornecedores/${catalog.supplierId}`}>
              ← Voltar para fornecedor
            </Link>
          </Button>

          <h1 className="text-2xl font-semibold">{catalog.fileName}</h1>

          <p className="mt-1 text-sm text-muted-foreground">
            Fornecedor: {catalog.supplier.name}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <form action={`/api/catalogs/${catalog.id}/process`} method="post">
            <Button type="submit" disabled={catalog.status === "PROCESSING"}>
              {catalog.status === "PROCESSING"
                ? "Processando..."
                : "Processar páginas"}
            </Button>
          </form>

          <form action={`/api/catalogs/${catalog.id}/delete`} method="post">
            <Button type="submit" variant="destructive">
              Excluir catálogo
            </Button>
          </form>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
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
            <CardTitle className="text-sm font-medium">Tamanho</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold">
              {formatBytes(catalog.fileSize)}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Páginas</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold">{catalog.pageCount ?? "-"}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Enviado em</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold">
              {new Intl.DateTimeFormat("pt-BR").format(catalog.createdAt)}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Metadados do arquivo</CardTitle>
        </CardHeader>

        <CardContent>
          <div className="grid gap-3 text-sm">
            <div className="grid gap-1">
              <span className="text-muted-foreground">ID do catálogo</span>
              <code className="rounded bg-muted px-2 py-1">{catalog.id}</code>
            </div>

            <div className="grid gap-1">
              <span className="text-muted-foreground">Caminho local</span>
              <code className="rounded bg-muted px-2 py-1">
                {catalog.filePath || "-"}
              </code>
            </div>

            <div className="grid gap-1">
              <span className="text-muted-foreground">Tipo do arquivo</span>
              <span>{catalog.mimeType || "-"}</span>
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
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              Nenhuma página extraída ainda. A próxima fase será converter este
              PDF em imagens e criar registros em CatalogPage.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Página</TableHead>
                  <TableHead>Imagem</TableHead>
                  <TableHead>Texto bruto</TableHead>
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
                    </TableCell>{" "}
                    <TableCell>
                      {page.rawText ? "Texto extraído" : "-"}
                    </TableCell>
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
