import sharp from "sharp";

const MIN_DIMENSION = 150;
const MAX_WHITE_RATIO = 0.92;

export async function isValidProductImage(imagePath: string): Promise<boolean> {
  try {
    const metadata = await sharp(imagePath).metadata();

    if (!metadata.width || !metadata.height) return false;
    if (metadata.width < MIN_DIMENSION || metadata.height < MIN_DIMENSION) {
      return false;
    }

    const { data, info } = await sharp(imagePath)
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .toColorspace("srgb")
      .raw()
      .toBuffer({ resolveWithObject: true });

    const totalPixels = info.width * info.height;
    let whitePixels = 0;

    for (let i = 0; i < data.length; i += info.channels) {
      if (data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240) {
        whitePixels++;
      }
    }

    return whitePixels / totalPixels <= MAX_WHITE_RATIO;
  } catch {
    return false;
  }
}
