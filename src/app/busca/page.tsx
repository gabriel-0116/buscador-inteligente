"use client";

import { useState } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { ImageUpload } from "@/components/image-upload";
import { SearchResults, type SearchResult } from "@/components/search-results";

export default function BuscaPage() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleImageSelect(file: File) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setSelectedFile(file);
    setPreviewUrl(URL.createObjectURL(file));
    setResults(null);
    setError(null);
  }

  async function handleSearch() {
    if (!selectedFile) return;

    setLoading(true);
    setError(null);

    try {
      const body = new FormData();
      body.append("image", selectedFile);

      const res = await fetch("/api/search", { method: "POST", body });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error ?? "Erro na busca");

      setResults(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro na busca");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 p-6">
      <h1 className="text-3xl font-semibold">Buscar Produto</h1>

      <div className="flex flex-col gap-4">
        <ImageUpload onImageSelect={handleImageSelect} disabled={loading} />

        {previewUrl && (
          <div className="flex items-start gap-6">
            <div className="relative h-48 w-48 flex-shrink-0 overflow-hidden rounded-lg border bg-muted">
              <Image
                src={previewUrl}
                alt="Imagem selecionada"
                fill
                className="object-contain"
              />
            </div>
            <div className="flex flex-col gap-3 pt-1">
              <p className="text-sm text-muted-foreground">{selectedFile?.name}</p>
              <Button onClick={handleSearch} disabled={loading}>
                {loading ? "Buscando..." : "Buscar"}
              </Button>
            </div>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      {results !== null && (
        <div className="flex flex-col gap-4">
          <h2 className="text-xl font-medium">
            {results.length} resultado{results.length !== 1 ? "s" : ""} encontrado{results.length !== 1 ? "s" : ""}
          </h2>
          <SearchResults results={results} />
        </div>
      )}
    </main>
  );
}
