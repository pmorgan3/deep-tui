# Plan: conversation scrolling

## Outcome

Long transcripts can be navigated without losing the live tail. Mouse wheel,
Page Up/Down, Ctrl+U/Ctrl+D, Home, and End work consistently; new output does
not move a user who is reading older content. Viewport behavior and keybindings
remain replaceable Cordis contributions.

## Current constraint

`renderTuiFrame()` renders every transcript line and `rows(..., fromBottom)`
always selects the newest screenful. The shell has no transcript measurements,
`TuiState` has no viewport state, and `decodeKeys()` is stateless and does not
decode mouse or page-key sequences.

## Public contracts

Add these SDK concepts in `packages/sdk/src/types.ts`:

```ts
interface TuiViewportState {
  top: number
  follow: boolean
  unseen: number
}

interface TuiViewportMetrics {
  id: string
  top: number
  height: number
  total: number
  maxTop: number
}
```

Add `viewports: Readonly<Record<string, TuiViewportState>>` to `TuiState` and
the following generic methods to `TuiActions`:

```ts
scrollViewport(id: string, lines: number): void
pageViewport(id: string, pages: number): void
followViewport(id: string): void
```

These are generic rather than transcript-only so future tool-output, file,
diff, and picker components can use the same mechanism. The default shell owns
mutable state, but plugins own the bindings and can replace the visual slot.

Introduce `TuiFrameLayout` in `packages/plugin-ui-tui/src/frame.ts`:

```ts
interface TuiFrameLayout {
  output: string
  viewports: Readonly<Record<string, TuiViewportMetrics>>
}
```

Keep `renderTuiFrame()` as a compatibility wrapper returning only `output` and
add `layoutTuiFrame()` for the default shell. This avoids a needless breaking
change for plugins already using the renderer helper.

## Viewport semantics

- `top` is an absolute rendered-line offset from the beginning of a document.
- `follow: true` ignores stored `top` and uses `maxTop` on each frame.
- Scrolling upward sets `follow: false` and records the currently resolved top.
- Scrolling to `maxTop`, pressing End, clearing, or starting a new empty
  transcript sets `follow: true` and resets `unseen`.
- While not following, appended agent events leave `top` unchanged and
  increment `unseen` once per new visible event. The indicator says “N new
  events” rather than guessing at line counts before rich layout is complete.
- Resize clamps the effective top without discarding the user's requested
  position. If the resized viewport reaches the tail, it resumes following.
- Opening an overlay does not change the transcript viewport.

## Input work

Replace the internal one-chunk decoder with a buffered `TuiInputDecoder` in
`packages/plugin-ui-tui/src/ansi.ts`. Retain `decodeKeys()` as a stateless test
and compatibility helper.

Decode at minimum:

- Page Up/Down (`CSI 5~`, `CSI 6~`)
- Ctrl+U/Ctrl+D
- Home/End variants used by common terminals
- SGR mouse wheel up/down
- fragmented escape sequences split across input chunks

When `mouse: true`, the shell enables basic and SGR mouse tracking on entry and
disables both sequences in every exit/error path. Mouse coordinates are kept
in `TuiKeyEvent.mouse` for future plugins, even though the default scrolling
bindings initially need only wheel direction.

## Default plugin behavior

Add replaceable bindings in `packages/plugin-ui-tui/src/index.ts`:

- wheel up/down: 3 lines, configurable
- Ctrl+U/Ctrl+D: half a transcript page
- Page Up/Down: one page minus one context line
- Home: first transcript line when the composer is empty and no modal/menu is
  active
- End: follow the transcript tail under the same conditions

Permission modals, theme pickers, and slash autocomplete retain higher
priority. Plain Up/Down remain available to those interactions and are not
used for transcript scrolling.

The default status or transcript component shows `↑ N new events · End to
follow` while detached from the tail. This indicator is part of a replaceable
component, not hardcoded in the shell.

## File changes

- `packages/sdk/src/types.ts`: viewport state, metrics, mouse event, actions.
- `packages/plugin-ui-tui/src/ansi.ts`: buffered decoder and mouse sequences.
- `packages/plugin-ui-tui/src/frame.ts`: viewport-aware slicing and layout
  result.
- `packages/plugin-ui-tui/src/shell.ts`: metrics, actions, unseen accounting,
  mouse-mode cleanup.
- `packages/plugin-ui-tui/src/index.ts`: default navigation bindings/config.
- `packages/plugin-ui-tui/tests/tui.spec.ts`: contract and decoder tests.
- `packages/plugin-ui-tui/README.md` and root README: controls and overrides.

## Verification

Unit tests must cover exact top/maxTop calculations, clamping, half/full-page
movement, follow restoration, unseen reset, and zero/short documents. Decoder
tests feed every escape sequence both whole and split at every byte boundary.

A PTY integration test renders at least 100 numbered lines and asserts:

1. Page Up exposes older numbers.
2. A newly appended event does not move the detached viewport.
3. End restores the newest lines and clears the indicator.
4. Resize preserves a valid viewport.
5. Mouse modes and the alternate screen are disabled after normal exit,
   Ctrl+C, and a thrown render error.

## Acceptance criteria

- A user can navigate an arbitrarily long active transcript using keyboard and
  wheel controls.
- Reading position is stable as events arrive.
- Tail following is obvious and recoverable with one key.
- Another plugin can replace navigation bindings or the transcript component
  without editing the default shell.
- Existing slash, permission, theme-picker, and composer interactions do not
  regress.
