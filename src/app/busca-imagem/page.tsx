"use client";

import Image from "next/image";
import Link from "next/link";
import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type ImageSearchAnalysis = {
  productName: string | null;
  category: string | null;
  function: string | null;
  visibleCodes: string[];
  searchTerms: string[];
  confidence: number | null;
  notes: string | null;
};

type ImageSearchResultLevel = "STRONG" | "POSSIBLE";

type ImageSearchResult = {
  id: string;
  supplierProductName: string | null;
  supplierCode: string | null;
  catalogReference: string | null;
  confidence: number | null;
  visualSimilarity?: number;
  hybridScore?: number;
  resultLevel?: ImageSearchResultLevel;
  matchReason: string;
  supplier: {
    id: string;
    name: string;
  };
  canonicalProduct: {
    id: string;
    namePt: string;
    descriptionPt: string | null;
    category: string | null;
    function: string | null;
  };
  catalog: {
    id: string;
    fileName: string;
  } | null;
  rawProduct: {
    id: string;
    imageUrl: string | null;
    status: string;
  } | null;
};

type ImageSearchResponse = {
  analysis: ImageSearchAnalysis;
  searchTerms: string[];
  results: ImageSearchResult[];
};

function formatConfidence(confidence: number | null) {
  if (confidence === null) {
    return "-";
  }

  return `${Math.round(confidence * 100)}%`;
}

function formatSimilarity(similarity: number | undefined) {
  if (typeof similarity !== "number") {
    return "-";
  }

  return `${Math.round(similarity * 100)}%`;
}

