FROM node:20-slim

# poppler-utils → pdftoppm (page rendering)
# python3 + PyMuPDF → PDF-structure-first detector (scripts/extract_pdf_layout.py)
RUN apt-get update && apt-get install -y \
    poppler-utils \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# PyMuPDF ships manylinux wheels (no compiler needed). Debian's pip is
# externally-managed, so --break-system-packages is required.
RUN pip3 install --no-cache-dir --break-system-packages PyMuPDF

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

EXPOSE 3000
CMD ["pnpm", "start"]
