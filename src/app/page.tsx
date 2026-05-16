import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function HomePage() {
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-3xl font-semibold">Buscador Inteligente</h1>
        <p className="text-muted-foreground mt-2">
          Sistema interno para encontrar produtos nos catálogos em PDF dos
          fornecedores.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>1. Fornecedores</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-muted-foreground text-sm">
              Cadastre os fornecedores antes de subir qualquer catálogo.
            </p>
            <Button asChild>
              <Link href="/fornecedores">Abrir fornecedores</Link>
            </Button>
          </CardContent>
        </Card>

        <Card className="opacity-60">
          <CardHeader>
            <CardTitle>2. Catálogos em PDF</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-sm">
              Próxima fase: upload de PDF vinculado ao fornecedor.
            </p>
          </CardContent>
        </Card>

        <Card className="opacity-60">
          <CardHeader>
            <CardTitle>3. Produtos brutos</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-sm">
              Depois: extrair páginas, identificar produtos e revisar no painel.
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
