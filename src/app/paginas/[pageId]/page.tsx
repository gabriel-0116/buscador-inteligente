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

          <Card>
            <CardHeader>
              <CardTitle>Novo produto bruto</CardTitle>
            </CardHeader>

            <CardContent>
              <form action={createRawProduct} className="grid gap-4">
                <input type="hidden" name="catalogPageId" value={page.id} />

                <div className="grid gap-2">
                  <Label htmlFor="translatedNamePt">Nome em português</Label>
                  <Input
                    id="translatedNamePt"
                    name="translatedNamePt"
                    placeholder="Ex: Adaptador de tomada USB"
                    required
                  />
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="code">Código/modelo</Label>
                  <Input id="code" name="code" placeholder="Ex: CB-075" />
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="brand">Marca</Label>
                  <Input id="brand" name="brand" placeholder="Ex: LUKTON" />
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="category">Categoria</Label>
                  <Input
                    id="category"
                    name="category"
                    placeholder="Ex: Adaptadores elétricos"
                  />
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="translatedDescriptionPt">Descrição</Label>
                  <Textarea
                    id="translatedDescriptionPt"
                    name="translatedDescriptionPt"
                    placeholder="Descrição curta do produto"
                  />
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="originalText">Texto original/OCR usado</Label>
                  <Textarea
                    id="originalText"
                    name="originalText"
                    placeholder="Cole aqui o trecho do OCR ou texto original relacionado ao produto"
                  />
                </div>

                <Button type="submit">Adicionar produto bruto</Button>
              </form>
            </CardContent>
          </Card>

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
              Nenhum produto bruto cadastrado nesta página ainda.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Código</TableHead>
                  <TableHead>Marca</TableHead>
                  <TableHead>Categoria</TableHead>
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
                    <TableCell>{product.brand || "-"}</TableCell>
                    <TableCell>{product.category || "-"}</TableCell>
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
