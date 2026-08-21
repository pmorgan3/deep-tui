# Plan: Markdown rendering and syntax highlighting

## Outcome

Assistant messages render as safe CommonMark/GFM with headings, emphasis,
lists, quotes, links, tables, task lists, inline code, and fenced code blocks.
Code uses language-aware highlighting whose colors follow the active Flect
theme. Plain text, Markdown, and syntax highlighting are separate replaceable
contributions.

## Architectural split

Add two priority-ordered contribution types to the TUI service:

```ts
interface TuiEventRenderer {
  id: string
  priority?: number
  render(event: AgentEvent, context: TuiRenderContext): readonly string[] | undefined
}

interface TuiCodeHighlighter {
  id: string
  priority?: number
  highlight(code: string, language: string | undefined, context: TuiRenderContext):
    readonly RichTextLine[] | undefined
}
```

`undefined` means “not handled; try the next contribution.” Add reversible
`registerEventRenderer`, `listEventRenderers`, `renderEvent`,
`registerCodeHighlighter`, and `highlightCode` methods to `TuiService`.

Define renderer-neutral spans in the SDK:

```ts
interface RichTextStyle {
  foreground?: string
  background?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  dim?: boolean
}

interface RichTextSpan { text: string; style?: RichTextStyle; link?: string }
interface RichTextLine { spans: readonly RichTextSpan[] }
```

ANSI encoding and display-width wrapping stay in the TUI package. Event and
highlighter plugins return structured spans, preventing embedded escape codes
from bypassing width calculations or terminal sanitization.

## Packages

### `@flect/plugin-render-markdown`

- Parses assistant text with `mdast-util-from-markdown`.
- Enables GFM with `micromark-extension-gfm` and `mdast-util-gfm`.
- Registers a high-priority assistant `TuiEventRenderer`.
- Calls `ctx.tui.highlightCode()` for fenced blocks and falls back to a styled
  plain-code block when no highlighter supports the language.
- Configuration: `gfm`, `showLinkTargets`, `codeWrap`, `codeLineNumbers`,
  `maxTableColumns`, and bounded cache sizes.

The syntax-tree approach is deliberate: `mdast-util-from-markdown` provides a
typed CommonMark AST and official GFM extensions cover the syntax users expect
from coding responses. Raw HTML nodes are displayed as inert text in the TUI;
they are never executed or interpreted.

### `@flect/plugin-highlight-shiki`

- Uses Shiki's core token API with its JavaScript regex engine under Node 22+.
- Preloads a documented default language set: shell, C/C++, CSS, diff,
  Dockerfile, Go, HTML, Java, JavaScript/JSX, JSON, Markdown, Python, Rust, SQL,
  TypeScript/TSX, and YAML.
- Supports `languages` and aliases in plugin configuration.
- Unknown or failed grammars return `undefined` so Markdown falls back cleanly.
- Initializes before registering its synchronous contribution. No render path
  waits on network or dynamically downloads a grammar.

Pin the tested Shiki major in the lockfile. Use the core/token API rather than
HTML output so Flect retains control of ANSI encoding, backgrounds, width, and
theme hot-swaps.

## Theme integration

Extend `ThemeTokens` with an optional semantic syntax palette:

```ts
syntax?: Partial<Record<
  'comment' | 'keyword' | 'string' | 'number' | 'function' | 'type' |
  'variable' | 'operator' | 'punctuation' | 'constant' | 'property',
  string
>>
```

Update every first-party theme plugin with palette-native values. The Shiki
plugin builds a TextMate theme from these roles and falls back to existing
foreground/muted/accent/success/warning colors for missing roles. Cache keys
include theme ID and the effective syntax palette so `/theme` changes code
colors immediately without restarting.

An optional `colors.inlineCode` on a theme defines the background highlight for
inline (backtick) code. When present, inline code renders as theme-background
text on that highlight color; otherwise the renderer falls back to `accent`
text on a `muted` background.

## Rendering rules

- Strip C0/C1 terminal controls other than normalized newline and tab before
  parsing any model or tool text.
- Preserve paragraph spacing without trailing blank-line growth.
- Wrap prose by terminal display width while preserving span styles.
- Render headings with weight/accent, blockquotes with a muted bar, lists with
  indentation, task items with visible checked state, and thematic breaks with
  the muted token.
- Render inline code with a distinct background when the terminal supports
  color; otherwise use backticks.
- Render links as styled labels and optionally append the target once. OSC-8
  hyperlinks are a later opt-in contribution, not part of the safe baseline.
- Fit GFM tables to the viewport. Collapse to key/value rows when the table
  cannot retain a minimum cell width.
- Code wraps by default with a continuation marker. Horizontal code viewport
  support is explicitly out of scope for the first version.
- Malformed or incomplete Markdown must produce readable output, never throw
  out of the TUI render loop.

## Default TUI refactor

Move event-specific formatting out of `default.transcript` into low-priority
plain event renderers registered by `@flect/plugin-ui-tui`. The transcript
component becomes a coordinator that asks `tui.renderEvent()` for each event.
Unloading Markdown therefore reveals plain assistant rendering immediately;
unloading Shiki retains Markdown with plain code blocks.

Rendering remains synchronous. Cache parsed ASTs by message text and rendered
documents by text, width, color capability, active-theme revision, and
highlighter revision. Use bounded LRU caches and clear affected entries when a
contribution unloads.

## File changes

- `packages/sdk/src/types.ts`: rich spans, event/highlighter contributions,
  optional syntax tokens.
- `packages/sdk/src/services.ts`: layered registries and render dispatch.
- `packages/plugin-ui-tui/src/ansi.ts`: style-span encoding and styled wrapping.
- `packages/plugin-ui-tui/src/frame.ts`: coordinator-only transcript.
- `packages/plugin-ui-tui/src/index.ts`: plain fallback event renderers.
- New `packages/plugin-render-markdown` package and tests.
- New `packages/plugin-highlight-shiki` package and tests.
- All first-party theme packages: semantic syntax palettes.
- CLI starter config, root project references, workspace lockfile, READMEs.

## Verification

Use golden tests with color disabled for every supported Markdown block and
inline node, nested lists, wide Unicode, narrow widths, incomplete fences,
long unbroken strings, and raw escape injection. Add color-aware tests proving
that code token spans change after a live theme switch.

Lifecycle tests must show:

1. Markdown overrides plain assistant rendering.
2. Shiki overrides plain fenced-code rendering.
3. Unloading either contribution reveals its fallback without stale cache.
4. An unsupported language still renders its source exactly.
5. Repeated rendering is bounded in time and memory by cache limits.

## Acceptance criteria

- Typical LLM Markdown is visibly structured and correctly width-bounded.
- Common fenced languages receive syntax highlighting.
- Theme switching updates syntax colors live.
- `NO_COLOR` remains readable and contains no ANSI sequences.
- Untrusted text cannot inject terminal control sequences.
- Both Markdown and highlighting can be independently replaced or removed.

## Upstream references

- [mdast parser](https://github.com/syntax-tree/mdast-util-from-markdown)
- [GFM mdast extensions](https://github.com/syntax-tree/mdast-util-gfm)
- [CommonMark specification](https://spec.commonmark.org/)
- [Shiki](https://github.com/shikijs/shiki)
- [Shiki regex engines](https://shiki.style/guide/regex-engines)
