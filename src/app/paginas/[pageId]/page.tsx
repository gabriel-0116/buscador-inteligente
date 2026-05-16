import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCatalogPageById } from "@/features/catalogs/queries";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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

        <h1 className="text-2xl font-semibold">
          Página {page.pageNumber}
        </h1>

        <p className="mt-1 text-sm text-muted-foreground">
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

          <CardContent className="grid gap-4 text-sm">
            <div>
              <div className="text-muted-foreground">ID da página</div>
              <code className="block rounded bg-muted px-2 py-1">
                {page.id}
              </code>
            </div>

            <div>
              <div className="text-muted-foreground">Página</div>
              <div>{page.pageNumber}</div>
            </div>

            <div>
              <div className="text-muted-foreground">Texto bruto</div>
              <div>{page.rawText ? "Texto extraído" : "Ainda não extraído"}</div>
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}