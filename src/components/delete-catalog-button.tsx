"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function DeleteCatalogButton({
  catalogId,
  redirectTo,
}: {
  catalogId: string;
  redirectTo?: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleDelete() {
    if (!confirm("Excluir este catálogo? Todos os dados e imagens serão removidos.")) return;

    setLoading(true);
    try {
      const res = await fetch(`/api/catalogs/${catalogId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Falha ao excluir");
      if (redirectTo) {
        router.push(redirectTo);
      } else {
        router.refresh();
      }
    } catch {
      alert("Erro ao excluir o catálogo.");
      setLoading(false);
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className="text-destructive hover:text-destructive hover:bg-destructive/10"
      onClick={handleDelete}
      disabled={loading}
    >
      {loading ? "Excluindo..." : "Excluir"}
    </Button>
  );
}
