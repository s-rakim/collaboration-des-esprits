# The room, in Python

A port of Collaboration des Esprits, with one change of substance: it does not
talk to model providers itself. Everything it needs from outside — a model that
talks, a voice, an ear, a picture — goes to **My Claude Code**, which stands in
front of whatever providers you have given it.

That removes the part of this app that was never really its own job. There are
no provider presets here, no base-URL prober, no per-provider key handling, and
no table of which service wants its voice in the path and which in the body.
MCC does that, and does it better. The room asks one address.

**Nothing here stores an API key.** They live in MCC's dashboard, where it can
validate and rotate them.

## The web UI is not rewritten

`src/web/` is served byte-identical from this server. The pages, the rail, the
composer, the theme — all the same files the Node app serves. A port that
redrew the screen would be a different app wearing its clothes.

## One database, two runtimes

Both open the same SQLite file, and the schema lives in `sql/` rather than in
either of them, so the two cannot drift apart. A room written by one opens in
the other with its history intact.
