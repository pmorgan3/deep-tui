import type { Context } from 'cordis'
import type { PhrasingContent, Root, RootContent } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { RichTextLine, RichTextSpan, TuiRenderContext } from '@flect/sdk'

export interface MarkdownRendererConfig {
  gfm?: boolean
  showLinkTargets?: boolean
  codeLineNumbers?: boolean
  codeWrap?: boolean
  maxTableColumns?: number
  maxCacheEntries?: number
}

function sanitize(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
}

function tone(ctx: TuiRenderContext, name: 'foreground' | 'muted' | 'accent' | 'success' | 'warning' | 'background') {
  return ctx.theme.tokens.colors[name]
}

function inline(nodes: readonly PhrasingContent[], ctx: TuiRenderContext, config: MarkdownRendererConfig): RichTextSpan[] {
  const output: RichTextSpan[] = []
  const visit = (node: PhrasingContent, inherited: RichTextSpan['style'] = {}) => {
    if (node.type === 'text') output.push({ text: node.value, style: inherited })
    else if (node.type === 'inlineCode') {
      const highlight = ctx.theme.tokens.colors.inlineCode
      output.push({ text: node.value, style: {
        ...inherited, foreground: highlight ? tone(ctx, 'background') : tone(ctx, 'accent'),
        background: highlight ?? tone(ctx, 'muted'), bold: true,
      } })
    } else if (node.type === 'break') output.push({ text: '\n', style: inherited })
    else if (node.type === 'strong') for (const child of node.children) visit(child, { ...inherited, bold: true })
    else if (node.type === 'emphasis') for (const child of node.children) visit(child, { ...inherited, italic: true })
    else if (node.type === 'delete') for (const child of node.children) visit(child, { ...inherited, dim: true })
    else if (node.type === 'link') {
      for (const child of node.children) visit(child, { ...inherited, foreground: tone(ctx, 'accent'), underline: true })
      if (config.showLinkTargets !== false) output.push({ text: ` (${node.url})`, style: { foreground: tone(ctx, 'muted') } })
    } else if (node.type === 'image') {
      output.push({ text: `[image: ${node.alt ?? node.url}]`, style: { foreground: tone(ctx, 'muted') } })
    } else if ('children' in node && Array.isArray(node.children)) {
      for (const child of node.children as PhrasingContent[]) visit(child, inherited)
    } else if ('value' in node && typeof node.value === 'string') output.push({ text: node.value, style: inherited })
  }
  for (const node of nodes) visit(node)
  return output
}

function prefix(lines: string[], value: string): string[] {
  return lines.map((line, index) => `${index === 0 ? value : ' '.repeat(value.length)}${line}`)
}

function withWidth(ctx: TuiRenderContext, width: number): TuiRenderContext {
  return width === ctx.width ? ctx : { ...ctx, width }
}

function renderNode(node: RootContent, ctx: TuiRenderContext, config: MarkdownRendererConfig): string[] {
  if (node.type === 'paragraph') {
    return ctx.renderRich([{ spans: inline(node.children, ctx, config) }], ctx.width)
  }
  if (node.type === 'heading') {
    const spans = inline(node.children, ctx, config).map(span => ({
      ...span,
      style: { ...span.style, foreground: tone(ctx, 'accent'), bold: true },
    }))
    return ['', ...ctx.renderRich([{ spans }], ctx.width)]
  }
  if (node.type === 'blockquote') {
    const inner = withWidth(ctx, Math.max(1, ctx.width - 2))
    const lines = node.children.flatMap(child => renderNode(child, inner, config))
    return lines.map(line => `${ctx.style('│', 'muted')} ${line}`)
  }
  if (node.type === 'list') {
    return node.children.flatMap((item, index) => {
      const marker = item.checked === true ? '[x] '
        : item.checked === false ? '[ ] '
          : node.ordered ? `${(node.start ?? 1) + index}. ` : '• '
      const inner = withWidth(ctx, Math.max(1, ctx.width - marker.length))
      const lines = item.children.flatMap(child => renderNode(child, inner, config))
      return prefix(lines, marker)
    })
  }
  if (node.type === 'code') return []
  if (node.type === 'thematicBreak') return [ctx.style('─'.repeat(Math.max(4, ctx.width - 4)), 'muted')]
  if (node.type === 'html') return ctx.wrap(node.value, ctx.width).map(line => ctx.style(line, 'muted'))
  if (node.type === 'table') {
    const limit = Math.max(1, config.maxTableColumns ?? 8)
    return node.children.map(row => row.children.slice(0, limit).map(cell => {
      const spans = inline(cell.children, ctx, config)
      return spans.map(span => span.text).join('')
    }).concat(row.children.length > limit ? ['[more columns]'] : []).join(' │ ')).flatMap(line => ctx.wrap(line, ctx.width))
  }
  return []
}

