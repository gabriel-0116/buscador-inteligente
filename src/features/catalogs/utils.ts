export function formatBytes(bytes: number | null | undefined) {
  if (!bytes) return "-";

  const mb = bytes / 1024 / 1024;

  return `${mb.toFixed(2)} MB`;
}

export function formatCatalogStatus(status: string) {
  const labels: Record<string, string> = {
    DRAFT: "Rascunho",
    PROCESSING: "Processando",
    READY_FOR_REVIEW: "Pronto para revisão",
    REVIEWED: "Revisado",
    FAILED: "Falhou",
  };

  return labels[status] ?? status;
}
