import Link from "next/link";
import { getSuppliers } from "@/features/suppliers/queries";
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

export default async function SuppliersPage() {
  const suppliers = await getSuppliers();

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Fornecedores</h1>
          <p className="text-muted-foreground text-sm">
            Cadastre os fornecedores antes de subir os catálogos em PDF.
          </p>
        </div>

        <Button asChild>
          <Link href="/fornecedores/novo">Novo fornecedor</Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Lista de fornecedores</CardTitle>
        </CardHeader>

        <CardContent>
          {suppliers.length === 0 ? (
            <div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm">
              Nenhum fornecedor cadastrado ainda.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Observações</TableHead>
                  <TableHead>Criado em</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {suppliers.map((supplier) => (
                  <TableRow key={supplier.id}>
                    <TableCell className="font-medium">
                      <Link
                        href={`/fornecedores/${supplier.id}`}
                        className="underline-offset-4 hover:underline"
                      >
                        {supplier.name}
                      </Link>
                    </TableCell>
                    <TableCell>{supplier.notes || "-"}</TableCell>
                    <TableCell>
                      {new Intl.DateTimeFormat("pt-BR").format(
                        supplier.createdAt
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
