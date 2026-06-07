import { notFound } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/ui/badge";
import { AutoRefresh } from "@/components/auto-refresh";
import { DeleteCatalogButton } from "@/components/delete-catalog-button";
import { ReprocessCatalogButton } from "@/components/reprocess-catalog-button";
import { CatalogHealthPanel } from "@/components/catalog-health-panel";
import { getCatalogHealth } from "@/server/services/catalog-health";

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
        select: {
          id: true,
          imageUrl: true,
          pageNumber: true,
          width: true,
          height: true,
        },
        orderBy: { pageNumber: "asc" },
      },
      productMentions: {
        select: {
          id: true,
          pageId: true,
          pageNumber: true,
          displayOrder: true,
          namePt: true,
          functionGroup: true,
          category: true,
          brand: true,
          modelCodes: true,
          aliases: true,
          colors: true,
          isKit: true,
          kitContains: true,
          confidence: true,
          evidenceText: true,
          evidenceSource: true,
        },
        // Visual order first (left→right, top→bottom). Legacy rows with
        // displayOrder = NULL fall to the bottom; confidence is the
        // tiebreaker for those.
        orderBy: [
          { pageNumber: "asc" },
          { displayOrder: "asc" },
          { confidence: "desc" },
        ],
      },
    },
  });

  if (!catalog) notFound();

  // Compute the health snapshot in parallel with the rest of the render
  // (Next.js will await before flushing, but the query runs alongside the
  // already-completed `catalog` fetch instead of serially). Skip while the
  // catalog is still PROCESSING — the panel needs final counts to mean
  // anything.
  const health =
    catalog.status === "READY"
      ? await getCatalogHealth(catalogId)
      : null;

  const mentionsCount = catalog.productMentions.length;
  const mentionsByPage = new Map<
    number,
    Array<(typeof catalog.productMentions)[number]>
  >();
  for (const m of catalog.productMentions) {
    const arr = mentionsByPage.get(m.pageNumber) ?? [];
    arr.push(m);
    mentionsByPage.set(m.pageNumber, arr);
  }

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-8 p-6">
      {catalog.status === "PROCESSING" && <AutoRefresh intervalMs={5000} />}

      {/* Breadcrumb + title */}
      <div className="flex flex-col gap-1">
        <p className="text-muted-foreground text-sm">
          <Link href="/fornecedores" className="hover:underline">
            Fornecedores
          </Link>
          {" / "}
          <Link
            href={`/fornecedores/${catalog.supplier.id}`}
            className="hover:underline"
          >
            {catalog.supplier.name}
          </Link>
          {" / "}
          {catalog.fileName}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-semibold">{catalog.fileName}</h1>
          <Badge variant={statusVariant[catalog.status]}>
            {statusLabel[catalog.status]}
          </Badge>
          <div className="ml-auto flex gap-2">
            {catalog.status === "READY" && (
              <ReprocessCatalogButton
                catalogId={catalogId}
                hasPdf={!!catalog.pdfStoragePath}
              />
            )}
            <DeleteCatalogButton
              catalogId={catalogId}
              redirectTo={`/fornecedores/${catalog.supplier.id}`}
            />
          </div>
        </div>
      </div>

      {catalog.error && (
        <p className="bg-destructive/10 text-destructive rounded p-3 text-sm">
          Erro: {catalog.error}
        </p>
      )}

      {/* Stats */}
      <div className="text-muted-foreground flex flex-wrap gap-6 text-sm">
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
        {mentionsCount > 0 && (
          <span>
            Produtos detectados:{" "}
            <strong className="text-foreground">{mentionsCount}</strong>
          </span>
        )}
        {!catalog.pdfStoragePath && catalog.status === "READY" && (
          <span className="text-xs text-amber-600">
            ⚠ PDF original não salvo — reprocessamento requer reenvio do
            arquivo.
          </span>
        )}
      </div>

      {catalog.status === "PROCESSING" && (
        <p className="text-muted-foreground">
          Processando catálogo, aguarde...
        </p>
      )}

      {catalog.status === "READY" && health && (
        <CatalogHealthPanel health={health} />
      )}

      {catalog.status === "READY" && catalog.pages.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-xl font-semibold">
            Páginas renderizadas ({catalog.pages.length})
            {mentionsCount > 0 && (
              <span className="text-muted-foreground ml-2 text-sm font-normal">
                · {mentionsCount} produtos detectados
              </span>
            )}
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {catalog.pages.map((page) => {
              const mentions = mentionsByPage.get(page.pageNumber) ?? [];
              return (
                <div
                  key={page.id}
                  className="overflow-hidden rounded-md border bg-card"
                >
                  <a
                    href={page.imageUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="bg-muted block transition-opacity hover:opacity-90"
                  >
                    <div className="relative aspect-[3/4]">
                      <Image
                        src={page.imageUrl}
                        alt={`Página ${page.pageNumber}`}
                        fill
                        className="object-contain p-1"
                        sizes="(max-width: 640px) 100vw, 33vw"
                      />
                    </div>
                  </a>
                  <div className="border-t p-2">
                    <p className="text-muted-foreground text-xs">
                      Pág. {page.pageNumber}
                      {mentions.length > 0 && (
                        <span className="text-foreground ml-1 font-medium">
                          · {mentions.length} produto
                          {mentions.length !== 1 ? "s" : ""}
                        </span>
                      )}
                    </p>
                    {mentions.length > 0 && (
                      <ol className="mt-1 flex flex-col gap-1 text-xs">
                        {mentions.slice(0, 8).map((m, idx) => (
                          <li
                            key={m.id}
                            className="border-l-2 border-emerald-400 pl-2"
                          >
                            <p
                              className="font-medium leading-tight"
                              title={m.namePt}
                            >
                              <span className="text-muted-foreground mr-1 font-mono text-[11px]">
                                {idx + 1}.
                              </span>
                              {m.namePt}
                              {m.isKit && (
                                <span className="ml-1 rounded bg-indigo-100 px-1 text-[10px] text-indigo-700">
                                  kit
                                </span>
                              )}
                            </p>
                            {(m.brand || m.modelCodes.length > 0) && (
                              <p className="text-foreground/80 truncate pl-5 font-mono text-[11px]">
                                {[m.brand, m.modelCodes.join(", ")]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </p>
                            )}
                            {(m.functionGroup || m.category) && (
                              <p className="text-muted-foreground truncate pl-5">
                                {[m.category, m.functionGroup]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </p>
                            )}
                            {m.colors.length > 0 && (
                              <p className="text-muted-foreground pl-5">
                                {m.colors.join(", ")}
                              </p>
                            )}
                          </li>
                        ))}
                        {mentions.length > 8 && (
                          <li className="text-muted-foreground italic">
                            +{mentions.length - 8} outros
                          </li>
                        )}
                      </ol>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </main>
  );
}
