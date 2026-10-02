---
'@thaumic-cast/server': patch
---

feat(server): rewrite the help text, the startup lines and the configuration errors

`thaumic-server --help` and the lines the server prints as it starts and stops have been rewritten. Each flag now says
what it is for in the words the apps use (speaker head start, speaker monitoring, clock drift correction), and a
configuration error says which value is wrong and what it may be. Flag names, environment variables, config keys and
defaults are unchanged. The startup line that said manual speakers "will not persist" without a data directory now
says what actually happens: speakers cannot be added by IP address until one is set.
