import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/ui/badge";
import { AutoRefresh } from "@/components/auto-refresh";
import { CatalogImagesGrid } from "@/components/catalog-images-grid";

type Props = { params: Promise<{ catalogId: string }> };

const statusLabel: Record<string, string> = {
  PROCESSING: "Processando",
  READY: "Pronto",
  FAILED: "Falhou",
};

const statusVariant: Record<
  string,
  "default" | "secondary" | "destructive"
> = {
  PROCESSING: "secondary",
  READY: "default",
  FAILED: "destructive",
};

export default async function CatalogPage({ params }: Props) {
  const { catalogId } = await params;

  const catalog = await prisma.catalog.findUnique({
    where: { id: catalogId },
    include: {
      supplier: { select: { id: true, name: true } },
      images: {
        select: { id: true, imageUrl: true, width: true, height: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!catalog) notFound();

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      {catalog.status === "PROCESSING" && <AutoRefresh intervalMs={5000} />}

      <div className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">
          <Link href="/fornecedores" className="hover:underline">
            Fornecedores
          </Link>{" "}
          /{" "}
          <Link
            href={`/fornecedores/${catalog.supplier.id}`}
            className="hover:underline"
          >
            {catalog.supplier.name}
          </Link>{" "}
          / {catalog.fileName}
        </p>
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-semibold">{catalog.fileName}</h1>
          <Badge variant={statusVariant[catalog.status]}>
            {statusLabel[catalog.status]}
          </Badge>
        </div>
      </div>

      {catalog.error && (
        <p className="rounded bg-destructive/10 p-3 text-sm text-destructive">
          Erro: {catalog.error}
        </p>
      )}

      <div className="flex gap-6 text-sm text-muted-foreground">
        <span>
          Fornecedor:{" "}
          <strong className="text-foreground">{catalog.supplier.name}</strong>
        </span>
        {catalog.imageCount !== null && (
          <span>
            Imagens:{" "}
            <strong className="text-foreground">{catalog.imageCount}</strong>
          </span>
        )}
      </div>

      {catalog.status === "PROCESSING" && (
        <p className="text-muted-foreground">
          Processando catálogo, aguarde...
        </p>
      )}

      {catalog.status === "READY" && (
        <CatalogImagesGrid images={catalog.images} />
      )}
    </main>
  );
}
