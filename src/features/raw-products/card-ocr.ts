import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prisma } from "@/lib/prisma";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import sharp from "sharp";

const execFileAsync = promisify(execFile);

function resolveProjectPath(path: string) {
  return isAbsolute(path) ? path : join(process.cwd(), path);
}

function normalizeCode(code: string) {
  return code
    .toUpperCase()
    .replace(/[)\]]/g, "J")
    .replace(/[^A-Z0-9-]/g, "")
    .trim();
}

function extractProductCode(text: string) {
  const regex = /\b[A-Z0-9]{1,8}[)\]J]?-[A-Z0-9]{2,10}\b/g;
  const matches = Array.from(text.toUpperCase().matchAll(regex)).map((match) =>
    normalizeCode(match[0])
  );

  const validCodes = matches.filter((code) => {
    if (!code.includes("-")) return false;
    if (code.startsWith("PCS")) return false;
    if (code.startsWith("CX")) return false;
    if (code.length < 4) return false;

    return true;
  });

  const knownPrefixCode = validCodes.find((code) =>
    /^(ZZJ|DQ|TX|LUT|DSZJ|DSZ)-/.test(code)
  );

  return knownPrefixCode ?? validCodes[0] ?? null;
}

function inferProductInfo(rawText: string, code: string | null) {
  const text = rawText.toLowerCase();
  const normalizedCode = code ?? "";

  if (normalizedCode.startsWith("ZZJ") || /榨\s*汁\s*机/.test(rawText)) {
    return {
      translatedNamePt: "Liquidificador portátil",
      category: "Eletroportáteis",
    };
  }

  if (normalizedCode.startsWith("DQ") || /相机|摄像/.test(rawText)) {
    return {
      translatedNamePt: "Câmera infantil",
      category: "Eletrônicos infantis",
    };
  }

  if (
    normalizedCode.startsWith("TX") ||
    normalizedCode.startsWith("LUT") ||
    /电视\s*天\s*线/.test(rawText) ||
    /antenna|antena/.test(text)
  ) {
    return {
      translatedNamePt: "Antena de TV",
      category: "Acessórios para TV",
    };
  }

  if (
    normalizedCode.startsWith("DSZJ") ||
    normalizedCode.startsWith("DSZ") ||
    /电视\s*支\s*架|支架/.test(rawText) ||
    /support|bracket|suporte/.test(text)
  ) {
    return {
      translatedNamePt: "Suporte de TV",
      category: "Acessórios para TV",
    };
  }

  if (/usb|charger|carregador|tomada|adaptador|16a|2100ma/.test(text)) {
    return {
      translatedNamePt: "Produto elétrico",
      category: "Elétricos",
    };
  }

  return {
    translatedNamePt: code ? `Produto ${code}` : "Produto recortado",
    category: null,
  };
}

async function runTesseract(imagePath: string) {
  const langs = process.env.OCR_LANGS || "chi_sim+eng+por";

  const tempDir = await mkdtemp(join(tmpdir(), "card-ocr-"));
  const processedImagePath = join(tempDir, "processed.png");

  try {
    await sharp(imagePath)
      .resize({
        width: 1400,
        withoutEnlargement: false,
      })
      .grayscale()
      .sharpen()
      .png()
      .toFile(processedImagePath);

    const { stdout } = await execFileAsync("tesseract", [
      processedImagePath,
      "stdout",
      "-l",
      langs,
      "--psm",
      "6",
    ]);

    return stdout.trim();
  } finally {
    await rm(tempDir, {
      recursive: true,
      force: true,
    });
  }
}

export async function runRawProductCardOcr(rawProductId: string) {
  const rawProduct = await prisma.rawProduct.findUnique({
    where: {
      id: rawProductId,
    },
  });

  if (!rawProduct) {
    throw new Error("Produto bruto não encontrado.");
  }

  if (!rawProduct.imageUrl) {
    throw new Error("Produto bruto não possui imagem recortada.");
  }

  const imagePath = resolveProjectPath(rawProduct.imageUrl);
  const rawText = await runTesseract(imagePath);
  const code = extractProductCode(rawText);
  const info = inferProductInfo(rawText, code);

  await prisma.rawProduct.update({
    where: {
      id: rawProduct.id,
    },
    data: {
      originalText: rawText || null,
      code,
      translatedNamePt: info.translatedNamePt,
      translatedDescriptionPt:
        "Produto interpretado automaticamente a partir do OCR do card recortado. Revisar antes de aprovar.",
      category: info.category,
      brand: rawText.toLowerCase().includes("lukton") ? "LUKTON" : null,
      confidence: code ? 0.65 : 0.4,
    },
  });

  return {
    code,
  };
}

export async function runRawProductCardsOcrFromPage(pageId: string) {
  const page = await prisma.catalogPage.findUnique({
    where: {
      id: pageId,
    },
    include: {
      rawProducts: {
        orderBy: {
          createdAt: "asc",
        },
      },
    },
  });

  if (!page) {
    throw new Error("Página não encontrada.");
  }

  const productsWithImage = page.rawProducts.filter(
    (product) => product.imageUrl
  );

  let processed = 0;

  for (const product of productsWithImage) {
    await runRawProductCardOcr(product.id);
    processed++;
  }

  return {
    processed,
  };
}
