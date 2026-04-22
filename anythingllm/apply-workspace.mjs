#!/usr/bin/env node
// Applies a workspace config + system prompt to an AnythingLLM instance.
//
// Usage:
//   node anythingllm/apply-workspace.mjs --config anythingllm/workspaces/book-of-heaven-narrated.config.json
//   node anythingllm/apply-workspace.mjs --config ... --url http://localhost:3001 --key XXX
//
// If --url/--key are omitted they are read from env vars:
//   ANYTHINGLLM_URL, ANYTHINGLLM_KEY
//
// Requires Node 18+ (uses global fetch).

import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = parseArgs(process.argv.slice(2))

const configPath = args.config
if (!configPath) fail('Missing required --config <path/to/workspace.config.json>')

const baseUrl = (args.url ?? process.env.ANYTHINGLLM_URL ?? '').replace(/\/+$/, '')
const apiKey = args.key ?? process.env.ANYTHINGLLM_KEY ?? ''
if (!baseUrl) fail('Missing AnythingLLM URL. Pass --url or set ANYTHINGLLM_URL.')
if (!apiKey) fail('Missing AnythingLLM API key. Pass --key or set ANYTHINGLLM_KEY.')

const absoluteConfigPath = resolve(process.cwd(), configPath)
const configDir = dirname(absoluteConfigPath)
const config = JSON.parse(await readFile(absoluteConfigPath, 'utf8'))

if (!config.slug) fail('Config must include a "slug" field.')
if (!config.promptFile) fail('Config must include a "promptFile" field.')

const promptPath = resolve(configDir, config.promptFile)
const prompt = (await readFile(promptPath, 'utf8')).trim()

const authHeaders = {
  Authorization: `Bearer ${apiKey}`,
  'Content-Type': 'application/json',
}

console.log(`Target:    ${baseUrl}`)
console.log(`Workspace: ${config.slug} (${config.name ?? '(no display name)'})`)
console.log(`Prompt:    ${promptPath} (${prompt.length} chars)`)

const existing = await getWorkspace(baseUrl, authHeaders, config.slug)
if (!existing) {
  console.log(`Workspace "${config.slug}" does not exist. Creating it...`)
  await createWorkspace(baseUrl, authHeaders, config)
  console.log('Created. Note: documents must be (re)embedded separately.')
}

const updatePayload = {
  ...config.settings,
  openAiPrompt: prompt,
}

const res = await fetch(
  `${baseUrl}/api/v1/workspace/${encodeURIComponent(config.slug)}/update`,
  {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(updatePayload),
  },
)
if (!res.ok) {
  const body = await res.text()
  fail(`Failed to update workspace: HTTP ${res.status}\n${body}`)
}

console.log(`\nApplied ${Object.keys(updatePayload).length} settings to workspace "${config.slug}".`)
console.log('Verified settings:')
const updated = await getWorkspace(baseUrl, authHeaders, config.slug)
if (updated) {
  const summary = {
    slug: updated.slug,
    chatProvider: updated.chatProvider,
    chatModel: updated.chatModel,
    topN: updated.topN,
    vectorSearchMode: updated.vectorSearchMode,
    openAiTemp: updated.openAiTemp,
    similarityThreshold: updated.similarityThreshold,
    chatMode: updated.chatMode,
    openAiHistory: updated.openAiHistory,
    openAiPromptLength: updated.openAiPrompt?.length ?? 0,
  }
  console.log(JSON.stringify(summary, null, 2))
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (!flag.startsWith('--')) continue
    const key = flag.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = true
    } else {
      out[key] = next
      i++
    }
  }
  return out
}

async function getWorkspace(baseUrl, headers, slug) {
  const res = await fetch(`${baseUrl}/api/v1/workspace/${encodeURIComponent(slug)}`, { headers })
  if (res.status === 404) return null
  if (!res.ok) fail(`Failed to fetch workspace: HTTP ${res.status}\n${await res.text()}`)
  const json = await res.json()
  // AnythingLLM returns `workspace` as an array with a single element.
  const ws = Array.isArray(json.workspace) ? json.workspace[0] : json.workspace
  return ws ?? null
}

async function createWorkspace(baseUrl, headers, config) {
  const res = await fetch(`${baseUrl}/api/v1/workspace/new`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: config.name ?? config.slug }),
  })
  if (!res.ok) fail(`Failed to create workspace: HTTP ${res.status}\n${await res.text()}`)
  const json = await res.json()
  const workspace = Array.isArray(json.workspace) ? json.workspace[0] : json.workspace
  if (workspace?.slug && workspace.slug !== config.slug) {
    console.warn(
      `\n[warn] Created workspace slug "${workspace.slug}" but config expected "${config.slug}". ` +
        `AnythingLLM auto-generates slugs from names when a slug is already taken. ` +
        `Update your config.slug to "${workspace.slug}" or rename/remove the conflicting workspace.`,
    )
    process.exit(1)
  }
}

function fail(msg) {
  console.error(msg)
  process.exit(1)
}
