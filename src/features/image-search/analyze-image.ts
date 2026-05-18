export type ImageSearchAnalysis = {
  productName: string | null;
  category: string | null;
  function: string | null;
  visibleCodes: string[];
  searchTerms: string[];
  confidence: number | null;
  notes: string | null;
};

function cleanText(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}

function cleanStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 10);
}

function cleanConfidence(value: unknown) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return null;
  }

  return Math.max(0, Math.min(1, value));
}

function normalizeText(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function isUsefulSearchTerm(term: string) {
  const normalizedTerm = normalizeText(term);
  const words = normalizedTerm.split(/\s+/).filter(Boolean);

  if (normalizedTerm.length < 3) {
    return false;
  }

  if (words.length > 4) {
    return false;
  }

  const blockedTerms = new Set([
    "produto",
    "item",
    "imagem",
    "acessorio",
    "acessorios",
    "eletrico",
    "eletricos",
    "uso",
    "cozinha",
  ]);

  if (blockedTerms.has(normalizedTerm)) {
    return false;
  }

  return true;
}

function extractResponseText(response: unknown) {
  if (
    typeof response === "object" &&
    response !== null &&
    "output_text" in response &&
    typeof response.output_text === "string"
  ) {
    return response.output_text;
  }

  if (
    typeof response !== "object" ||
    response === null ||
    !("output" in response) ||
    !Array.isArray(response.output)
  ) {
    return "";
  }

  const texts: string[] = [];

  for (const outputItem of response.output) {
    if (
      typeof outputItem !== "object" ||
      outputItem === null ||
      !("content" in outputItem) ||
      !Array.isArray(outputItem.content)
    ) {
      continue;
    }

    for (const contentItem of outputItem.content) {
      if (
        typeof contentItem === "object" &&
        contentItem !== null &&
        "text" in contentItem &&
        typeof contentItem.text === "string"
      ) {
        texts.push(contentItem.text);
      }
    }
  }

  return texts.join("\n").trim();
}

function parseAnalysisJson(rawText: string): ImageSearchAnalysis {
  const cleanedText = rawText
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();

  const parsed = JSON.parse(cleanedText) as Record<string, unknown>;

  return {
    productName: cleanText(parsed.productName),
    category: cleanText(parsed.category),
    function: cleanText(parsed.function),
    visibleCodes: cleanStringArray(parsed.visibleCodes),
    searchTerms: cleanStringArray(parsed.searchTerms),
    confidence: cleanConfidence(parsed.confidence),
    notes: cleanText(parsed.notes),
  };
}

export function buildImageSearchTerms(analysis: ImageSearchAnalysis) {
  const terms = [
    ...analysis.visibleCodes,
    analysis.productName,
    ...analysis.searchTerms,
  ];

  const uniqueTerms = new Map<string, string>();

  for (const term of terms) {
    if (!term) {
      continue;
    }

    const trimmedTerm = term.trim();

    if (!isUsefulSearchTerm(trimmedTerm)) {
      continue;
    }

    const normalized = normalizeText(trimmedTerm);

    if (!normalized) {
      continue;
    }

    uniqueTerms.set(normalized, trimmedTerm);
  }

  return Array.from(uniqueTerms.values()).slice(0, 6);
}

export async function analyzeImageForProductSearch(
  imageFile: File
): Promise<ImageSearchAnalysis> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY não configurada.");
  }

  const model = process.env.OPENAI_IMAGE_SEARCH_MODEL || "gpt-4.1-mini";

  const imageBuffer = Buffer.from(await imageFile.arrayBuffer());
  const base64Image = imageBuffer.toString("base64");
  const imageUrl = `data:${imageFile.type};base64,${base64Image}`;

  const prompt = `
Você é um analisador de imagem para um buscador interno de catálogos de fornecedores.

Objetivo:
Identificar o produto principal da imagem para buscar dentro de uma base fechada de produtos já cadastrados.

Regras:
- Foque no produto principal.
- Não sugira itens apenas relacionados ao mesmo contexto de uso.
- Se a imagem for de um lápis, não gere termos como caderno, tesoura, estojo ou borracha.
- Extraia códigos/modelos visíveis quando existirem.
- Traduza nomes e categorias para português.
- Use categoria comercial real.
- Seja conservador quando houver dúvida.
- searchTerms deve conter termos curtos e comerciais, nunca frases longas.
- searchTerms deve ter no máximo 6 itens.
- Não coloque função explicativa longa em searchTerms.
- Bons exemplos de searchTerms: "liquidificador portátil", "mini liquidificador", "blender portátil".
- Maus exemplos de searchTerms: "triturar e misturar frutas e outros ingredientes para preparar bebidas".

Responda somente JSON válido, sem markdown, neste formato:

{
  "productName": "nome provável em português ou null",
  "category": "categoria comercial provável ou null",
  "function": "função real do produto ou null",
  "visibleCodes": ["códigos/modelos visíveis"],
  "searchTerms": ["termos curtos para buscar no catálogo"],
  "confidence": 0.0,
  "notes": "observação curta ou null"
}
`.trim();

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: prompt,
            },
            {
              type: "input_image",
              image_url: imageUrl,
            },
          ],
        },
      ],
      max_output_tokens: 700,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(`Erro ao analisar imagem: ${errorText}`);
  }

  const data = (await response.json()) as unknown;
  const outputText = extractResponseText(data);

  if (!outputText) {
    throw new Error("O modelo não retornou texto analisável.");
  }

  return parseAnalysisJson(outputText);
}
