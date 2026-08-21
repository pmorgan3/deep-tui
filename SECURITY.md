# Security policy

This project is pre-alpha. No release line is currently eligible for long-term
security support.

Do not open public issues for suspected vulnerabilities. Once the public
repository is created, use GitHub's private vulnerability reporting feature.

Plugins execute as trusted code with the privileges of the harness process.
Tool permission prompts protect against model-initiated actions; they are not a
plugin sandbox. Only install plugins whose source and publisher you trust.
