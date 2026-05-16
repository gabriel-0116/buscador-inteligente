import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCatalogPageById } from "@/features/catalogs/queries";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createRawProduct } from "@/features/raw-products/actions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type ExtractedPagePageProps = {
  params: Promise<{
    pageId: string;
  }>;
};

export default async function ExtractedPagePage({
  params,
}: ExtractedPagePageProps) {
  const { pageId } = await params;

  const page = await getCatalogPageById(pageId);

  if (!page) {
    notFound();
  }

  return (
    <main className="mx-auto flex max-w-7xl flex-col gap-6 p-6">
      <div>
        <Button variant="ghost" asChild className="mb-3 px-0">
          <Link href={`/catalogos/${page.catalogId}/paginas`}>
            ← Voltar para páginas
          </Link>
        </Button>

        <h1 className="text-2xl font-semibold">Página {page.pageNumber}</h1>

        <p className="text-muted-foreground mt-1 text-sm">
          {page.catalog.fileName} · Fornecedor: {page.catalog.supplier.name}
        </p>
      </div>
      <form
        action={`/api/catalog-pages/${page.id}/extract-products`}
        method="post"
      >
        <Button type="submit">Extrair produtos desta página</Button>
      </form>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardContent className="p-4">
            <Image
              src={`/api/catalog-pages/${page.id}/image`}
              alt={`Página ${page.pageNumber}`}
              width={1000}
              height={1400}
              unoptimized
              className="h-auto w-full rounded border object-contain"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Dados da página</CardTitle>
          </CardHeader>

          <CardContent className="grid gap-4 text-sm">
            <div>
              <div className="text-muted-foreground">ID da página</div>
              <code className="bg-muted block rounded px-2 py-1">
                {page.id}
              </code>
            </div>

            <div>
              <div className="text-muted-foreground">Página</div>
              <div>{page.pageNumber}</div>
            </div>

            <div>
              <div className="text-muted-foreground">Texto bruto</div>

              {page.rawText ? (
                <pre className="bg-muted mt-2 max-h-[500px] overflow-auto rounded p-3 text-xs whitespace-pre-wrap">
                  {page.rawText}
                </pre>
              ) : (
                <div>Ainda não extraído</div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Produtos brutos desta página</CardTitle>
        </CardHeader>

        <CardContent>
          {page.rawProducts.length === 0 ? (
            <div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm">
              Nenhum produto bruto extraído nesta página ainda.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Código</TableHead>
                  <TableHead>Categoria</TableHead>
                  <TableHead>Confiança</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {page.rawProducts.map((product) => (
                  <TableRow key={product.id}>
                    <TableCell className="font-medium">
                      {product.translatedNamePt || "-"}
                    </TableCell>
                    <TableCell>{product.code || "-"}</TableCell>
                    <TableCell>{product.category || "-"}</TableCell>
                    <TableCell>
                      {product.confidence
                        ? `${Math.round(product.confidence * 100)}%`
                        : "-"}
                    </TableCell>
                    <TableCell>{product.status}</TableCell>
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
