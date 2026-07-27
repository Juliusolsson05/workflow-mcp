/*
 * Reduce an agent's transcript events into the same three things agent-code's WorkflowAgentDetails
 * shows: the Prompt, an ordered list of Activities (tool calls / commands / reasoning / messages,
 * each with a kind and a one-line summary plus expandable content), and the final Result.
 *
 * The standalone run state (PublicRunState) is only a summary — it carries agent status/counts but
 * not the activity stream. The activities live in the per-agent transcript endpoint as the raw
 * workflow event stream (agent.admitted / agent.activity.started|completed / agent.completed), which
 * is exactly what agent-code folds into its live snapshot. Both the web dashboard and the Ink TUI
 * call this so they render identical content from identical data.
 */

export type AgentActivity = {
  activityId: string
  kind: string
  status: 'running' | 'completed' | 'failed'
  summary: string
  content: string
}

export type AgentDetailContent = {
  prompt?: string
  activities: AgentActivity[]
  result?: string
  error?: string
}

type TranscriptEvent = { event: { type?: string; payload?: unknown } }

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

// A content reference is { preview, content, mediaType, truncated } where `content` is either a
// string (a message/reasoning body) or a structured object (a command's {command,output,exitCode}).
// Return a bounded one-line summary and the fullest readable body, without stringifying megabytes.
function readContent(value: unknown): { summary?: string | undefined; body?: string | undefined } {
  if (typeof value === 'string') return { summary: value, body: value }
  const record = asRecord(value)
  const preview = asString(record.preview)
  const inner = record.content
  let body: string | undefined
  if (typeof inner === 'string') body = inner
  else if (record.truncated === true) body = preview
  else if (inner !== undefined) {
    try { body = JSON.stringify(inner, null, 2) } catch { body = preview }
  }
  return { summary: preview ?? body, body: body ?? preview }
}

export function reduceAgentTranscript(events: ReadonlyArray<TranscriptEvent>): AgentDetailContent {
  let prompt: string | undefined
  let result: string | undefined
  let error: string | undefined
  const byId = new Map<string, AgentActivity>()
  const order: string[] = []

  for (const { event } of events) {
    const type = event.type
    const payload = asRecord(event.payload)
    if (type === 'agent.admitted') {
      const promptRef = readContent(payload.prompt)
      prompt = promptRef.body ?? promptRef.summary
    } else if (type === 'agent.activity.started') {
      const activity = asRecord(payload.activity)
      const id = asString(activity.activityId) ?? `activity_${order.length}`
      const kind = asString(activity.kind) ?? 'message'
      const title = asString(activity.title)
      const content = readContent(activity.content)
      const summary = (title ?? content.summary ?? kind).replace(/\s+/g, ' ').trim()
      const body = title !== undefined && content.body !== undefined && title !== content.body
        ? `${title}\n\n${content.body}`
        : (content.body ?? title ?? '')
      if (!byId.has(id)) order.push(id)
      byId.set(id, { activityId: id, kind, status: 'running', summary, content: body })
    } else if (type === 'agent.activity.completed') {
      const activity = asRecord(payload.activity)
      const id = asString(payload.activityId) ?? asString(activity.activityId)
      const existing = id === undefined ? undefined : byId.get(id)
      if (existing !== undefined) {
        const content = readContent(payload.content ?? activity.content)
        existing.status = payload.error !== undefined ? 'failed' : 'completed'
        if (content.body !== undefined && content.body.length > 0) existing.content = content.body
        if (content.summary !== undefined && existing.summary.length === 0) existing.summary = content.summary
      }
    } else if (type === 'agent.completed') {
      const resultRef = readContent(payload.result)
      result = resultRef.body ?? resultRef.summary
    } else if (type === 'agent.recovery_required' || type === 'agent.failed') {
      const err = asRecord(payload.error)
      error = asString(err.message) ?? asString(payload.message)
    }
  }

  return {
    ...(prompt === undefined ? {} : { prompt }),
    activities: order.map(id => byId.get(id)!),
    ...(result === undefined ? {} : { result }),
    ...(error === undefined ? {} : { error }),
  }
}

export function activityGlyph(activity: AgentActivity): string {
  if (activity.status === 'failed') return '✗'
  if (activity.status === 'running') return '◉'
  switch (activity.kind) {
    case 'command': return '$'
    case 'file_change': return '±'
    case 'web_search': return '⌕'
    case 'reasoning': return '∴'
    default: return '✓'
  }
}
