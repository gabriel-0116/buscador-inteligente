import Link from "next/link";
import { Button } from "../components/ui/button";

export default function HomePage() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-3xl font-semibold">Buscador de Catálogos</h1>
      <p className="text-muted-foreground">
        Sistema de busca visual nos catálogos dos fornecedores.
      </p>
      <div className="flex gap-3">
        <Button asChild>
          <Link href="/busca">Buscar produto</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href="/fornecedores">Fornecedores</Link>
        </Button>
      </div>
    </main>
  );
}
