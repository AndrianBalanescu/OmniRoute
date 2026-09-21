#!/usr/bin/env bash
# Spec artifact integrity check for the PB rewrite plan
SPEC="_tasks/superpowers/specs/2026-09-01-pocketbase-vue3-rewrite-architecture.md"
AUDIT="_tasks/research/2026-08-31_omniroute-architecture-audit.md"
test -s "$SPEC" && echo "OK spec exists $(wc -l < "$SPEC") lines" || echo "MISSING spec"
test -s "$AUDIT" && echo "OK audit exists $(wc -l < "$AUDIT") lines" || echo "MISSING audit"
grep -q "## 8. Honest Limitations" "$SPEC" && echo "OK limitations section present"
grep -q "router.Event" "$SPEC" && echo "OK streaming verification present"
