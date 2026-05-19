"use client";

import { useRef, useState } from "react";
import { Upload } from "lucide-react";

type Props = {
  onImageSelect: (file: File) => void;
  disabled?: boolean;
};

export function ImageUpload({ onImageSelect, disabled }: Props) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file?.type.startsWith("image/")) onImageSelect(file);
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => !disabled && inputRef.current?.click()}
      className={[
        "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-12 transition-colors",
        dragging ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-primary/50",
        disabled ? "pointer-events-none opacity-50" : "",
      ].join(" ")}
    >
      <Upload className="h-8 w-8 text-muted-foreground" />
      <div className="text-center">
        <p className="text-sm font-medium">
          Arraste uma imagem ou clique para selecionar
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          PNG, JPG, WebP até 8MB
        </p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        disabled={disabled}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onImageSelect(file);
        }}
      />
    </div>
  );
}
