# @flect/plugin-usage-inline

Appends a compact usage line to every completed assistant response:

```text
↳ cost $0.000035 · tok in 100 · out 24 · cache 40
```

The TUI footer simultaneously shows the running session cost. Per-message
usage is stored with durable assistant records, so the
annotations return when a conversation is resumed. Set `inline: false` or
`footer: false` to enable only one surface; `costPrecision` accepts 2–10.

The visible label is simply “cost.” Token counts come from the provider
response and the amount uses the configured provider pricing. It is not
represented as a per-request invoice when the provider does not expose one.
