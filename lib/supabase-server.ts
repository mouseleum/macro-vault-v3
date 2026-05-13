import { createClient } from "@supabase/supabase-js";
import { getEnv } from "./env";

export function createSupabaseAdmin() {
  return createClient(getEnv("SUPABASE_URL"), getEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

export function createSupabasePublic() {
  return createClient(getEnv("SUPABASE_URL"), getEnv("SUPABASE_ANON_KEY"), {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}
