export const dynamic = "force-dynamic";

import Link from "next/link";
import { Search, Upload } from "lucide-react";
import { prisma } from "@/lib/prisma";

type StatTone = "neutral" | "warning";

function StatCard({
  label,
  value,
  hint,
  tone = "neutral",
  href,
}: {
  label: string;
  value: number;
  hint?: string;
  tone?: StatTone;
  href?: string;
}) {
  const valueColor =
    tone === "warning" && value > 0
      ? "text-amber-700 dark:text-amber-400"
      : "text-zinc-900 dark:text-zinc-100";

  const ariaLabel = hint ? `${label}: ${value}, ${hint}` : `${label}: ${value}`;

  const inner = (
    <div
      className="flex flex-col gap-1 rounded-xl border border-zinc-200 bg-zinc-50/40 p-4 dark:border-zinc-800 dark:bg-zinc-900/40"
      aria-label={ariaLabel}
    >
      <p className="text-[10px] font-medium tracking-wider text-zinc-500 uppercase dark:text-zinc-400">
        {label}
      </p>
      <p
        className={`text-3xl font-semibold tracking-tight tabular-nums ${valueColor}`}
      >
        {value}
      </p>
      {hint && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{hint}</p>
      )}
    </div>
  );

  if (href) {
    return (
      <Link
        href={href}
        className="rounded-xl transition-colors hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:hover:bg-zinc-900"
      >
        {inner}
      </Link>
    );
  }
  return inner;
}

function ShortcutCard({
  href,
  icon: Icon,
  title,
  description,
}: {
  href: string;
  icon: typeof Search;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col gap-3 rounded-xl border border-zinc-200 p-6 transition-colors hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:border-zinc-800 dark:hover:bg-zinc-900"
    >
      <Icon
        className="h-5 w-5 text-zinc-500 dark:text-zinc-400"
        aria-hidden="true"
      />
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          {title}
        </h3>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {description}
        </p>
      </div>
    </Link>
  );
}

export default async function HomePage() {
  const [catalogCount, supplierCount, mentionCount, needsAttentionCount] =
    await Promise.all([
      prisma.catalog.count({ where: { status: "READY" } }),
      prisma.supplier.count(),
      prisma.pageProductMention.count(),
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
    <main className="mx-auto flex max-w-screen-xl flex-col gap-10 px-4 py-10 md:px-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Buscador</h1>
        <p className="text-sm text-muted-foreground">
          Catalogue catálogos PDF de fornecedores chineses e encontre produtos
          por imagem.
        </p>
      </header>

      <section aria-labelledby="stats-heading" className="flex flex-col gap-3">
        <h2 id="stats-heading" className="sr-only">
          Estatísticas
        </h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Catálogos prontos" value={catalogCount} />
          <StatCard label="Fornecedores" value={supplierCount} />
          <StatCard label="Produtos detectados" value={mentionCount} />
          <StatCard
            label="Catálogos com aviso"
            value={needsAttentionCount}
            tone="warning"
            href="/fornecedores"
          />
        </div>
      </section>

      <section
        aria-labelledby="shortcuts-heading"
        className="flex flex-col gap-3"
      >
        <h2
          id="shortcuts-heading"
          className="text-[10px] font-medium tracking-wider text-zinc-500 uppercase dark:text-zinc-400"
        >
          Atalhos
        </h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <ShortcutCard
            href="/busca"
            icon={Search}
            title="Buscar produto por imagem"
            description="Cole ou solte uma foto e veja em quais páginas dos catálogos o produto aparece."
          />
          <ShortcutCard
            href="/fornecedores"
            icon={Upload}
            title="Adicionar novo catálogo"
            description="Suba um PDF de fornecedor. O sistema lê, indexa e fica pronto pra busca."
          />
        </div>
      </section>
    </main>
  );
}
