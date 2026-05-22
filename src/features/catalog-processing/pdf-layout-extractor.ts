import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const execFileAsync = promisify(execFile);

// ── Schema (mirrors scripts/extract_pdf_layout.py output) ────────────────────
//
// Coordinates are in PDF *points*, top-left origin. The card detector converts
// them to rendered-image pixels with a simple linear scale.

export const PdfLayoutBlockSchema = z.object({
  type: z.enum(["text", "image", "drawing"]),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite(),
  text: z.string().optional(),
});

export const PdfLayoutPageSchema = z.object({
  pageNumber: z.number().int().positive(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
  blocks: z.array(PdfLayoutBlockSchema).default([]),
});

export const PdfLayoutDocumentSchema = z.object({
  pages: z.array(PdfLayoutPageSchema).default([]),
});

export type PdfLayoutBlock = z.infer<typeof PdfLayoutBlockSchema>;
export type PdfLayoutPage = z.infer<typeof PdfLayoutPageSchema>;
export type PdfLayoutDocument = z.infer<typeof PdfLayoutDocumentSchema>;

// Python interpreter is configurable so deployments can point at a venv.
function getPythonBin(): string {
  return process.env.PYTHON_BIN || "python3";
}

function getScriptPath(): string {
  return join(process.cwd(), "scripts", "extract_pdf_layout.py");
}

/**
 * Run the PyMuPDF extraction script and return the parsed layout.
 *
 * This is best-effort: any failure (missing Python, missing PyMuPDF, parse
 * error, schema mismatch) is logged and resolves to `null` so the caller can
 * fall back to the heuristic / vision pipeline instead of crashing the whole
 * catalog. The child process is spawned with an args array (never a shell
 * string) so a malicious filename can't inject commands.
 */
export async function extractPdfLayout(args: {
  pdfPath: string;
  outputDir: string;
}): Promise<PdfLayoutDocument | null> {
  const outPath = join(args.outputDir, "pdf-layout.json");
  try {
    await mkdir(args.outputDir, { recursive: true });

    const { stderr } = await execFileAsync(
      getPythonBin(),
      [getScriptPath(), args.pdfPath, outPath],
      { maxBuffer: 32 * 1024 * 1024 }
    );
    if (stderr && stderr.trim()) {
      console.log(`[pdf-layout] ${stderr.trim()}`);
    }

    const raw = await readFile(outPath, "utf-8");
    const parsed = PdfLayoutDocumentSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      console.error(
        `[pdf-layout] schema validation failed: ${parsed.error.message}`
      );
      return null;
    }
    return parsed.data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[pdf-layout] extraction unavailable: ${msg}`);
    return null;
  } finally {
    await rm(outPath, { force: true }).catch(() => {});
  }
}
