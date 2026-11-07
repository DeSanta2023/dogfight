# findex

A full-text search engine built step by step in a Python course (8 labs, one language feature
and one project step per lab). **Lab 1 — Streams, Not Lists:** stream a text corpus into
tokens and term statistics in constant memory, using the iteration protocol and generators.

## Quick start

```bash
uv sync                                   # create the environment, install dev tools
uv run pytest                             # run the tests
uv run ruff check .                       # lint

# get a corpus (see below), then:
uv run python -m findex.stats data/ --limit 100     # statistics for the first 100 documents
uv run python -m findex.stats data/                 # the whole corpus
uv run python -m findex.bench data/                 # eager vs lazy comparison table
```

## Corpus

The corpus lives in `data/`, which is **not committed** (it is in `.gitignore`).

**Source:** plain-text books from [Project Gutenberg](https://www.gutenberg.org/). Download them with:

```bash
uv run python scripts/download_gutenberg.py --count 100     # data/gutenberg/pg1.txt, pg2.txt, ...
```

Any directory of `.txt` files (searched recursively) or a `.jsonl` file (one JSON object with a
`"text"` field per line) works. For offline testing there is also a generator of a synthetic
Zipf-like corpus:

```bash
uv run python scripts/make_demo_corpus.py data/demo --docs 300 --words 20000
```

## Design

```
src/findex/
  corpus.py     iter_documents(root) -> Iterator[Document]   (generator, one document at a time)
  tokenize.py   tokenize(text)       -> Iterator[str]        (generator, re.finditer)
  stats.py      compute_stats(...)   one-pass pipeline, `python -m findex.stats`
  eager.py      the deliberately greedy version (for the measurement only)
  bench.py      eager-vs-lazy comparison, prints the table below
tests/          pytest tests for the tokenizer, corpus reader and stats
scripts/        corpus download / generation helpers
```

The pipeline is a chain of generators:

```
iter_documents  ->  tokenize  ->  Counter
(one file)         (one token)    (the only structure that grows: the term table)
```

`iter_documents` opens one file, yields it, and moves on; `Path.rglob` is lazy as well.
Files that are not valid UTF-8 are logged and re-read with `errors="replace"` instead of crashing.
`--limit N` is implemented with `itertools.islice`.

### Tokenizer rules

Every text goes through: NFC normalization → `casefold()` → `re.finditer`.

| Case | Rule | Example |
| --- | --- | --- |
| Letters | Any Unicode letter/digit (`\w` without `_`); Cyrillic works | `Привіт` → `привіт` |
| Case | `casefold()`, not `lower()` | `Straße`, `STRASSE` → `strasse` |
| Unicode forms | NFC, so `e` + combining accent equals `é` | `café` → `café` |
| Combining marks | Kept inside the word, even when no precomposed form exists | `сло́во` is one token |
| Apostrophes | Kept inside a word, `’` and `ʼ` unified to `'`; edge quotes dropped | `don’t` → `don't`, `п'ять` → `п'ять` |
| Hyphens | Split the word | `well-known` → `well`, `known` |
| Digits | Are tokens, may be glued to letters; `.`/`,` inside numbers split them | `mp3`, `42`, `3.14` → `3`, `14` |
| Underscore | Separator | `a_b` → `a`, `b` |

## Measurements: eager vs lazy

Both versions compute identical results (the benchmark asserts this). Peak memory is measured with
`tracemalloc`; elapsed time is measured in a separate run *without* `tracemalloc`, because
`tracemalloc` slows Python down several times over.

**Corpus for this table:** Project Gutenberg books with IDs 1-100 (98 of them were available):
98 documents, 10,129,416 tokens, 361,381 distinct terms. Python 3.13.16 on Windows (AMD64).

| Version           | Documents | Peak memory | Elapsed |
| ----------------- | --------- | ----------- | ------- |
| eager (lists)     | 98        | 634.9 MiB   | 15.41 s |
| lazy (generators) | 98        | 83.1 MiB    | 15.92 s |

The eager version needs about **7.6x more memory** for the same answer; the speed is about the same.

### Where did the memory go?

The eager version keeps everything alive at once. It first holds the full text of all 98 books in
one list, then tokenizes every book into its own list, so each of the 10 million tokens is a
separate `str` object (roughly 45-70 bytes each, even for a short word, plus 8 bytes for its slot
in the list; identical words are *not* shared). Most of the 635 MiB is these token objects, and
they all exist at the same moment, right before counting starts. Only after that does a `Counter`
shrink them to 361 thousand distinct terms: the answer that was needed in the end is tiny, but
the intermediate lists were huge.

The lazy version never holds more than one book plus the `Counter`. Each book and each token
becomes garbage as soon as it is counted, so memory does not depend on the number of books (only
on the largest book and on the size of the vocabulary). It is not zero for two reasons: the
`Counter` legitimately grows with the vocabulary, and one whole book must be in memory while it is
processed. The second part is bigger than the file size suggests. The peak was identical
(83.14 MiB) when the statistics were run on only the first 10 books, which suggests that it is set
by one large book processed early, not by the `Counter`. A text with any character outside
Latin-1 (for example a curly quote) is stored by Python with 2 bytes per character, and
`tokenize` holds several copies of the text at once (normalization, `casefold`, normalization
again). In a quick experiment, a 5.5 MiB file with a single curly apostrophe needed 88.5 MiB at
peak, versus 12.4 MiB for the same text without it.

Laziness saves memory, not time: both versions do the same regex and counting work, so the elapsed
time is about the same (15.4 s vs 15.9 s; the difference is noise).

## Tests

`uv run pytest` runs 20 tests: tokenizer rules (mixed case, Cyrillic, combining marks, apostrophes,
hyphens, digits, empty input), generator behaviour of `iter_documents` / `tokenize`, bad-encoding
handling, JSON-lines input, and the statistics pipeline.

## Course progress

- [x] Lab 1 — iterators, generators, the corpus (tag `lab-01`)
