import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { cn } from "@/lib/utils";

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
      <body className="min-h-full bg-background text-foreground">
        {children}
      </body>
    </html>
  );
}