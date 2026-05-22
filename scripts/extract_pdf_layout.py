#!/usr/bin/env python3
"""Extract the structural layout of a PDF using PyMuPDF.

The goal is *positions*, not perfect content: where the text, images and
vector drawings sit on each page. The TypeScript pipeline groups these blocks
into product cards (see pdf-layout-card-detector.ts), so the LLM is no longer
the primary "cropper".

Usage:
    python scripts/extract_pdf_layout.py input.pdf output-layout.json

Output JSON (coordinates are in PDF *points*, top-left origin — the same
orientation PyMuPDF uses, which matches rendered-image pixel space after a
linear scale):

    {
      "pages": [
        {
          "pageNumber": 1,
          "width": 595.0,
          "height": 842.0,
          "blocks": [
            { "type": "text",    "x": 100, "y": 200, "width": 120, "height": 30, "text": "EL-1920" },
            { "type": "image",   "x": 130, "y": 260, "width": 200, "height": 180 },
            { "type": "drawing", "x": 80,  "y": 180, "width": 420, "height": 360 }
          ]
        }
      ]
    }
"""

import json
import sys

import fitz  # PyMuPDF

# Block-type codes used by page.get_text("dict").
_TEXT_BLOCK = 0
_IMAGE_BLOCK = 1

# Ignore degenerate / sub-pixel boxes — they only add noise to clustering.
_MIN_DIM = 1.0
# Cap stored text so a chatty page can't bloat the JSON; positions are what matter.
_MAX_TEXT_LEN = 160


def _block(kind, bbox, text=None):
    """Build a normalized block dict from a PyMuPDF bbox (x0, y0, x1, y1)."""
    x0, y0, x1, y1 = bbox
    width = x1 - x0
    height = y1 - y0
    if width < _MIN_DIM or height < _MIN_DIM:
        return None
    block = {
        "type": kind,
        "x": round(x0, 2),
        "y": round(y0, 2),
        "width": round(width, 2),
        "height": round(height, 2),
    }
    if text:
        block["text"] = text[:_MAX_TEXT_LEN]
    return block


def _text_of(block):
    """Concatenate the spans of a text block into a single trimmed string."""
    parts = []
    for line in block.get("lines", []):
        for span in line.get("spans", []):
            t = span.get("text", "")
            if t:
                parts.append(t)
        parts.append(" ")
    return "".join(parts).strip()


def _extract_page(page):
    rect = page.rect
    blocks = []

    # Text + image blocks come from the structured text dict. Image blocks (type
    # 1) carry their placed bbox directly, which is exactly what we want — no
    # xref → rect lookup needed.
    data = page.get_text("dict")
    for b in data.get("blocks", []):
        btype = b.get("type", _TEXT_BLOCK)
        bbox = b.get("bbox")
        if not bbox:
            continue
        if btype == _TEXT_BLOCK:
            blk = _block("text", bbox, _text_of(b))
        elif btype == _IMAGE_BLOCK:
            blk = _block("image", bbox)
        else:
            blk = None
        if blk:
            blocks.append(blk)

    # Vector drawings (rectangles / borders) help delimit card edges.
    try:
        for d in page.get_drawings():
            r = d.get("rect")
            if r is None:
                continue
            blk = _block("drawing", (r.x0, r.y0, r.x1, r.y1))
            if blk:
                blocks.append(blk)
    except Exception:  # noqa: BLE001 — drawings are best-effort, never fatal.
        pass

    return {
        "pageNumber": page.number + 1,
        "width": round(rect.width, 2),
        "height": round(rect.height, 2),
        "blocks": blocks,
    }


def extract(pdf_path):
    doc = fitz.open(pdf_path)
    try:
        pages = [_extract_page(page) for page in doc]
    finally:
        doc.close()
    return {"pages": pages}


def main(argv):
    if len(argv) < 3:
        print(
            "usage: extract_pdf_layout.py <input.pdf> <output.json>",
            file=sys.stderr,
        )
        return 2

    pdf_path, out_path = argv[1], argv[2]
    try:
        result = extract(pdf_path)
    except Exception as exc:  # noqa: BLE001 — surface a clean message, exit non-zero.
        print(f"extract_pdf_layout: failed to parse {pdf_path}: {exc}", file=sys.stderr)
        return 1

    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False)

    pages = result["pages"]
    total_blocks = sum(len(p["blocks"]) for p in pages)
    total_images = sum(
        sum(1 for b in p["blocks"] if b["type"] == "image") for p in pages
    )
    print(
        f"extract_pdf_layout: pages={len(pages)} blocks={total_blocks} "
        f"images={total_images}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
