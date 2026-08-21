# @flect/plugin-highlight-shiki

Contributes TextMate-grammar syntax highlighting through Shiki. Themes are
generated from the active Flect theme's semantic syntax tokens.

Highlighted documents are retained in a bounded LRU so viewport changes and
interactive UI state do not repeatedly tokenize the same code. Set
`maxCacheEntries` to change the default limit of 512 entries.
