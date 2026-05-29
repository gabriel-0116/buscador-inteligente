"use client";

import { useState } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { ImageUpload } from "@/components/image-upload";
import { SearchResults, type SearchResult } from "@/components/search-results";
import {
  PageSearchResults,
  type PageSearchResult,
  type ImageQueryProfileLite,
} from "@/components/page-search-results";

type ApiResponse =
  | {
      mode: "page_mentions";
      profile: ImageQueryProfileLite;
      results: PageSearchResult[];
    }
  | {
      mode: "legacy_candidates";
      results: SearchResult[];
    }
  // Tolerate the bare-array shape from old callers, just in case.
  | SearchResult[];

export default function BuscaPage() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [response, setResponse] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleImageSelect(file: File) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setSelectedFile(file);
    setPreviewUrl(URL.createObjectURL(file));
    setResponse(null);
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
      const data = (await res.json()) as ApiResponse | { error?: string };

      if (!res.ok) {
        throw new Error(
          (data as { error?: string }).error ?? "Erro na busca"
        );
      }
      setResponse(data as ApiResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro na busca");
    } finally {
      setLoading(false);
    }
  }

  const view = (() => {
    if (!response) return null;
    if (Array.isArray(response)) {
      return { kind: "legacy" as const, results: response };
    }
    if (response.mode === "page_mentions") {
      return {
        kind: "pages" as const,
        results: response.results,
        profile: response.profile,
      };
    }
    return { kind: "legacy" as const, results: response.results };
  })();

  const resultCount = view ? view.results.length : 0;

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-8 p-6">
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
              <p className="text-sm text-muted-foreground">
                {selectedFile?.name}
              </p>
              <Button onClick={handleSearch} disabled={loading}>
                {loading ? "Buscando..." : "Buscar"}
              </Button>
            </div>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      {view && (
        <div className="flex flex-col gap-4">
          <h2 className="text-xl font-medium">
            {resultCount} resultado{resultCount !== 1 ? "s" : ""} encontrado
            {resultCount !== 1 ? "s" : ""}
          </h2>
          {view.kind === "pages" ? (
            <PageSearchResults
              results={view.results}
              profile={view.profile ?? null}
            />
          ) : (
            <SearchResults results={view.results} />
          )}
        </div>
      )}
    </main>
  );
}
