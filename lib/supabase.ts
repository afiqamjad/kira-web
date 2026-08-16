import { createClient } from '@supabase/supabase-js'

// One shared browser client. persistSession defaults to true, so the anonymous
// session is stored in localStorage — that's what keeps a person tied to their
// claimed member across page reloads and revisits on the same browser.
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  }
)

// Ensures there is an anonymous session before any data call.
export async function ensureAnonSession() {
  const { data } = await supabase.auth.getSession()
  if (data.session) return data.session
  const { data: signIn, error } = await supabase.auth.signInAnonymously()
  if (error) throw error
  return signIn.session
}
