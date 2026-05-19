import { exec } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

const execAsync = promisify(exec);

export async function extractImagesFromPdf(
  pdfPath: string,
  outputDir: string
): Promise<string[]> {
  await mkdir(outputDir, { recursive: true });

  // -j keeps JPEG as JPEG; other formats come out as .ppm
  await execAsync(`pdfimages -j "${pdfPath}" "${join(outputDir, "img")}"`);

  const files = await readdir(outputDir);
  return files
    .filter((f) => /\.(jpe?g|png|ppm|pbm|pnm)$/i.test(f))
    .sort()
    .map((f) => join(outputDir, f));
}
