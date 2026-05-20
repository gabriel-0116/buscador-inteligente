import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

export function getPublicImageUrl(storagePath: string) {
  return `${supabaseUrl}/storage/v1/object/public/product-images/${storagePath}`;
}

export async function uploadImageToStorage(
  storagePath: string,
  buffer: Buffer,
  contentType = "image/jpeg"
): Promise<string> {
  const { error } = await supabaseAdmin.storage
    .from("product-images")
    .upload(storagePath, buffer, { contentType, upsert: true });

  if (error) throw new Error(`Upload falhou (${storagePath}): ${error.message}`);

  return getPublicImageUrl(storagePath);
}
