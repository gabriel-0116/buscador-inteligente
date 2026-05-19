export const dynamic = "force-dynamic";

import Link from "next/link";
import { prisma } from "@/lib/prisma";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CreateSupplierDialog } from "./create-supplier-dialog";

export default async function FornecedoresPage() {
  const suppliers = await prisma.supplier.findMany({
    include: { _count: { select: { catalogs: true } } },
    orderBy: { name: "asc" },
  });

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold">Fornecedores</h1>
        <CreateSupplierDialog />
      </div>

      {suppliers.length === 0 ? (
        <p className="text-muted-foreground">Nenhum fornecedor cadastrado.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nome</TableHead>
              <TableHead className="text-right">Catálogos</TableHead>
              <TableHead>Cadastrado em</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {suppliers.map((s) => (
              <TableRow key={s.id}>
                <TableCell>
                  <Link
                    href={`/fornecedores/${s.id}`}
                    className="font-medium hover:underline"
                  >
                    {s.name}
                  </Link>
                </TableCell>
                <TableCell className="text-right">
                  {s._count.catalogs}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {new Date(s.createdAt).toLocaleDateString("pt-BR")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </main>
  );
}
