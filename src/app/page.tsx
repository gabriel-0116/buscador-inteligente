export const dynamic = "force-dynamic";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { prisma } from "@/lib/prisma";

export default async function HomePage() {
  const [
    supplierCount,
    catalogCount,
    pageCount,
    mentionCount,
    needsAttentionCount,
  ] = await Promise.all([
    prisma.supplier.count(),
    prisma.catalog.count({ where: { status: "READY" } }),
    prisma.catalogPage.count(),
    prisma.pageProductMention.count(),
    // Quick proxy for "yellow + red" without computing health per catalog:
    // FAILED catalogs are unambiguously red; READY catalogs with a non-null
    // `error` are the ones process-catalog flagged with the "Processado com
    // avisos" warning.
    prisma.catalog.count({
      where: {
        OR: [
          { status: "FAILED" },
          { AND: [{ status: "READY" }, { error: { not: null } }] },
        ],
      },
    }),
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

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <div className="rounded-lg border p-4">
          <p className="text-2xl font-bold">{supplierCount}</p>
          <p className="text-sm text-muted-foreground">Fornecedores</p>
        </div>
        <div className="rounded-lg border p-4">
          <p className="text-2xl font-bold">{catalogCount}</p>
          <p className="text-sm text-muted-foreground">Catálogos prontos</p>
        </div>
        <div className="rounded-lg border p-4">
          <p className="text-2xl font-bold">{pageCount}</p>
          <p className="text-sm text-muted-foreground">Páginas processadas</p>
        </div>
        <div className="rounded-lg border p-4">
          <p className="text-2xl font-bold">{mentionCount}</p>
          <p className="text-sm text-muted-foreground">Produtos detectados</p>
        </div>
        <Link
          href="/fornecedores"
          className={`rounded-lg border p-4 transition-colors ${
            needsAttentionCount > 0
              ? "border-amber-200 bg-amber-50 hover:bg-amber-100"
              : "hover:bg-muted/40"
          }`}
        >
          <p
            className={`text-2xl font-bold ${
              needsAttentionCount > 0 ? "text-amber-700" : ""
            }`}
          >
            {needsAttentionCount}
          </p>
          <p className="text-sm text-muted-foreground">
            Catálogos com aviso
          </p>
        </Link>
      </div>
    </main>
  );
}
