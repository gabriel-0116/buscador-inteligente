import { execFile } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function renderPdfPagesToImages(
  pdfPath: string,
  outputDir: string
): Promise<Array<{ pageNumber: number; imagePath: string }>> {
  await mkdir(outputDir, { recursive: true });

  // pdftoppm -jpeg -r 180 generates page-1.jpg, page-2.jpg, ...
  await execFileAsync("pdftoppm", ["-jpeg", "-r", "180", pdfPath, join(outputDir, "page")]);

  const files = await readdir(outputDir);
  return files
    .filter((f) => /^page-\d+\.jpg$/i.test(f))
    .sort((a, b) => {
      const numA = parseInt(a.match(/(\d+)/)![1], 10);
      const numB = parseInt(b.match(/(\d+)/)![1], 10);
      return numA - numB;
    })
    .map((f) => ({
      pageNumber: parseInt(f.match(/(\d+)/)![1], 10),
      imagePath: join(outputDir, f),
    }));
}
