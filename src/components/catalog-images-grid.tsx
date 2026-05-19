import Image from "next/image";

type ProductImage = {
  id: string;
  imageUrl: string;
  width: number;
  height: number;
};

export function CatalogImagesGrid({ images }: { images: ProductImage[] }) {
  if (images.length === 0) {
    return (
      <p className="py-12 text-center text-muted-foreground">
        Nenhuma imagem extraída.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
      {images.map((img) => (
        <a
          key={img.id}
          href={img.imageUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="relative aspect-square overflow-hidden rounded-md border bg-muted transition-opacity hover:opacity-90"
        >
          <Image
            src={img.imageUrl}
            alt="Imagem do produto"
            fill
            className="object-contain p-1"
            sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, 20vw"
          />
        </a>
      ))}
    </div>
  );
}
