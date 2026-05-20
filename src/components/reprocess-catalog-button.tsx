"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function ReprocessCatalogButton({
  catalogId,
  hasPdf,
}: {
  catalogId: string;
  hasPdf: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleReprocess() {
    if (!hasPdf) {
      alert(
        "PDF original não encontrado no storage.\nReenvie o arquivo PDF pelo fornecedor para reprocessar."
      );
      return;
    }

    if (
      !confirm(
        "Reprocessar este catálogo?\nTodos os candidatos atuais serão removidos e o sistema irá detectar novamente."
      )
    ) {
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`/api/catalogs/${catalogId}/reprocess`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Erro ao reprocessar");
      router.refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Erro ao reprocessar.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleReprocess}
      disabled={loading}
      title={hasPdf ? "Reprocessar catálogo com nova pipeline" : "PDF original não disponível"}
    >
      {loading ? "Reprocessando..." : "Reprocessar"}
    </Button>
  );
}
