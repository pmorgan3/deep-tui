# @flect/plugin-render-markdown

Adds safe CommonMark/GFM rendering for assistant messages. Fenced code asks the
active `TuiCodeHighlighter` contribution for tokens and falls back to plain
styled code when no highlighter supports the language.
