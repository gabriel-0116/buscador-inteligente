import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCatalogById } from "@/features/catalogs/queries";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type CatalogPagesPageProps = {
  params: Promise<{
    catalogId: string;
  }>;
};

export default async function CatalogPagesPage({
  params,
}: CatalogPagesPageProps) {
  const { catalogId } = await params;

  const catalog = await getCatalogById(catalogId);

  if (!catalog) {
    notFound();
  }

  return (
    <main className="mx-auto flex max-w-7xl flex-col gap-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Button variant="ghost" asChild className="mb-3 px-0">
            <Link href={`/catalogos/${catalog.id}`}>
              ← Voltar para catálogo
            </Link>
          </Button>

          <h1 className="text-2xl font-semibold">Páginas extraídas</h1>

          <p className="text-muted-foreground mt-1 text-sm">
            {catalog.fileName} · {catalog.pages.length} páginas
          </p>
        </div>
      </div>

      {catalog.pages.length === 0 ? (
        <div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm">
          Nenhuma página extraída ainda.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {catalog.pages.map((page) => (
            <Card key={page.id} className="overflow-hidden">
              <CardContent className="flex flex-col gap-3 p-3">
                <div className="text-sm font-medium">
                  Página {page.pageNumber}
                </div>

                <Link href={`/paginas/${page.id}`} className="block">
                  <Image
                    src={`/api/catalog-pages/${page.id}/image`}
                    alt={`Página ${page.pageNumber}`}
                    width={360}
                    height={500}
                    unoptimized
                    className="h-auto w-full rounded border object-contain transition-opacity hover:opacity-80"
                  />
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </main>
  );
}