function codeLines(ctx: Context, node: Extract<RootContent, { type: 'code' }>, render: TuiRenderContext, config: MarkdownRendererConfig): string[] {
  const highlighted = ctx.tui.highlightCode(node.value, node.lang ?? undefined, render)
    ?? node.value.split('\n').map(text => ({ spans: [{ text, style: { foreground: tone(render, 'foreground') } }] }))
  const width = String(highlighted.length).length
  const lines: RichTextLine[] = highlighted.map((line, index) => ({
    spans: [
      ...(config.codeLineNumbers ? [{ text: `${String(index + 1).padStart(width)} │ `, style: { foreground: tone(render, 'muted') } }] : []),
      ...line.spans,
    ],
  }))
  const label = node.lang ? render.style(` ${node.lang} `, 'muted', true) : ''
  return ['', `  ${label}`, ...render.renderRich(lines, Math.max(8, render.width - 4)).map(line => `  ${line}`), '']
}

export const name = 'markdown-renderer'
export const inject = ['tui']

export function apply(ctx: Context, config: MarkdownRendererConfig = {}): void {
  interface CachedDocument {
    tree: Root
    renders: Array<{ signature: readonly unknown[]; lines: readonly string[] }>
  }
  const documents = new Map<string, CachedDocument>()
  const sameSignature = (left: readonly unknown[], right: readonly unknown[]) =>
    left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  const document = (source: string): CachedDocument => {
    const cached = documents.get(source)
    if (cached) {
      documents.delete(source)
      documents.set(source, cached)
      return cached
    }
    const tree = fromMarkdown(source, config.gfm === false ? {} : {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    })
    const created = { tree, renders: [] }
    documents.set(source, created)
    while (documents.size > Math.max(1, config.maxCacheEntries ?? 128)) {
      const oldest = documents.keys().next().value
      if (oldest === undefined) break
      documents.delete(oldest)
    }
    return created
  }
  ctx.tui.registerEventRenderer({
    id: 'flect.markdown.assistant',
    priority: 50,
    render(event, render) {
      if (event.type !== 'assistant' && event.type !== 'assistant-finish') return undefined
      const source = sanitize(event.text)
      try {
        const cached = document(source)
        const signature = [ctx.tui.revision, render.theme, render.width, render.color, render.phase ?? 'display']
        const existing = cached.renders.find(item => sameSignature(item.signature, signature))
        if (existing) return existing.lines
        const content = withWidth(render, Math.max(1, render.width - 2))
        const lines = cached.tree.children.flatMap(node => node.type === 'code'
          ? codeLines(ctx, node, render, config)
          : renderNode(node, content, config)).map(line => line ? `  ${line}` : '')
        cached.renders.push({ signature, lines })
        while (cached.renders.length > 4) cached.renders.shift()
        return lines
      } catch {
        return render.wrap(source, Math.max(1, render.width - 2)).map(line => `  ${line}`)
      }
    },
  })
}

export default { name, inject, apply }
