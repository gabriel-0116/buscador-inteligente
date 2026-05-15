import Link from "next/link";
import { createSupplier } from "@/features/suppliers/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export default function NewSupplierPage() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Novo fornecedor</h1>
        <p className="text-sm text-muted-foreground">
          Comece cadastrando os fornecedores. Depois cada PDF será vinculado a
          um fornecedor.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Dados do fornecedor</CardTitle>
        </CardHeader>

        <CardContent>
          <form action={createSupplier} className="flex flex-col gap-5">
            <div className="grid gap-2">
              <Label htmlFor="name">Nome do fornecedor</Label>
              <Input
                id="name"
                name="name"
                placeholder="Ex: Fornecedor China 01"
                required
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="notes">Observações</Label>
              <Textarea
                id="notes"
                name="notes"
                placeholder="Informações internas sobre esse fornecedor"
              />
            </div>

            <div className="flex items-center gap-3">
              <Button type="submit">Salvar fornecedor</Button>

              <Button variant="outline" asChild>
                <Link href="/fornecedores">Cancelar</Link>
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
