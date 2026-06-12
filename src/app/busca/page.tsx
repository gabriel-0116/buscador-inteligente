"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { Search, SearchX, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ImageUpload } from "@/components/image-upload";
import {
  PageSearchResults,
  type PageSearchResult,
  type ImageQueryProfileLite,
} from "@/components/page-search-results";

type ApiResponse = {
  profile: ImageQueryProfileLite;
  results: PageSearchResult[];
};

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

  function handleClear() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setSelectedFile(null);
    setPreviewUrl(null);
    setResponse(null);
    setError(null);
  }

  // Cmd+V / Ctrl+V paste support — grab the first image in the clipboard
  // and feed it through the same selection path as the dropzone.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (loading) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            handleImageSelect(file);
            e.preventDefault();
            return;
          }
        }
      }
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

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

  const resultCount = response?.results.length ?? 0;
  const hasSearched = response !== null;
  const noResults = hasSearched && resultCount === 0;

  return (
    <main className="mx-auto flex max-w-screen-xl flex-col gap-8 px-4 py-10 md:px-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Busca por imagem
        </h1>
        <p className="text-sm text-muted-foreground">
          Arraste uma imagem ou cole um screenshot pra encontrar o produto no
          catálogo.
        </p>
      </header>

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
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={handleSearch} disabled={loading}>
                  {loading ? "Buscando..." : "Buscar"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleClear}
                  disabled={loading}
                  aria-label="Limpar busca"
                >
                  <X className="mr-1 h-4 w-4" aria-hidden="true" />
                  Limpar
                </Button>
              </div>
            </div>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      <section
        aria-label="Resultados"
        aria-busy={loading}
        className="flex flex-col gap-4"
      >
        {hasSearched && resultCount > 0 && (
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold tracking-tight">
              {resultCount} resultado{resultCount !== 1 ? "s" : ""} encontrado
              {resultCount !== 1 ? "s" : ""}
            </h2>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleClear}
              aria-label="Nova busca"
            >
              Nova busca
            </Button>
          </div>
        )}

        {response && resultCount > 0 && (
          <PageSearchResults
            results={response.results}
            profile={response.profile ?? null}
          />
        )}

        {!hasSearched && !previewUrl && (
          <EmptyState
            icon={Search}
            title="Nenhuma busca ainda"
            description="Solte uma imagem acima ou cole um screenshot com Cmd+V."
          />
        )}

        {noResults && (
          <EmptyState
            icon={SearchX}
            title="Nada encontrado"
            description="O produto buscado pode não estar nos catálogos indexados, ou estar fora do nosso vocabulário visual."
            action={
              <Button variant="outline" size="sm" onClick={handleClear}>
                Limpar e tentar outra
              </Button>
            }
          />
        )}
      </section>
    </main>
  );
}

function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: typeof Search;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-zinc-200 px-6 py-12 text-center dark:border-zinc-800">
      <Icon
        className="h-8 w-8 text-zinc-300 dark:text-zinc-700"
        aria-hidden="true"
      />
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          {title}
        </p>
        <p className="max-w-md text-sm text-zinc-500 dark:text-zinc-400">
          {description}
        </p>
      </div>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
