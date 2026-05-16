import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getRawProductById } from "@/features/raw-products/queries";
import {
  approveRawProduct,
  rejectRawProduct,
  updateRawProduct,
} from "@/features/raw-products/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

type RawProductPageProps = {
  params: Promise<{
    rawProductId: string;
  }>;
};

function formatRawProductStatus(status: string) {
  const labels: Record<string, string> = {
    PENDING_REVIEW: "Pendente revisão",
    APPROVED: "Aprovado",
    REJECTED: "Rejeitado",
    MERGED: "Mesclado",
  };

  return labels[status] ?? status;
}

export default async function RawProductPage({ params }: RawProductPageProps) {
  const { rawProductId } = await params;

  const rawProduct = await getRawProductById(rawProductId);

  if (!rawProduct) {
    notFound();
  }

  return (
    <main className="mx-auto flex max-w-7xl flex-col gap-6 p-6">
      <div>
        <Button variant="ghost" asChild className="mb-3 px-0">
          <Link href={`/paginas/${rawProduct.catalogPageId}`}>
            ← Voltar para página
          </Link>
        </Button>

        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">
              {rawProduct.translatedNamePt || "Produto bruto"}
            </h1>

            <p className="text-muted-foreground mt-1 text-sm">
              {rawProduct.catalogPage.catalog.fileName} · Fornecedor:{" "}
              {rawProduct.catalogPage.catalog.supplier.name}
            </p>
          </div>

          <Badge variant="secondary">
            {formatRawProductStatus(rawProduct.status)}
          </Badge>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Imagem do produto</CardTitle>
            </CardHeader>

            <CardContent>
              {rawProduct.imageUrl ? (
                <Image
                  src={`/api/raw-products/${rawProduct.id}/image`}
                  alt={rawProduct.translatedNamePt || "Produto bruto"}
                  width={900}
                  height={700}
                  unoptimized
                  className="h-auto w-full rounded border object-contain"
                />
              ) : (
                <div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-sm">
                  Produto bruto sem imagem recortada.
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Texto OCR do card</CardTitle>
            </CardHeader>

            <CardContent>
              {rawProduct.originalText ? (
                <pre className="bg-muted max-h-[360px] overflow-auto rounded p-3 text-xs whitespace-pre-wrap">
                  {rawProduct.originalText}
                </pre>
              ) : (
                <div className="text-muted-foreground text-sm">
                  Nenhum OCR salvo para este produto.
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Revisar produto</CardTitle>
            </CardHeader>

            <CardContent>
              <form action={updateRawProduct} className="grid gap-4">
                <input
                  type="hidden"
                  name="rawProductId"
                  value={rawProduct.id}
                />

                <div className="grid gap-2">
                  <Label htmlFor="translatedNamePt">Nome em português</Label>
                  <Input
                    id="translatedNamePt"
                    name="translatedNamePt"
                    defaultValue={rawProduct.translatedNamePt || ""}
                    required
                  />
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="code">Código/modelo</Label>
                  <Input
                    id="code"
                    name="code"
                    defaultValue={rawProduct.code || ""}
                  />
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="brand">Marca</Label>
                  <Input
                    id="brand"
                    name="brand"
                    defaultValue={rawProduct.brand || ""}
                  />
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="category">Categoria</Label>
                  <Input
                    id="category"
                    name="category"
                    defaultValue={rawProduct.category || ""}
                  />
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="translatedDescriptionPt">Descrição</Label>
                  <Textarea
                    id="translatedDescriptionPt"
                    name="translatedDescriptionPt"
                    defaultValue={rawProduct.translatedDescriptionPt || ""}
                    rows={5}
                  />
                </div>

                <Button type="submit">Salvar correções</Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Decisão</CardTitle>
            </CardHeader>

            <CardContent className="flex flex-col gap-3">
              <form action={approveRawProduct}>
                <input
                  type="hidden"
                  name="rawProductId"
                  value={rawProduct.id}
                />

                <Button type="submit" className="w-full">
                  Aprovar produto bruto
                </Button>
              </form>

              <form action={rejectRawProduct}>
                <input
                  type="hidden"
                  name="rawProductId"
                  value={rawProduct.id}
                />

                <Button type="submit" variant="destructive" className="w-full">
                  Rejeitar produto bruto
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}
