"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Building2, Search } from "lucide-react";
import { cn } from "@/lib/utils";

type NavItem = {
  href: string;
  label: string;
  icon: typeof Home;
  match: (pathname: string) => boolean;
};

const navItems: NavItem[] = [
  {
    href: "/",
    label: "Início",
    icon: Home,
    match: (p) => p === "/",
  },
  {
    href: "/fornecedores",
    label: "Fornecedores",
    icon: Building2,
    match: (p) => p.startsWith("/fornecedores") || p.startsWith("/catalogos"),
  },
  {
    href: "/busca",
    label: "Busca",
    icon: Search,
    match: (p) => p.startsWith("/busca"),
  },
];

export function SiteHeader() {
  const pathname = usePathname() ?? "/";

  return (
    <header className="sticky top-0 z-40 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
      <div className="mx-auto flex h-14 max-w-screen-xl items-center justify-between px-4 md:px-6">
        <Link
          href="/"
          className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-50"
        >
          Buscador
        </Link>
        <nav aria-label="Navegação principal">
          <ul className="flex items-center gap-1 md:gap-1">
            {navItems.map((item) => {
              const active = item.match(pathname);
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    aria-label={item.label}
                    className={cn(
                      "inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500",
                      active
                        ? "font-medium text-zinc-900 dark:text-zinc-50"
                        : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
                    )}
                  >
                    <Icon className="h-4 w-4 md:hidden" aria-hidden="true" />
                    <span className="hidden md:inline">{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </header>
  );
}
