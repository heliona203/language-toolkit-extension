# French lexicon datasets

The extension can use a packaged French lexical index at `data/fr-lexicon-index.js`.
At runtime, `background.js` loads that file and checks it before falling back to the
older local French verb heuristics.

## Current checked-in data

`data/fr-lexicon-index.js` is intentionally empty. It exists only so the service
worker can load a stable file path. Generate it locally when you want real French
inflection coverage.

## Download the French UniMorph TSV

The French UniMorph data lives in the `unimorph/fra` GitHub repository:

```text
https://github.com/unimorph/fra
```

The TSV file used by this repo's generator is the repository file named `fra`.
You can download it directly with `curl`:

```sh
mkdir -p vendor/unimorph
curl -L https://raw.githubusercontent.com/unimorph/fra/master/fra -o vendor/unimorph/fra
```

Or, if you prefer cloning the whole repository:

```sh
mkdir -p vendor/unimorph
git clone --depth 1 https://github.com/unimorph/fra.git vendor/unimorph/fra-repo
```

If you clone the repository, use `vendor/unimorph/fra-repo/fra` as the input path
in the generation command below.

## Generate the packaged index

For the direct `curl` download path:

```sh
node scripts/build-fr-lexicon.mjs --unimorph vendor/unimorph/fra --out data/fr-lexicon-index.js
```

For the cloned repository path:

```sh
node scripts/build-fr-lexicon.mjs --unimorph vendor/unimorph/fra-repo/fra --out data/fr-lexicon-index.js
```

Then reload the unpacked extension in Chrome so the Manifest V3 service worker
picks up the regenerated `data/fr-lexicon-index.js` file.

## Adding Wiktextract later

Wiktextract/Kaikki data can be merged into the same generated index later. Keep
UniMorph as the first dataset for French verbs, because it directly provides the
lemma-to-inflected-form rows needed for cloze matching.
