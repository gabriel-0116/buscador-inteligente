import Image from "next/image";
import Link from "next/link";
import { searchSupplierOffers } from "@/features/search/queries";
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
  }>;
};

function formatConfidence(confidence: number | null) {
  if (confidence === null) {
    return "-";
  }

  return `${Math.round(confidence * 100)}%`;
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const { q } = await searchParams;
  const query = q?.trim() ?? "";
  const results = await searchSupplierOffers(query);

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
          <form action="/busca" className="flex flex-col gap-3 md:flex-row">
            <Input
              name="q"
              defaultValue={query}
              placeholder="Ex: câmera infantil, antena de TV, DQ-226"
              className="md:max-w-xl"
            />

            <Button type="submit">Buscar</Button>
          </form>
        </CardContent>
      </Card>

      {query ? (
        <div className="text-muted-foreground text-sm">
          {results.length} resultado(s) para{" "}
          <span className="text-foreground font-medium">“{query}”</span>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Resultados</CardTitle>
        </CardHeader>

        <CardContent>
          {!query ? (
            <div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm">
              Digite um termo para buscar nas ofertas aprovadas.
            </div>
          ) : results.length === 0 ? (
            <div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm">
              Nenhuma oferta encontrada. Verifique se os produtos foram
              aprovados e se as ofertas foram criadas.
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
