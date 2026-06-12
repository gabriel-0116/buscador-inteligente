"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal, RefreshCw, Trash } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Catalog detail-page "..." menu. Wraps the two destructive-ish actions
// (Reprocessar / Excluir) behind a discreet trigger and gates Excluir with
// a confirm dialog. Replaces the loose `DeleteCatalogButton` +
// `ReprocessCatalogButton` pair previously rendered side-by-side.
export function CatalogActionsMenu({
  catalogId,
  fileName,
  hasPdf,
  redirectTo,
}: {
  catalogId: string;
  fileName: string;
  hasPdf: boolean;
  redirectTo: string;
}) {
  const router = useRouter();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState<"reprocess" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleReprocess() {
    if (!hasPdf) {
      setError(
        "PDF original não disponível no Storage — reenvie o arquivo pra reprocessar."
      );
      return;
    }
    setError(null);
    setBusy("reprocess");
    try {
      const res = await fetch(`/api/catalogs/${catalogId}/reprocess`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Erro ao reprocessar");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao reprocessar.");
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete() {
    setError(null);
    setBusy("delete");
    try {
      const res = await fetch(`/api/catalogs/${catalogId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Falha ao excluir");
      setConfirmDelete(false);
      router.push(redirectTo);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao excluir.");
      setBusy(null);
    }
  }

  return (
    <>
      <div className="flex flex-col items-end gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Ações do catálogo"
              disabled={busy !== null}
            >
              <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[180px]">
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                void handleReprocess();
              }}
              disabled={!hasPdf || busy !== null}
            >
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
              {busy === "reprocess" ? "Reprocessando..." : "Reprocessar"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                setConfirmDelete(true);
              }}
              disabled={busy !== null}
              className="text-destructive focus:text-destructive"
            >
              <Trash className="mr-2 h-4 w-4" aria-hidden="true" />
              Excluir
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {error && (
          <p
            role="alert"
            className="text-xs text-destructive max-w-[260px] text-right"
          >
            {error}
          </p>
        )}
      </div>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Excluir catálogo</DialogTitle>
            <DialogDescription>
              Excluir o catálogo{" "}
              <span className="font-medium text-foreground">
                &ldquo;{fileName}&rdquo;
              </span>
              ? Os arquivos no Storage, embeddings, produtos detectados e a
              análise serão apagados. Essa ação não pode ser desfeita.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setConfirmDelete(false)}
              disabled={busy === "delete"}
            >
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={busy === "delete"}
            >
              {busy === "delete" ? "Excluindo..." : "Excluir"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
