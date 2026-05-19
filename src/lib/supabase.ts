import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Client com service role para upload server-side
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

export function getPublicImageUrl(path: string) {
  return `${supabaseUrl}/storage/v1/object/public/product-images/${path}`;
}
