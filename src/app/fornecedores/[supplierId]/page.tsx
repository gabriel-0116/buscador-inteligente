import Link from "next/link";
import { notFound } from "next/navigation";
import { getSupplierById } from "@/features/suppliers/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type SupplierPageProps = {
  params: Promise<{
    supplierId: string;
  }>;
};

function formatBytes(bytes: number | null) {
  if (!bytes) return "-";

  const mb = bytes / 1024 / 1024;

  return `${mb.toFixed(2)} MB`;
}

function formatStatus(status: string) {
  const labels: Record<string, string> = {
    DRAFT: "Rascunho",
    PROCESSING: "Processando",
    READY_FOR_REVIEW: "Pronto para revisão",
    REVIEWED: "Revisado",
    FAILED: "Falhou",
  };

  return labels[status] ?? status;
}

export default async function SupplierPage({ params }: SupplierPageProps) {
  const { supplierId } = await params;

  const supplier = await getSupplierById(supplierId);

  if (!supplier) {
    notFound();
  }

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Button variant="ghost" asChild className="mb-3 px-0">
            <Link href="/fornecedores">← Voltar para fornecedores</Link>
          </Button>

          <h1 className="text-2xl font-semibold">{supplier.name}</h1>

          {supplier.notes ? (
            <p className="text-muted-foreground mt-1 text-sm">
              {supplier.notes}
            </p>
          ) : (
            <p className="text-muted-foreground mt-1 text-sm">
              Sem observações cadastradas.
            </p>
          )}
        </div>

        <Button asChild>
          <Link href={`/fornecedores/${supplier.id}/catalogos/novo`}>
            Enviar PDF
          </Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Catálogos em PDF</CardTitle>
        </CardHeader>

        <CardContent>
          {supplier.catalogs.length === 0 ? (
            <div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm">
              Nenhum catálogo enviado para este fornecedor ainda.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Arquivo</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Tamanho</TableHead>
                  <TableHead>Páginas</TableHead>
                  <TableHead>Enviado em</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {supplier.catalogs.map((catalog) => (
                  <TableRow key={catalog.id}>
                    <TableCell className="font-medium">
                      <Link
                        href={`/catalogos/${catalog.id}`}
                        className="underline-offset-4 hover:underline"
                      >
                        {catalog.fileName}
                      </Link>
                    </TableCell>

                    <TableCell>
                      <Badge variant="secondary">
                        {formatStatus(catalog.status)}
                      </Badge>
                    </TableCell>

                    <TableCell>{formatBytes(catalog.fileSize)}</TableCell>

                    <TableCell>{catalog.pageCount ?? "-"}</TableCell>

                    <TableCell>
                      {new Intl.DateTimeFormat("pt-BR").format(
                        catalog.createdAt
                      )}
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
