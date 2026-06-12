import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { cn } from "@/lib/utils";
import { SiteHeader } from "@/components/site-header";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
});

export const metadata: Metadata = {
  title: "Buscador Inteligente",
  description:
    "Sistema interno para encontrar produtos nos catálogos em PDF dos fornecedores.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR" className={cn("h-full antialiased", inter.variable)}>
      <body className="bg-background text-foreground min-h-full">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-zinc-900 focus:px-3 focus:py-1.5 focus:text-sm focus:font-medium focus:text-white"
        >
          Ir para o conteúdo
        </a>
        <SiteHeader />
        <div id="main-content">{children}</div>
      </body>
    </html>
  );
}
