const MAX_PRIOR_USER_MESSAGES = 6
const MAX_PRIOR_CHARS = 1600
const REWRITE_TIMEOUT_MS = 8_000
const REWRITE_MAX_WORDS = 40

const FOLLOW_UP_RE =
  /\b(the same|same thing|that|those|them|this|it|again|earlier|previous|above|as before)\b/i

export function looksLikeFollowUp(message: string): boolean {
  const t = message.trim()
  if (!t) return false
  if (t.length <= 48) return true
  return FOLLOW_UP_RE.test(t)
}

export function priorUserQuestionsFromRows(
  rows: Array<{ content?: unknown }>,
): string[] {
  const out: string[] = []
  for (const row of rows) {
    if (typeof row.content !== 'string') continue
    const text = row.content.trim()
    if (!text) continue
    out.push(text)
    if (out.length >= MAX_PRIOR_USER_MESSAGES) break
  }
  return out.reverse()
}

export function fallbackStandaloneQuery(
  currentMessage: string,
  priorUserQuestions: string[],
): string {
  const current = currentMessage.trim()
  if (priorUserQuestions.length === 0) return current
  if (!looksLikeFollowUp(current)) return current
  const last = priorUserQuestions[priorUserQuestions.length - 1]?.trim()
  return last || current
}

function clipPriorQuestions(questions: string[]): string[] {
  const clipped: string[] = []
  let used = 0
  for (const q of questions) {
    const next = q.length > 400 ? `${q.slice(0, 400).trim()}…` : q
    if (used + next.length > MAX_PRIOR_CHARS) break
    clipped.push(next)
    used += next.length
  }
  return clipped.length > 0 ? clipped : questions.slice(-1)
}

function normalizeRewrittenQuery(raw: string, fallback: string): string {
  let t = raw.replace(/\s+/g, ' ').trim()
  t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim()
  t = t.replace(/^(search query|query|standalone request)\s*[:\-]\s*/i, '').trim()
  if (t.length < 2) return fallback
  const words = t.split(' ')
  if (words.length > REWRITE_MAX_WORDS) {
    t = words.slice(0, REWRITE_MAX_WORDS).join(' ')
  }
  if (t.length > 500) t = t.slice(0, 500).trim()
  return t
}

export async function rewriteStandaloneQuery(
  currentMessage: string,
  priorUserQuestions: string[],
): Promise<string> {
  const current = currentMessage.trim()
  if (priorUserQuestions.length === 0) return current

  const fallback = fallbackStandaloneQuery(current, priorUserQuestions)
  const openAiKey = Deno.env.get('OPENAI_API_KEY')?.trim()
  if (!openAiKey) return fallback

  const priors = clipPriorQuestions(priorUserQuestions)
  const numbered = priors.map((q, i) => `${i + 1}. ${q}`).join('\n')
  const model = Deno.env.get('DEFAULT_RESEARCH_MODEL') ?? 'gpt-4o-mini'

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openAiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 80,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'Rewrite a chat follow-up into a standalone search query for the Book of Heaven. ' +
              'Output ONLY the query — no quotes, no prefix, no explanation. ' +
              'If the latest message refers to earlier questions ("the same", "that", "those"), ' +
              'merge the prior topic into one self-contained query. ' +
              'If the latest message is already a complete new question, output it unchanged.',
          },
          {
            role: 'user',
            content:
              `Earlier user questions:\n${numbered}\n\nLatest user message:\n${current}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(REWRITE_TIMEOUT_MS),
    })
    if (!res.ok) {
      console.warn('Query rewrite OpenAI error', res.status, await res.text())
      return fallback
    }
    const json = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const text = json.choices?.[0]?.message?.content ?? ''
    return normalizeRewrittenQuery(text, fallback)
  } catch (err) {
    console.warn('Query rewrite failed (using fallback)', err)
    return fallback
  }
}

export function composeAnythingLlmMessage(
  currentMessage: string,
  standaloneQuery: string,
  priorUserQuestions: string[],
  projectInstructions: string | null,
): string {
  const current = currentMessage.trim()
  const query = standaloneQuery.trim()
  let body = current
  if (priorUserQuestions.length > 0) {
    const priors = clipPriorQuestions(priorUserQuestions)
    const numbered = priors.map((q, i) => `${i + 1}. ${q}`).join('\n')
    body =
      'This is a follow-up in an ongoing conversation. ' +
      'Interpret references like "the same" or "that" using the earlier questions.\n\n' +
      `Earlier user questions:\n${numbered}\n\n` +
      `Latest user message:\n${current}\n\n` +
      `Standalone search request:\n${query}`
  }
  if (!projectInstructions) return body
  return (
    'You are acting inside a user\'s project. Follow these project-level instructions ' +
    `for the rest of this conversation:\n\n---\n${projectInstructions}\n---\n\n${body}`
  )
}
