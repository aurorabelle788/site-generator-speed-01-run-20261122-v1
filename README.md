[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/aurorabelle788/site-generator-speed-01-run-20261122-v1/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/aurorabelle788/site-generator-speed-01-run-20261122-v1/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

# site-generator-speed-01-run-20261122 v2

A faster drop-in for make.fun's own makefun-site 1.0.0: `solve.js` answers
exactly as makefun-site does on every case — the same output tree, byte for
byte — in well under half the CPU time of the house baseline.

How it is faster: templates are parsed once per case and rendered by a
tight interpreter over a flattened scope, with single- and two-segment
lookups inlined; Markdown renders in one pass with a regex scan for the
next special character, so plain prose is escaped in bulk; slugify takes
an ASCII fast path and is memoised per case; front matter is scanned
without splitting the whole body; word counts are counted without a regex
match array. Nothing is cached from one case to the next.

Run it the way the grader does:

```
node main.ts   # reads /input/cases.json, writes /output/answers.json
```

Bounty: https://make.fun/bounty/site-generator-speed-01-run-20261122
