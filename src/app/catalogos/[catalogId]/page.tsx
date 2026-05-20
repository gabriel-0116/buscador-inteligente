import { notFound } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/ui/badge";
import { AutoRefresh } from "@/components/auto-refresh";
import { DeleteCatalogButton } from "@/components/delete-catalog-button";
import { ReprocessCatalogButton } from "@/components/reprocess-catalog-button";

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

const rejectLabel: Record<string, string> = {
  too_small: "muito pequeno",
  too_large: "muito grande",
  too_horizontal: "muito horizontal",
  too_vertical: "muito vertical",
  mostly_white: "quase branco",
  green_bar: "faixa verde",
  green_dominant: "verde dominante",
  orange_bar: "faixa laranja",
  color_bar: "faixa colorida",
  horizontal_bar: "barra horizontal",
  vertical_column: "coluna vertical",
  header_footer: "cabeçalho/rodapé",
  empty_cell: "célula vazia",
  insufficient_content: "sem conteúdo",
  card_too_large: "card inteiro",
  page_like_crop: "página inteira",
  text_like: "texto/tabela",
  no_central_object: "sem objeto central",
  low_quality: "baixa qualidade",
  invalid_box: "box inválido",
  invalid_json: "JSON inválido",
  duplicate: "duplicado",
  low_confidence: "confiança baixa",
  no_products_detected: "sem produtos detectados",
  fallback_used: "fallback heurístico",
};

