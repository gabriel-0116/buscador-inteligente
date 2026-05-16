import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function HomePage() {
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-3xl font-semibold">Buscador Inteligente</h1>

        <p className="text-muted-foreground mt-2">
          Sistema interno para localizar produtos nos catálogos de fornecedores.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <Button asChild>
          <Link href="/busca">Buscar produtos</Link>
        </Button>

        <Button variant="outline" asChild>
          <Link href="/fornecedores">Fornecedores</Link>
        </Button>
      </div>
    </main>
  );
}
