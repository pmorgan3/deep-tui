# @flect/plugin-audit-redact-default

Redacts common secret fields, terminal controls, and oversized audit values
before they reach persistent sinks.

It also fingerprints the project root, bounds depth/arrays/event bytes, handles
cycles, and drops bulk `content`, stdin, credential, cookie, and token fields.
