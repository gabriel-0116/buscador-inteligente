export const dynamic = "force-dynamic";

import Link from "next/link";
import { Building2 } from "lucide-react";
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
    <main className="mx-auto flex max-w-screen-xl flex-col gap-6 px-4 py-10 md:px-6">
      <header className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Fornecedores</h1>
          <p className="text-sm text-muted-foreground">
            Cadastre fornecedores e suba catálogos PDF para indexação.
          </p>
        </div>
        <CreateSupplierDialog />
      </header>

      {suppliers.length === 0 ? (
        <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-zinc-200 px-6 py-16 text-center dark:border-zinc-800">
          <Building2
            className="h-8 w-8 text-zinc-300 dark:text-zinc-700"
            aria-hidden="true"
          />
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
              Nenhum fornecedor ainda
            </p>
            <p className="max-w-md text-sm text-zinc-500 dark:text-zinc-400">
              Cadastre o primeiro fornecedor pra começar a indexar catálogos.
            </p>
          </div>
          <CreateSupplierDialog triggerLabel="Adicionar primeiro fornecedor" />
        </div>
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
                    className="font-medium hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
                  >
                    {s.name}
                  </Link>
                </TableCell>
                <TableCell className="text-right tabular-nums">
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