const detectorLabel: Record<string, string> = {
  VISION_JSON: "vision JSON",
  HEURISTIC: "heurístico",
  FALLBACK: "fallback heurístico",
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
          cardUrl: true,
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
          qualityScore: true,
          isSearchable: true,
          rejectReason: true,
          detectedLabel: true,
          productName: true,
          productNamePt: true,
          category: true,
          functionGroup: true,
          model: true,
          descriptionPt: true,
          sourceDetector: true,
          visionConfidence: true,
        },
        orderBy: [{ isSearchable: "desc" }, { qualityScore: "desc" }],
      },
    },
  });

  if (!catalog) notFound();

  const searchableCount = catalog.candidates.filter((c) => c.isSearchable).length;
  const debugCount = catalog.candidates.length - searchableCount;

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
        <p className="rounded bg-destructive/10 p-3 text-sm text-destructive">
          Erro: {catalog.error}
        </p>
      )}

      {/* Stats */}
      <div className="flex flex-wrap gap-6 text-sm text-muted-foreground">
        <span>
          Fornecedor: <strong className="text-foreground">{catalog.supplier.name}</strong>
        </span>
        {catalog.pageCount != null && (
          <span>Páginas: <strong className="text-foreground">{catalog.pageCount}</strong></span>
        )}
        {catalog.candidateCount != null && (
          <span>
            Candidatos: <strong className="text-foreground">{catalog.candidateCount}</strong>
            {" · "}
            <span className="text-green-600 font-medium">{searchableCount} pesquisáveis</span>
            {debugCount > 0 && (
              <span className="text-muted-foreground"> · {debugCount} debug</span>
            )}
          </span>
        )}
        {!catalog.pdfStoragePath && catalog.status === "READY" && (
          <span className="text-amber-600 text-xs">
            ⚠ PDF original não salvo — reprocessamento requer reenvio do arquivo.
          </span>
        )}
      </div>

      {catalog.status === "PROCESSING" && (
        <p className="text-muted-foreground">Processando catálogo, aguarde...</p>
      )}

      {catalog.status === "READY" && (
        <>
          {/* Pages */}
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
                    className="overflow-hidden rounded-md border bg-muted transition-opacity hover:opacity-90"
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

          {/* Candidates */}
          {(() => {
            const searchable = catalog.candidates.filter((c) => c.isSearchable);
            const rejected = catalog.candidates.filter((c) => !c.isSearchable);

            const renderCard = (c: (typeof catalog.candidates)[number]) => {
              const displayName = c.productNamePt ?? c.productName ?? c.detectedLabel;
              return (
                <div
                  key={c.id}
                  className={`overflow-hidden rounded-lg border bg-card ${
                    c.isSearchable ? "border-green-500/40" : "opacity-70"
                  }`}
                >
                  <a href={c.cropUrl} target="_blank" rel="noopener noreferrer" className="block">
                    <div className="relative aspect-square bg-muted">
                      <Image
                        src={c.cropUrl}
                        alt={displayName ?? "Candidato"}
                        fill
                        className="object-contain p-1"
                        sizes="(max-width: 640px) 50vw, 20vw"
                      />
                    </div>
                  </a>
                  <div className="border-t p-2 flex flex-col gap-1 text-xs">
                    <div className="flex flex-wrap gap-1">
                      {c.isSearchable ? (
                        <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-700 font-medium">
                          Busca: SIM
                        </span>
                      ) : (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground font-medium">
                          Debug
                        </span>
                      )}
                      {c.sourceDetector && (
                        <span
                          className={`rounded px-1.5 py-0.5 font-medium ${
                            c.sourceDetector === "VISION_JSON"
                              ? "bg-blue-100 text-blue-700"
                              : "bg-amber-100 text-amber-700"
                          }`}
                          title={c.sourceDetector}
                        >
                          {detectorLabel[c.sourceDetector] ?? c.sourceDetector}
                        </span>
                      )}
                      {c.rejectReason && (
                        <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-destructive">
                          {rejectLabel[c.rejectReason] ?? c.rejectReason}
                        </span>
                      )}
                    </div>

                    {displayName && (
                      <p className="font-medium leading-tight" title={displayName}>
                        {displayName}
                      </p>
                    )}
                    {(c.category || c.functionGroup) && (
                      <p className="text-muted-foreground truncate">
                        {[c.category, c.functionGroup].filter(Boolean).join(" · ")}
                      </p>
                    )}
                    {c.model && (
                      <p className="text-muted-foreground truncate">Modelo: {c.model}</p>
                    )}
                    {c.descriptionPt && (
                      <p
                        className="line-clamp-2 text-muted-foreground"
                        title={c.descriptionPt}
                      >
                        {c.descriptionPt}
                      </p>
                    )}

                    <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-muted-foreground">
                      {c.qualityScore != null && (
                        <span>qual. {Math.round(c.qualityScore * 100)}%</span>
                      )}
                      {c.visionConfidence != null && (
                        <span>vision {Math.round(c.visionConfidence * 100)}%</span>
                      )}
                      {c.confidence != null && c.visionConfidence == null && (
                        <span>conf. {Math.round(c.confidence * 100)}%</span>
                      )}
                    </div>

                    <p className="text-muted-foreground">
                      {c.width}×{c.height}px
                    </p>
                    <p className="text-muted-foreground capitalize">
                      {c.sourceType.toLowerCase().replace("_", " ")}
                    </p>

                    <div className="flex flex-col gap-0.5 mt-0.5">
                      <a
                        href={c.originalUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline-offset-2 hover:underline text-muted-foreground"
                      >
                        Página original
                      </a>
                      {c.cardUrl && c.cardUrl !== c.cropUrl && (
                        <a
                          href={c.cardUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline-offset-2 hover:underline text-muted-foreground"
                        >
                          Card completo
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              );
            };

            if (catalog.candidates.length === 0) {
              return (
                <section className="flex flex-col gap-3">
                  <h2 className="text-xl font-semibold">Candidatos extraídos (0)</h2>
                  <p className="py-8 text-center text-muted-foreground">
                    Nenhum candidato detectado. Tente reprocessar.
                  </p>
                </section>
              );
            }

            return (
              <>
                <section className="flex flex-col gap-3">
                  <h2 className="text-xl font-semibold">
                    Pesquisáveis ({searchable.length})
                  </h2>
                  {searchable.length === 0 ? (
                    <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">
                      Nenhum candidato passou nos filtros de qualidade. Veja os
                      rejeitados abaixo para entender o motivo.
                    </p>
                  ) : (
                    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                      {searchable.map(renderCard)}
                    </div>
                  )}
                </section>

                {rejected.length > 0 && (
                  <section className="flex flex-col gap-3">
                    <h2 className="text-xl font-semibold">
                      Rejeitados / Debug ({rejected.length})
                    </h2>
                    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                      {rejected.map(renderCard)}
                    </div>
                  </section>
                )}
              </>
            );
          })()}
        </>
      )}
    </main>
  );
}
