import Link from "next/link";
import { notFound } from "next/navigation";
import { getSupplierById } from "@/features/suppliers/queries";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type NewCatalogPageProps = {
  params: Promise<{
    supplierId: string;
  }>;
};

export default async function NewCatalogPage({ params }: NewCatalogPageProps) {
  const { supplierId } = await params;

  const supplier = await getSupplierById(supplierId);

  if (!supplier) {
    notFound();
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <div>
        <Button variant="ghost" asChild className="mb-3 px-0">
          <Link href={`/fornecedores/${supplier.id}`}>
            ← Voltar para fornecedor
          </Link>
        </Button>

        <h1 className="text-2xl font-semibold">Enviar catálogo em PDF</h1>

        <p className="text-sm text-muted-foreground">
          Fornecedor: {supplier.name}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Arquivo do catálogo</CardTitle>
        </CardHeader>

        <CardContent>
          <form
            action="/api/catalogs"
            method="post"
            encType="multipart/form-data"
            className="flex flex-col gap-5"
          >
            <input type="hidden" name="supplierId" value={supplier.id} />

            <div className="grid gap-2">
              <Label htmlFor="file">PDF do catálogo</Label>
              <Input
                id="file"
                name="file"
                type="file"
                accept="application/pdf,.pdf"
                required
              />
              <p className="text-xs text-muted-foreground">
  Nesta fase, o sistema apenas salva o PDF e registra os metadados.
  Extração de páginas vem depois. Limite atual: 100 MB.
</p>
            </div>

            <div className="flex items-center gap-3">
              <Button type="submit">Salvar catálogo</Button>

              <Button variant="outline" asChild>
                <Link href={`/fornecedores/${supplier.id}`}>Cancelar</Link>
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}