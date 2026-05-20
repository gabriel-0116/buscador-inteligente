import { notFound } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/ui/badge";
import { AutoRefresh } from "@/components/auto-refresh";
import { DeleteCatalogButton } from "@/components/delete-catalog-button";

type Props = { params: Promise<{ catalogId: string }> };

const statusLabel: Record<string, string> = {
  PROCESSING: "Processando",
  READY: "Pronto",
  FAILED: "Falhou",
};

const statusVariant: Record<string, "default" | "secondary" | "destructive"> = {
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
      pages: {
        select: { id: true, imageUrl: true, pageNumber: true, width: true, height: true },
        orderBy: { pageNumber: "asc" },
      },
      candidates: {
        select: {
          id: true,
          cropUrl: true,
          originalUrl: true,
          pageId: true,
          width: true,
          height: true,
          sourceType: true,
          cropX: true,
          cropY: true,
          cropWidth: true,
          cropHeight: true,
          confidence: true,
          detectedLabel: true,
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!catalog) notFound();

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-8 p-6">
      {catalog.status === "PROCESSING" && <AutoRefresh intervalMs={5000} />}

      {/* Breadcrumb + title */}
      <div className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">
          <Link href="/fornecedores" className="hover:underline">Fornecedores</Link>
          {" / "}
          <Link href={`/fornecedores/${catalog.supplier.id}`} className="hover:underline">
            {catalog.supplier.name}
          </Link>
          {" / "}
          {catalog.fileName}
        </p>
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-semibold">{catalog.fileName}</h1>
          <Badge variant={statusVariant[catalog.status]}>
            {statusLabel[catalog.status]}
          </Badge>
          <div className="ml-auto">
            <DeleteCatalogButton
              catalogId={catalogId}
              redirectTo={`/fornecedores/${catalog.supplier.id}`}
            />
          </div>
        </div>
      </div>

      {catalog.error && (
        <p className="rounded bg-destructive/10 p-3 text-sm text-destructive">
          Erro: {catalog.error}
        </p>
      )}

      {/* Stats */}
      <div className="flex flex-wrap gap-6 text-sm text-muted-foreground">
        <span>
          Fornecedor:{" "}
          <strong className="text-foreground">{catalog.supplier.name}</strong>
        </span>
        {catalog.pageCount != null && (
          <span>
            Páginas:{" "}
            <strong className="text-foreground">{catalog.pageCount}</strong>
          </span>
        )}
        {catalog.candidateCount != null && (
          <span>
            Candidatos indexados:{" "}
            <strong className="text-foreground">{catalog.candidateCount}</strong>
          </span>
        )}
      </div>

      {catalog.status === "PROCESSING" && (
        <p className="text-muted-foreground">Processando catálogo, aguarde...</p>
      )}

      {catalog.status === "READY" && (
        <>
          {/* Pages section */}
          {catalog.pages.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="text-xl font-semibold">
                Páginas renderizadas ({catalog.pages.length})
              </h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {catalog.pages.map((page) => (
                  <a
                    key={page.id}
                    href={page.imageUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group relative overflow-hidden rounded-md border bg-muted transition-opacity hover:opacity-90"
                  >
                    <div className="relative aspect-[3/4]">
                      <Image
                        src={page.imageUrl}
                        alt={`Página ${page.pageNumber}`}
                        fill
                        className="object-contain p-1"
                        sizes="(max-width: 640px) 50vw, 20vw"
                      />
                    </div>
                    <p className="border-t px-2 py-1 text-center text-xs text-muted-foreground">
                      Pág. {page.pageNumber}
                    </p>
                  </a>
                ))}
              </div>
            </section>
          )}

          {/* Candidates section */}
          <section className="flex flex-col gap-3">
            <h2 className="text-xl font-semibold">
              Candidatos extraídos ({catalog.candidates.length})
            </h2>
            {catalog.candidates.length === 0 ? (
              <p className="py-8 text-center text-muted-foreground">
                Nenhum candidato detectado.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {catalog.candidates.map((c) => (
                  <div
                    key={c.id}
                    className="overflow-hidden rounded-lg border bg-card"
                  >
                    <a
                      href={c.cropUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block"
                    >
                      <div className="relative aspect-square bg-muted">
                        <Image
                          src={c.cropUrl}
                          alt="Candidato de produto"
                          fill
                          className="object-contain p-1"
                          sizes="(max-width: 640px) 50vw, 20vw"
                        />
                      </div>
                    </a>
                    <div className="border-t p-2 flex flex-col gap-0.5 text-xs text-muted-foreground">
                      {c.detectedLabel && (
                        <p className="font-medium text-foreground">{c.detectedLabel}</p>
                      )}
                      <p>{c.width}×{c.height}px</p>
                      {c.confidence != null && (
                        <p>Confiança: {Math.round(c.confidence * 100)}%</p>
                      )}
                      <p className="capitalize">{c.sourceType.toLowerCase().replace("_", " ")}</p>
                      {c.cropX != null && (
                        <p className="text-xs opacity-60">
                          crop ({c.cropX},{c.cropY}) {c.cropWidth}×{c.cropHeight}
                        </p>
                      )}
                      <a
                        href={c.originalUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline-offset-2 hover:underline"
                      >
                        Ver página original
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
