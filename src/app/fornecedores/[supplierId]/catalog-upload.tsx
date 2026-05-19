"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Upload } from "lucide-react";

export function CatalogUpload({ supplierId }: { supplierId: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setError(null);

    try {
      const body = new FormData();
      body.append("supplierId", supplierId);
      body.append("file", file);

      const res = await fetch("/api/catalogs", { method: "POST", body });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error ?? "Erro ao enviar catálogo");

      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao enviar catálogo");
    } finally {
      setLoading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="outline"
        className="w-fit"
        disabled={loading}
        onClick={() => inputRef.current?.click()}
      >
        <Upload className="mr-2 h-4 w-4" />
        {loading ? "Enviando..." : "Enviar catálogo (PDF)"}
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf"
        className="hidden"
        onChange={handleChange}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
