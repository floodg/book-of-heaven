# Spec: Authentication

## Files
```
frontend/src/lib/supabase.ts
frontend/src/components/AuthPage.tsx
frontend/src/App.tsx
```

---

## supabase.ts — Client singleton

Create and export a single Supabase client instance used throughout the app.

```typescript
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
```

---

## AuthPage.tsx

### Purpose
Full-page auth screen shown when no user is logged in. Handles sign up, sign in, and password reset.

### Libraries
Use `@supabase/auth-ui-react` and `@supabase/auth-ui-shared`:
```typescript
import { Auth } from '@supabase/auth-ui-react'
import { ThemeSupa } from '@supabase/auth-ui-shared'
```

### Layout
- Centered card on a warm off-white background
- App title at top: "Book of Heaven" in serif font
- Subtitle: "Search the writings of Luisa Piccarreta"
- Auth UI component below the title
- Footer: small attribution text

### Auth UI config
```typescript
<Auth
  supabaseClient={supabase}
  appearance={{ theme: ThemeSupa, variables: {
    default: {
      colors: {
        brand: '#92400e',           // warm brown
        brandAccent: '#78350f',
      }
    }
  }}}
  providers={[]}                    // no OAuth for v1, email only
  redirectTo={window.location.origin}
/>
```

### Styling notes
- Background: `#faf7f2` (warm off-white)
- Card: white, soft shadow, rounded-xl, max-w-md, centered
- Title font: Lora or Playfair Display (load from Google Fonts via index.html)
- Title color: `#1c0a00` (deep brown)

---

## App.tsx

### Purpose
Root component. Manages auth state and routes between AuthPage and the main chat layout.

### Behaviour
1. On mount, call `supabase.auth.getSession()` to check if user is already logged in
2. Subscribe to `supabase.auth.onAuthStateChange` to react to login/logout
3. If no session → render `<AuthPage />`
4. If session exists → render main layout (see SPEC-chat-ui.md)
5. Pass `user` and `session` down as props or via context

### Loading state
Show a simple centered spinner or blank warm background while the initial session check resolves. Do not flash the auth page briefly before redirecting.

### Session type
```typescript
import { Session, User } from '@supabase/supabase-js'
```

### Logout
Provide a logout button in the header that calls:
```typescript
await supabase.auth.signOut()
```
Auth state listener will automatically trigger re-render to AuthPage.
