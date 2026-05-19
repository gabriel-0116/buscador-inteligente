export const dynamic = "force-dynamic";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { prisma } from "@/lib/prisma";

export default async function HomePage() {
  const [supplierCount, catalogCount, imageCount] = await Promise.all([
    prisma.supplier.count(),
    prisma.catalog.count({ where: { status: "READY" } }),
    prisma.productImage.count(),
  ]);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 p-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold">Buscador de Catálogos</h1>
        <p className="text-muted-foreground">
          Sistema de busca visual nos catálogos dos fornecedores.
        </p>
      </div>

      <div className="flex gap-3">
        <Button asChild>
          <Link href="/busca">Buscar produto</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href="/fornecedores">Fornecedores</Link>
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-lg border p-4">
          <p className="text-2xl font-bold">{supplierCount}</p>
          <p className="text-sm text-muted-foreground">Fornecedores</p>
        </div>
        <div className="rounded-lg border p-4">
          <p className="text-2xl font-bold">{catalogCount}</p>
          <p className="text-sm text-muted-foreground">Catálogos prontos</p>
        </div>
        <div className="rounded-lg border p-4">
          <p className="text-2xl font-bold">{imageCount}</p>
          <p className="text-sm text-muted-foreground">Imagens indexadas</p>
        </div>
      </div>
    </main>
  );
}
