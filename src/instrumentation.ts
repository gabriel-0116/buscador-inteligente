export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Preload CLIP model so the first search request is fast
    const { getExtractor } = await import(
      "./features/visual-search/embeddings"
    );
    getExtractor().catch(() => {});
  }
}
