import Image from "next/image";
import Link from "next/link";
import {
  getSearchFilters,
  searchSupplierOffers,
} from "@/features/search/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type SearchPageProps = {
  searchParams: Promise<{
    q?: string;
    supplierId?: string;
    category?: string;
  }>;
};

function formatConfidence(confidence: number | null) {
  if (confidence === null) {
    return "-";
  }

  return `${Math.round(confidence * 100)}%`;
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const { q, supplierId, category } = await searchParams;

  const query = q?.trim() ?? "";
  const selectedSupplierId = supplierId?.trim() ?? "";
  const selectedCategory = category?.trim() ?? "";

  const filters = await getSearchFilters();

  const results = await searchSupplierOffers({
    query,
    supplierId: selectedSupplierId || undefined,
    category: selectedCategory || undefined,
  });

  const hasSearch = Boolean(query || selectedSupplierId || selectedCategory);

  return (
    <main className="mx-auto flex max-w-7xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Busca textual</h1>

        <p className="text-muted-foreground mt-1 text-sm">
          Pesquise produtos já aprovados e transformados em ofertas de
          fornecedores.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Pesquisar produto</CardTitle>
        </CardHeader>

        <CardContent>
          <form
            action="/busca"
            className="grid gap-3 md:grid-cols-[1fr_220px_220px_auto_auto]"
          >
            <Input
              name="q"
              defaultValue={query}
              placeholder="Ex: câmera infantil, antena de TV, DQ-226"
            />

            <select
              name="supplierId"
              defaultValue={selectedSupplierId}
              className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex h-10 rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="">Todos fornecedores</option>

              {filters.suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </select>

            <select
              name="category"
              defaultValue={selectedCategory}
              className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex h-10 rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="">Todas categorias</option>

              {filters.categories.map((filterCategory) => (
                <option key={filterCategory} value={filterCategory}>
                  {filterCategory}
                </option>
              ))}
            </select>

            <Button type="submit">Buscar</Button>

            <Button type="button" variant="outline" asChild>
              <Link href="/busca">Limpar</Link>
            </Button>
          </form>
        </CardContent>
      </Card>

      {hasSearch ? (
        <div className="text-muted-foreground text-sm">
          {results.length} resultado(s)
          {query ? (
            <>
              {" "}
              para{" "}
              <span className="text-foreground font-medium">“{query}”</span>
            </>
          ) : null}
          {selectedCategory ? (
            <>
              {" "}
              na categoria{" "}
              <span className="text-foreground font-medium">
                “{selectedCategory}”
              </span>
            </>
          ) : null}
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Resultados</CardTitle>
        </CardHeader>

        <CardContent>
          {!hasSearch ? (
            <div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm">
              Digite um termo ou use os filtros para buscar nas ofertas
              aprovadas.
            </div>
          ) : results.length === 0 ? (
            <div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm">
              Nenhuma oferta encontrada. Verifique se os produtos foram
              aprovados, se as ofertas foram criadas ou se o filtro está muito
              restrito.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Imagem</TableHead>
                  <TableHead>Produto</TableHead>
                  <TableHead>Fornecedor</TableHead>
                  <TableHead>Código</TableHead>
                  <TableHead>Categoria</TableHead>
                  <TableHead>Referência</TableHead>
                  <TableHead>Confiança</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {results.map((offer) => (
                  <TableRow key={offer.id}>
                    <TableCell>
                      {offer.rawProduct?.imageUrl ? (
                        <Image
                          src={`/api/raw-products/${offer.rawProduct.id}/image`}
                          alt={
                            offer.supplierProductName ||
                            offer.canonicalProduct.namePt
                          }
                          width={120}
                          height={90}
                          unoptimized
                          className="rounded border object-contain"
                        />
                      ) : (
                        "-"
                      )}
                    </TableCell>

                    <TableCell className="font-medium">
                      <div className="flex flex-col gap-1">
                        <span>{offer.canonicalProduct.namePt}</span>

                        {offer.supplierProductName &&
                        offer.supplierProductName !==
                          offer.canonicalProduct.namePt ? (
                          <span className="text-muted-foreground text-xs">
                            Nome no fornecedor: {offer.supplierProductName}
                          </span>
                        ) : null}

                        {offer.rawProduct ? (
                          <Link
                            href={`/produtos-brutos/${offer.rawProduct.id}`}
                            className="text-xs underline-offset-4 hover:underline"
                          >
                            Ver produto bruto
                          </Link>
                        ) : null}
                      </div>
                    </TableCell>

                    <TableCell>{offer.supplier.name}</TableCell>

                    <TableCell>{offer.supplierCode || "-"}</TableCell>

                    <TableCell>
                      {offer.canonicalProduct.category || "-"}
                    </TableCell>

                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <span>{offer.catalogReference || "-"}</span>

                        {offer.catalog ? (
                          <Link
                            href={`/catalogos/${offer.catalog.id}`}
                            className="text-xs underline-offset-4 hover:underline"
                          >
                            Abrir catálogo
                          </Link>
                        ) : null}
                      </div>
                    </TableCell>

                    <TableCell>{formatConfidence(offer.confidence)}</TableCell>

                    <TableCell>
                      <Badge variant="secondary">Oferta criada</Badge>
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