function ResultCard({ result }: { result: ImageSearchResult }) {
  const isStrong = result.resultLevel === "STRONG";

  return (
    <div className="grid gap-4 rounded-lg border p-4 md:grid-cols-[150px_1fr]">
      <div className="bg-muted relative h-32 overflow-hidden rounded border">
        {result.rawProduct?.imageUrl ? (
          <Image
            src={`/api/raw-products/${result.rawProduct.id}/image`}
            alt={result.supplierProductName || result.canonicalProduct.namePt}
            fill
            unoptimized
            className="object-contain"
          />
        ) : (
          <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
            Sem imagem
          </div>
        )}
      </div>

      <div className="grid gap-3">
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <h2 className="font-semibold">{result.canonicalProduct.namePt}</h2>

            {result.supplierProductName &&
            result.supplierProductName !== result.canonicalProduct.namePt ? (
              <p className="text-muted-foreground text-sm">
                Nome no fornecedor: {result.supplierProductName}
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2">
            <Badge variant={isStrong ? "secondary" : "outline"}>
              {isStrong ? "Resultado forte" : "Possível parecido"}
            </Badge>

            <Badge variant="outline">{result.matchReason}</Badge>
          </div>
        </div>

        <div className="grid gap-2 text-sm md:grid-cols-5">
          <div>
            <p className="text-muted-foreground text-xs">Fornecedor</p>
            <p>{result.supplier.name}</p>
          </div>

          <div>
            <p className="text-muted-foreground text-xs">Código</p>
            <p>{result.supplierCode || "-"}</p>
          </div>

          <div>
            <p className="text-muted-foreground text-xs">Categoria</p>
            <p>{result.canonicalProduct.category || "-"}</p>
          </div>

          <div>
            <p className="text-muted-foreground text-xs">Similaridade visual</p>
            <p>{formatSimilarity(result.visualSimilarity)}</p>
          </div>

          <div>
            <p className="text-muted-foreground text-xs">Confiança extração</p>
            <p>{formatConfidence(result.confidence)}</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-3 text-sm">
          {result.rawProduct ? (
            <Link
              href={`/produtos-brutos/${result.rawProduct.id}`}
              className="underline-offset-4 hover:underline"
            >
              Ver recorte do catálogo
            </Link>
          ) : null}

          {result.catalog ? (
            <Link
              href={`/catalogos/${result.catalog.id}`}
              className="underline-offset-4 hover:underline"
            >
              Abrir catálogo
            </Link>
          ) : null}

          <Link
            href={`/busca?q=${encodeURIComponent(
              result.supplierCode ||
                result.supplierProductName ||
                result.canonicalProduct.namePt
            )}`}
            className="underline-offset-4 hover:underline"
          >
            Ver na busca textual
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function ImageSearchPage() {
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [response, setResponse] = useState<ImageSearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  const strongResults = useMemo(() => {
    return (
      response?.results.filter((result) => result.resultLevel === "STRONG") ??
      []
    );
  }, [response]);

  const possibleResults = useMemo(() => {
    return (
      response?.results.filter((result) => result.resultLevel !== "STRONG") ??
      []
    );
  }, [response]);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  function handleImageChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;

    setResponse(null);
    setError(null);
    setImageFile(file);

    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }

    if (!file) {
      setPreviewUrl(null);
      return;
    }

    setPreviewUrl(URL.createObjectURL(file));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!imageFile) {
      setError("Selecione uma imagem antes de buscar.");
      return;
    }

    setIsSearching(true);
    setError(null);
    setResponse(null);

    const formData = new FormData();
    formData.append("image", imageFile);

    try {
      const result = await fetch("/api/visual-search", {
        method: "POST",
        body: formData,
      });

      const data = (await result.json()) as
        | ImageSearchResponse
        | { error?: string };

      if (!result.ok) {
        throw new Error(
          "error" in data && data.error
            ? data.error
            : "Erro ao buscar por imagem."
        );
      }

      setResponse(data as ImageSearchResponse);
    } catch (searchError) {
      setError(
        searchError instanceof Error
          ? searchError.message
          : "Erro ao buscar por imagem."
      );
    } finally {
      setIsSearching(false);
    }
  }

  return (
    <main className="mx-auto flex max-w-7xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Busca por imagem</h1>

          <p className="text-muted-foreground mt-1 text-sm">
            Envie uma foto ou print de produto para encontrar recortes
            visualmente parecidos nos catálogos dos fornecedores.
          </p>
        </div>

        <Button variant="outline" asChild>
          <Link href="/busca">Ir para busca textual</Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Imagem do produto</CardTitle>
        </CardHeader>

        <CardContent>
          <form onSubmit={handleSubmit} className="grid gap-4">
            <div className="grid gap-2">
              <Input
                type="file"
                name="image"
                accept="image/*"
                onChange={handleImageChange}
              />

              <p className="text-muted-foreground text-xs">
                Use uma imagem com o produto principal bem visível. Quanto mais
                limpo o recorte, melhor a comparação visual.
              </p>
            </div>

            {previewUrl ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">Imagem enviada</p>

                <div className="bg-muted relative h-72 w-full overflow-hidden rounded-lg border md:w-96">
                  <Image
                    src={previewUrl}
                    alt="Imagem enviada para busca"
                    fill
                    unoptimized
                    className="object-contain"
                  />
                </div>
              </div>
            ) : null}

            {error ? (
              <div className="border-destructive/40 bg-destructive/10 rounded-lg border p-3 text-sm">
                {error}
              </div>
            ) : null}

            <div>
              <Button type="submit" disabled={isSearching || !imageFile}>
                {isSearching ? "Buscando..." : "Buscar por similaridade visual"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {response ? (
        <Card>
          <CardHeader>
            <CardTitle>Sinais auxiliares da imagem</CardTitle>
          </CardHeader>

          <CardContent className="grid gap-4">
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-lg border p-3">
                <p className="text-muted-foreground text-xs">
                  Produto provável
                </p>
                <p className="font-medium">
                  {response.analysis.productName || "-"}
                </p>
              </div>

              <div className="rounded-lg border p-3">
                <p className="text-muted-foreground text-xs">
                  Categoria provável
                </p>
                <p className="font-medium">
                  {response.analysis.category || "-"}
                </p>
              </div>

              <div className="rounded-lg border p-3">
                <p className="text-muted-foreground text-xs">
                  Confiança da análise
                </p>
                <p className="font-medium">
                  {formatConfidence(response.analysis.confidence)}
                </p>
              </div>
            </div>

            <p className="text-muted-foreground text-sm">
              Esses sinais ajudam a ordenar resultados, mas o motor principal é
              a comparação visual com os recortes dos catálogos.
            </p>

            {response.analysis.visibleCodes.length > 0 ? (
              <div className="grid gap-2">
                <p className="text-sm font-medium">Códigos/modelos visíveis</p>

                <div className="flex flex-wrap gap-2">
                  {response.analysis.visibleCodes.map((code) => (
                    <Badge key={code} variant="secondary">
                      {code}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Resultados fortes</CardTitle>
        </CardHeader>

        <CardContent>
          {!response ? (
            <div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm">
              Envie uma imagem para buscar produtos visualmente parecidos.
            </div>
          ) : strongResults.length === 0 ? (
            <div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm">
              Nenhum resultado forte encontrado. Veja os possíveis parecidos
              abaixo ou teste uma imagem mais limpa.
            </div>
          ) : (
            <div className="grid gap-4">
              {strongResults.map((result) => (
                <ResultCard key={result.id} result={result} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {response && possibleResults.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Possíveis parecidos</CardTitle>
          </CardHeader>

          <CardContent>
            <details className="grid gap-4">
              <summary className="cursor-pointer text-sm font-medium underline-offset-4 hover:underline">
                Mostrar {possibleResults.length} resultado(s) menos confiáveis
              </summary>

              <div className="mt-4 grid gap-4">
                {possibleResults.map((result) => (
                  <ResultCard key={result.id} result={result} />
                ))}
              </div>
            </details>
          </CardContent>
        </Card>
      ) : null}
    </main>
  );
}
