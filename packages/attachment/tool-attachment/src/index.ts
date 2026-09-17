/**
 * Model-facing `attachment_paths` tool: absolute host paths for the images and
 * files attached to the user's most recent attachment-carrying message, so
 * path-based tools (image editors, readers, shell commands) can use them.
 * @module @deepseek-ai/dsh-tool-attachment
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore, FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-attachment'
export const inject = ['tools']

const DESCRIPTION =
  'Return absolute host paths for the images and files attached to the user\'s most recent message '
  + 'that carries attachments. Call this when the user attached an image and a path-based tool needs '
  + 'it (image editing, reading, shell commands). The returned paths are read-only stored copies; '
  + 'pass one directly to a tool that reads files. Attached non-image files already carry their saved '
  + 'path in the conversation, so this tool is mainly how you get a path for an attached image.'

/** One attachment occurrence resolved for the model. */
interface AttachmentPathEntry {
  readonly kind: string
  /** Absolute host path of the stored copy; absent when the backend is not host-file-backed. */
  readonly path?: string
  readonly name?: string
  readonly mediaType?: string
  readonly bytes: number
  readonly width?: number
  readonly height?: number
}

/** Canonical `attachment_paths` output. */
interface AttachmentPathsValue {
  /** Log sequence of the source message; absent when no human message carries attachments. */
  readonly seq?: number
  readonly attachments: readonly AttachmentPathEntry[]
}

/** Attachment parts of one message, narrowed from the model-facing content union. */
type AttachmentPart =
  | { readonly kind: 'image'; readonly attachment: ImageAttachmentRef }
  | { readonly kind: 'file'; readonly attachment: FileAttachmentRef }

/**
 * Narrow one content block to an attachment-bearing image or file part.
 * @param block - model-facing content block.
 * @returns the narrowed part, or undefined for every other block type.
 */
function attachmentPart(block: ContentBlock): AttachmentPart | undefined {
  if (block.type === 'image') return { kind: 'image', attachment: block.attachment }
  if (block.type === 'file') return { kind: 'file', attachment: block.attachment }
  return undefined
}

/**
 * Find the most recent human message that carries attachments.
 * @param session - the calling agent's session.
 * @returns the message sequence and its attachment parts, or undefined when none exists.
 */
function latestAttachmentMessage(
  session: Session,
): { seq: SessionSeq; parts: readonly AttachmentPart[] } | undefined {
  const nodes = session.surface.nodes
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const seq = nodes[index]
    if (seq === undefined) continue
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message' || event.data.source.kind !== 'user') continue
    const parts = event.data.content.flatMap((block) => {
      const part = attachmentPart(block)
      return part === undefined ? [] : [part]
    })
    if (parts.length > 0) return { seq, parts }
  }
  return undefined
}

/**
 * Resolve one attachment occurrence to its host path and display metadata.
 * @param store - mounted durable attachment store.
 * @param part - narrowed attachment part.
 * @returns the model-facing entry.
 */
function resolveEntry(store: AttachmentStore, part: AttachmentPart): AttachmentPathEntry {
  if (part.kind === 'image') {
    const ref = part.attachment
    const path = store.imageHostPath(ref)
    return {
      kind: 'image',
      ...(path === undefined ? {} : { path }),
      ...(ref.name === undefined ? {} : { name: ref.name }),
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
    }
  }
  const ref = part.attachment
  const path = store.fileHostPath(ref)
  return {
    kind: 'file',
    ...(path === undefined ? {} : { path }),
    name: ref.name,
    bytes: ref.bytes,
  }
}

/**
 * Model-facing text for one resolved result.
 * @param value - canonical tool value.
 * @returns one header line, one line per attachment, and the read-only note.
 */
function renderAttachmentPaths(value: AttachmentPathsValue): string {
  if (value.attachments.length === 0) {
    return 'No attachments found in the recent user messages.'
  }
  const lines = value.attachments.map((entry) => {
    const label = `${entry.kind}${entry.name === undefined ? '' : ` "${entry.name}"`}`
    if (entry.path === undefined) {
      return `- ${label}: no host path is available in this deployment`
    }
    const details = [
      entry.width !== undefined && entry.height !== undefined ? `${entry.width}x${entry.height}px` : undefined,
      entry.mediaType,
      `${entry.bytes} bytes`,
    ].filter((detail): detail is string => detail !== undefined).join(', ')
    return `- ${label}: ${JSON.stringify(entry.path)} (${details})`
  })
  return [
    'Attachments from the most recent user message that carries them:',
    ...lines,
    'Read-only stored copies; pass a path to a tool that reads files.',
  ].join('\n')
}

/**
 * Register `attachment_paths` while the durable attachment store is mounted.
 * Without that store there are no host-backed attachments to resolve, so the
 * plugin loads but registers nothing (the read_image registration pattern).
 * @param ctx - plugin context providing the tool registry.
 */
export function apply(ctx: Context): void {
  ctx.inject(['attachments'], (storeCtx) => {
    storeCtx.tools.register(defineTool({
      name: 'attachment_paths',
      description: DESCRIPTION,
      parameters: {},
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            seq: { type: 'integer' },
            attachments: {
              type: 'array', required: true,
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true },
                  path: { type: 'string' },
                  name: { type: 'string' },
                  mediaType: { type: 'string' },
                  bytes: { type: 'integer', required: true },
                  width: { type: 'integer' },
                  height: { type: 'integer' },
                },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderAttachmentPaths(value) }],
      },
      async execute(_args, exec) {
        const session = exec.agent?.session
        if (session === undefined) throw new Error('attachment_paths requires an agent Session')
        const found = latestAttachmentMessage(session)
        if (found === undefined) return { attachments: [] }
        return {
          seq: found.seq,
          attachments: found.parts.map(part => resolveEntry(storeCtx.attachments, part)),
        }
      },
    }))
  })
}
