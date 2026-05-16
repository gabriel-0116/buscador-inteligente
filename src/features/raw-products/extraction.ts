import { prisma } from "@/lib/prisma";

type ProductCandidate = {
  code: string;
  originalText: string;
  translatedNamePt: string;
  translatedDescriptionPt: string;
  category: string | null;
  confidence: number;
};

const CODE_REGEX = /\b[A-Z]{2,6}[A-Z\)]?-[A-Z0-9]{2,8}\b/g;

function normalizeCode(code: string) {
  return code
    .replace(/\)/g, "J")
    .replace(/[^A-Z0-9-]/g, "")
    .trim();
}

function getContext(rawText: string, index: number, length: number) {
  const start = Math.max(0, index - 220);
  const end = Math.min(rawText.length, index + length + 220);

  return rawText.slice(start, end).trim();
}

function inferProductInfo(context: string, code: string) {
  const text = context.toLowerCase();

  if (/榨\s*汁\s*机|juicer|blender|liquidificador/.test(context)) {
    return {
      translatedNamePt: "Liquidificador portátil",
      category: "Eletroportáteis",
    };
  }

  if (
    /相机|摄像|camera|câmera|camara/.test(text) ||
    /相机|摄像/.test(context)
  ) {
    return {
      translatedNamePt: "Câmera infantil",
      category: "Eletrônicos infantis",
    };
  }

  if (
    /电视\s*天\s*线|antena|antenna/.test(text) ||
    /电视\s*天\s*线/.test(context)
  ) {
    return {
      translatedNamePt: "Antena de TV",
      category: "Acessórios para TV",
    };
  }

  if (/支架|suporte|support|bracket/.test(text) || /支架/.test(context)) {
    return {
      translatedNamePt: "Suporte de TV",
      category: "Acessórios para TV",
    };
  }

  if (/usb|tomada|adaptador|charger|carregador|2100ma|16a/.test(text)) {
    return {
      translatedNamePt: "Produto elétrico",
      category: "Elétricos",
    };
  }

  return {
    translatedNamePt: `Produto detectado ${code}`,
    category: null,
  };
}

function extractCandidatesFromText(rawText: string): ProductCandidate[] {
  const matches = Array.from(rawText.matchAll(CODE_REGEX));
  const seenCodes = new Set<string>();
  const candidates: ProductCandidate[] = [];

  for (const match of matches) {
    const rawCode = match[0];
    const code = normalizeCode(rawCode);

    if (!code || seenCodes.has(code)) {
      continue;
    }

    seenCodes.add(code);

    const index = match.index ?? 0;
    const context = getContext(rawText, index, rawCode.length);
    const info = inferProductInfo(context, code);

    candidates.push({
      code,
      originalText: context,
      translatedNamePt: info.translatedNamePt,
      translatedDescriptionPt:
        "Candidato extraído automaticamente do OCR. Revisar imagem antes de aprovar.",
      category: info.category,
      confidence: 0.45,
    });
  }

  return candidates;
}

export async function extractRawProductsFromPage(pageId: string) {
  const page = await prisma.catalogPage.findUnique({
    where: {
      id: pageId,
    },
    include: {
      rawProducts: true,
    },
  });

  if (!page) {
    throw new Error("Página não encontrada.");
  }

  if (!page.rawText) {
    throw new Error("Página ainda não possui OCR.");
  }

  const existingCodes = new Set(
    page.rawProducts
      .map((product) => product.code)
      .filter((code): code is string => Boolean(code))
  );

  const candidates = extractCandidatesFromText(page.rawText).filter(
    (candidate) => !existingCodes.has(candidate.code)
  );

  if (candidates.length === 0) {
    return {
      created: 0,
    };
  }

  await prisma.rawProduct.createMany({
    data: candidates.map((candidate) => ({
      catalogPageId: page.id,
      originalText: candidate.originalText,
      translatedNamePt: candidate.translatedNamePt,
      translatedDescriptionPt: candidate.translatedDescriptionPt,
      category: candidate.category,
      code: candidate.code,
      confidence: candidate.confidence,
      status: "PENDING_REVIEW",
    })),
  });

  return {
    created: candidates.length,
  };
}

export async function extractRawProductsFromCatalog(catalogId: string) {
  const catalog = await prisma.catalog.findUnique({
    where: {
      id: catalogId,
    },
    include: {
      pages: {
        orderBy: {
          pageNumber: "asc",
        },
      },
    },
  });

  if (!catalog) {
    throw new Error("Catálogo não encontrado.");
  }

  let created = 0;

  for (const page of catalog.pages) {
    if (!page.rawText) {
      continue;
    }

    const result = await extractRawProductsFromPage(page.id);
    created += result.created;
  }

  return {
    created,
  };
}
