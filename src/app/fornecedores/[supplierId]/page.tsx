import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AutoRefresh } from "@/components/auto-refresh";
import { CatalogUpload } from "./catalog-upload";

type Props = { params: Promise<{ supplierId: string }> };

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

export default async function SupplierPage({ params }: Props) {
  const { supplierId } = await params;

  const supplier = await prisma.supplier.findUnique({
    where: { id: supplierId },
    include: { catalogs: { orderBy: { createdAt: "desc" } } },
  });

  if (!supplier) notFound();

  const hasProcessing = supplier.catalogs.some(
    (c) => c.status === "PROCESSING"
  );

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
      {hasProcessing && <AutoRefresh intervalMs={5000} />}

      <div className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">
          <Link href="/fornecedores" className="hover:underline">
            Fornecedores
          </Link>{" "}
          / {supplier.name}
        </p>
        <h1 className="text-3xl font-semibold">{supplier.name}</h1>
      </div>

      <CatalogUpload supplierId={supplierId} />

      {supplier.catalogs.length === 0 ? (
        <p className="text-muted-foreground">Nenhum catálogo enviado.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <h2 className="text-lg font-medium">Catálogos</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Arquivo</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Imagens</TableHead>
                <TableHead>Enviado em</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {supplier.catalogs.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>
                    {c.status === "READY" ? (
                      <Link
                        href={`/catalogos/${c.id}`}
                        className="font-medium hover:underline"
                      >
                        {c.fileName}
                      </Link>
                    ) : (
                      <span className="font-medium">{c.fileName}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant[c.status]}>
                      {statusLabel[c.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {c.imageCount ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(c.createdAt).toLocaleDateString("pt-BR")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </main>
  );
}
