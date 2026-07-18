/* Ported from background.js's pure-logic matching/inflection engine (no chrome.* APIs). */

function cleanTerm(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 120);
}

function cleanSentence(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 1200);
}

function normalizeKey(value) {
  return normalizeTerm(value).key;
}

function normalizeTerm(value) {
  const display = String(value || "")
    .trim()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ");
  const key = display
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
  return { original: String(value || ""), display, key };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeWhitespace(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function mergeUniqueForms(...groups) {
  const seen = new Set();
  const out = [];
  for (const group of groups.flat()) {
    const form = cleanTerm(group);
    if (!form) continue;
    const key = normalizeTerm(form).key;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(form);
  }
  return out;
}

function createStats() {
  return {
    timesReviewed: 0,
    clozeCorrect: 0,
    clozeWrong: 0,
    copyCorrect: 0,
    copyWrong: 0,
    consecutiveCorrect: 0,
    lastReviewedAt: null,
    nextEncounterGap: 1,
    confidence: 0
  };
}

function findWholeTermMatch(sentence, form) {
  const value = cleanTerm(form);
  if (!value) return null;
  const pattern = `(^|[^\\p{L}\\p{M}])(${escapeRegex(value)})(?=$|[^\\p{L}\\p{M}'’])`;
  const match = String(sentence || "").match(new RegExp(pattern, "iu"));
  if (!match) return null;
  const start = (match.index || 0) + match[1].length;
  return { text: match[2], start, end: start + match[2].length };
}

function findWholeTermMatches(sentence, form) {
  const value = cleanTerm(form);
  if (!value) return [];

  const pattern = `(^|[^\\p{L}\\p{M}])(${escapeRegex(value)})(?=$|[^\\p{L}\\p{M}'’])`;
  const regex = new RegExp(pattern, "giu");
  const matches = [];
  let match;
  while ((match = regex.exec(String(sentence || "")))) {
    const start = (match.index || 0) + match[1].length;
    matches.push({ text: match[2], start, end: start + match[2].length });
    if (regex.lastIndex === match.index) regex.lastIndex += 1;
  }
  return matches;
}

function findAllWholeTermMatches(sentence, forms) {
  const candidates = mergeUniqueForms(forms).sort((a, b) => b.length - a.length);
  const matches = [];
  for (const form of candidates) {
    matches.push(...findWholeTermMatches(sentence, form));
  }
  return matches.sort((a, b) => a.start - b.start || b.text.length - a.text.length);
}

function findExactDictionaryMatch(sentence, forms) {
  const candidates = mergeUniqueForms(forms).sort((a, b) => b.length - a.length);
  for (const form of candidates) {
    const match = findWholeTermMatch(sentence, form);
    if (match) return match;
  }
  return null;
}

const FRENCH_CONSTRUCTION_TAIL_STARTERS = new Set(["à", "a", "de", "d'", "du", "des", "en", "sur", "avec", "pour", "dans", "par", "contre", "vers", "chez", "entre"]);
const FRENCH_CONSTRUCTION_MAX_GAP_TOKENS = 4;
const FRENCH_CONSTRUCTION_MAX_GAP_CHARS = 80;

const FRENCH_IRREGULAR_VERBS = {
  être: ["être", "suis", "es", "est", "sommes", "êtes", "sont", "étais", "était", "étions", "étiez", "étaient", "serai", "seras", "sera", "serons", "serez", "seront", "serais", "serait", "serions", "seriez", "seraient", "été"],
  avoir: ["avoir", "ai", "as", "a", "avons", "avez", "ont", "avais", "avait", "avions", "aviez", "avaient", "aurai", "auras", "aura", "aurons", "aurez", "auront", "aurais", "aurait", "aurions", "auriez", "auraient", "eu", "eue", "eus", "eues"],
  aller: ["aller", "vais", "vas", "va", "allons", "allez", "vont", "allais", "allait", "allions", "alliez", "allaient", "irai", "iras", "ira", "irons", "irez", "iront", "irais", "irait", "irions", "iriez", "iraient", "allé", "allée", "allés", "allées"],
  faire: ["faire", "fais", "fait", "faisons", "faites", "font", "faisais", "faisait", "faisions", "faisiez", "faisaient", "ferai", "feras", "fera", "ferons", "ferez", "feront", "ferais", "ferait", "ferions", "feriez", "feraient"],
  prendre: ["prendre", "prends", "prend", "prenons", "prenez", "prennent", "prenais", "prenait", "prenions", "preniez", "prenaient", "prendrai", "prendras", "prendra", "prendrons", "prendrez", "prendront", "pris", "prise", "prises"],
  mettre: ["mettre", "mets", "met", "mettons", "mettez", "mettent", "mettais", "mettait", "mettions", "mettiez", "mettaient", "mettrai", "mettras", "mettra", "mettrons", "mettrez", "mettront", "mis", "mise", "mises"],
  voir: ["voir", "vois", "voit", "voyons", "voyez", "voient", "voyais", "voyait", "voyions", "voyiez", "voyaient", "verrai", "verras", "verra", "verrons", "verrez", "verront", "vu", "vue", "vus", "vues"],
  pouvoir: ["pouvoir", "peux", "peut", "pouvons", "pouvez", "peuvent", "pouvais", "pouvait", "pouvions", "pouviez", "pouvaient", "pourrai", "pourras", "pourra", "pourrons", "pourrez", "pourront", "pu"],
  vouloir: ["vouloir", "veux", "veut", "voulons", "voulez", "veulent", "voulais", "voulait", "voulions", "vouliez", "voulaient", "voudrai", "voudras", "voudra", "voudrons", "voudrez", "voudront", "voulu", "voulue", "voulus", "voulues"],
  devoir: ["devoir", "dois", "doit", "devons", "devez", "doivent", "devais", "devait", "devions", "deviez", "devaient", "devrai", "devras", "devra", "devrons", "devrez", "devront", "dû", "due", "dus", "dues"],
  savoir: ["savoir", "sais", "sait", "savons", "savez", "savent", "savais", "savait", "savions", "saviez", "savaient", "saurai", "sauras", "saura", "saurons", "saurez", "sauront", "su", "sue", "sus", "sues"],
  venir: ["venir", "viens", "vient", "venons", "venez", "viennent", "venais", "venait", "venions", "veniez", "venaient", "viendrai", "viendras", "viendra", "viendrons", "viendrez", "viendront", "venu", "venue", "venus", "venues"],
  tenir: ["tenir", "tiens", "tient", "tenons", "tenez", "tiennent", "tenais", "tenait", "tenions", "teniez", "tenaient", "tiendrai", "tiendras", "tiendra", "tiendrons", "tiendrez", "tiendront", "tenu", "tenue", "tenus", "tenues"],
  dire: ["dire", "dis", "dit", "disons", "dites", "disent", "disais", "disait", "disions", "disiez", "disaient", "dirai", "diras", "dira", "dirons", "direz", "diront"],
  lire: ["lire", "lis", "lit", "lisons", "lisez", "lisent", "lisais", "lisait", "lisions", "lisiez", "lisaient", "lirai", "liras", "lira", "lirons", "lirez", "liront", "lu", "lue", "lus", "lues"],
  écrire: ["écrire", "écris", "écrit", "écrivons", "écrivez", "écrivent", "écrivais", "écrivait", "écrivions", "écriviez", "écrivaient", "écrirai", "écriras", "écrira", "écrirons", "écrirez", "écriront", "écrit", "écrite", "écrits", "écrites"],
  boire: ["boire", "bois", "boit", "buvons", "buvez", "boivent", "buvais", "buvait", "buvions", "buviez", "buvaient", "boirai", "boiras", "boira", "boirons", "boirez", "boiront", "bu", "bue", "bus", "bues"],
  croire: ["croire", "crois", "croit", "croyons", "croyez", "croient", "croyais", "croyait", "croyions", "croyiez", "croyaient", "croirai", "croiras", "croira", "croirons", "croirez", "croiront", "cru", "crue", "crus", "crues"],
  connaître: ["connaître", "connais", "connaît", "connaissons", "connaissez", "connaissent", "connaissais", "connaissait", "connaissions", "connaissiez", "connaissaient", "connaîtrai", "connaîtras", "connaîtra", "connaîtrons", "connaîtrez", "connaîtront", "connu", "connue", "connus", "connues"]
};

const FRENCH_IRREGULAR_FORM_TO_LEMMA = Object.fromEntries(
  Object.entries(FRENCH_IRREGULAR_VERBS).flatMap(([lemma, forms]) => forms.map(form => [form, lemma]))
);

function normalizeFrenchSurface(value) {
  return cleanTerm(value).toLowerCase().replace(/[’‘]/g, "'");
}

function addForms(forms, values) {
  for (const value of values) {
    const normalized = normalizeFrenchSurface(value);
    if (normalized) forms.add(normalized);
  }
}

function addRegularFrenchErForms(forms, stem) {
  addForms(forms, [
    `${stem}er`, `${stem}e`, `${stem}es`, `${stem}ons`, `${stem}ez`, `${stem}ent`,
    `${stem}ais`, `${stem}ait`, `${stem}ions`, `${stem}iez`, `${stem}aient`,
    `${stem}ai`, `${stem}as`, `${stem}a`, `${stem}âmes`, `${stem}âtes`, `${stem}èrent`,
    `${stem}erai`, `${stem}eras`, `${stem}era`, `${stem}erons`, `${stem}erez`, `${stem}eront`,
    `${stem}erais`, `${stem}erait`, `${stem}erions`, `${stem}eriez`, `${stem}eraient`,
    `${stem}ant`, `${stem}é`, `${stem}ée`, `${stem}és`, `${stem}ées`
  ]);
}

function addRegularFrenchIrForms(forms, stem) {
  addForms(forms, [
    `${stem}ir`, `${stem}is`, `${stem}it`, `${stem}issons`, `${stem}issez`, `${stem}issent`,
    `${stem}issais`, `${stem}issait`, `${stem}issions`, `${stem}issiez`, `${stem}issaient`,
    `${stem}irai`, `${stem}iras`, `${stem}ira`, `${stem}irons`, `${stem}irez`, `${stem}iront`,
    `${stem}irais`, `${stem}irait`, `${stem}irions`, `${stem}iriez`, `${stem}iraient`,
    `${stem}issant`, `${stem}i`, `${stem}ie`, `${stem}ies`
  ]);
}

function addRegularFrenchReForms(forms, stem) {
  addForms(forms, [
    `${stem}re`, `${stem}s`, stem, `${stem}ons`, `${stem}ez`, `${stem}ent`,
    `${stem}ais`, `${stem}ait`, `${stem}ions`, `${stem}iez`, `${stem}aient`,
    `${stem}rai`, `${stem}ras`, `${stem}ra`, `${stem}rons`, `${stem}rez`, `${stem}ront`,
    `${stem}rais`, `${stem}rait`, `${stem}rions`, `${stem}riez`, `${stem}raient`,
    `${stem}ant`, `${stem}u`, `${stem}ue`, `${stem}us`, `${stem}ues`
  ]);
}

function addFrenchVerbLemmaForms(forms, lemma) {
  if (FRENCH_IRREGULAR_VERBS[lemma]) {
    for (const form of FRENCH_IRREGULAR_VERBS[lemma]) forms.add(form);
    return;
  }

  if (lemma.endsWith("er")) {
    addRegularFrenchErForms(forms, lemma.slice(0, -2));
    return;
  }

  if (lemma.endsWith("ir")) {
    addRegularFrenchIrForms(forms, lemma.slice(0, -2));
    return;
  }

  if (lemma.endsWith("re")) {
    addRegularFrenchReForms(forms, lemma.slice(0, -2));
  }
}

function addLemmaCandidatesFromEndings(lemmas, surface, endings) {
  for (const [ending, infinitiveEnding] of endings) {
    if (ending && !surface.endsWith(ending)) continue;
    if (!ending && surface.length < 3) continue;
    const stem = ending ? surface.slice(0, -ending.length) : surface;
    if (stem.length >= 2) lemmas.add(`${stem}${infinitiveEnding}`);
  }
}

function addRegularFrenchErLemmaCandidates(lemmas, surface) {
  const endings = [
    ["ent", "er"], ["es", "er"], ["e", "er"], ["ons", "er"], ["ez", "er"],
    ["ais", "er"], ["ait", "er"], ["ions", "er"], ["iez", "er"], ["aient", "er"],
    ["ai", "er"], ["as", "er"], ["a", "er"], ["âmes", "er"], ["âtes", "er"], ["èrent", "er"],
    ["erai", "er"], ["eras", "er"], ["era", "er"], ["erons", "er"], ["erez", "er"], ["eront", "er"],
    ["erais", "er"], ["erait", "er"], ["erions", "er"], ["eriez", "er"], ["eraient", "er"],
    ["ant", "er"], ["é", "er"], ["ée", "er"], ["és", "er"], ["ées", "er"]
  ];
  addLemmaCandidatesFromEndings(lemmas, surface, endings);
}

function addRegularFrenchIrLemmaCandidates(lemmas, surface) {
  const endings = [
    ["issent", "ir"], ["issez", "ir"], ["issons", "ir"], ["is", "ir"], ["it", "ir"],
    ["issais", "ir"], ["issait", "ir"], ["issions", "ir"], ["issiez", "ir"], ["issaient", "ir"],
    ["irai", "ir"], ["iras", "ir"], ["ira", "ir"], ["irons", "ir"], ["irez", "ir"], ["iront", "ir"],
    ["irais", "ir"], ["irait", "ir"], ["irions", "ir"], ["iriez", "ir"], ["iraient", "ir"],
    ["issant", "ir"], ["i", "ir"], ["ie", "ir"], ["is", "ir"], ["ies", "ir"]
  ];
  addLemmaCandidatesFromEndings(lemmas, surface, endings);
}

function addRegularFrenchReLemmaCandidates(lemmas, surface) {
  const endings = [
    ["ent", "re"], ["s", "re"], ["", "re"], ["ons", "re"], ["ez", "re"],
    ["ais", "re"], ["ait", "re"], ["ions", "re"], ["iez", "re"], ["aient", "re"],
    ["rai", "re"], ["ras", "re"], ["ra", "re"], ["rons", "re"], ["rez", "re"], ["ront", "re"],
    ["rais", "re"], ["rait", "re"], ["rions", "re"], ["riez", "re"], ["raient", "re"],
    ["ant", "re"], ["u", "re"], ["ue", "re"], ["us", "re"], ["ues", "re"]
  ];
  addLemmaCandidatesFromEndings(lemmas, surface, endings);
}

function inferFrenchVerbLemmas(surface) {
  const lemmas = new Set();
  const irregularLemma = FRENCH_IRREGULAR_FORM_TO_LEMMA[surface];
  if (irregularLemma) lemmas.add(irregularLemma);

  if (surface.endsWith("er") || surface.endsWith("ir") || surface.endsWith("re")) {
    lemmas.add(surface);
  }

  addRegularFrenchErLemmaCandidates(lemmas, surface);
  addRegularFrenchIrLemmaCandidates(lemmas, surface);
  addRegularFrenchReLemmaCandidates(lemmas, surface);
  return [...lemmas];
}

function inferFrenchVerbForms(word) {
  const surface = normalizeFrenchSurface(word);
  if (!surface) return [];

  const forms = new Set([surface]);
  for (const lemma of inferFrenchVerbLemmas(surface)) {
    addFrenchVerbLemmaForms(forms, lemma);
  }
  return [...forms];
}

function addFrenchGenderForms(forms, form) {
  if (form.endsWith("e")) {
    forms.add(form.slice(0, -1));
  } else {
    forms.add(`${form}e`);
  }

  const suffixPairs = [
    ["eux", "euse"],
    ["eur", "euse"],
    ["teur", "trice"],
    ["if", "ive"],
    ["el", "elle"],
    ["eil", "eille"],
    ["en", "enne"],
    ["on", "onne"],
    ["et", "ette"],
    ["er", "ère"],
    ["f", "ve"],
    ["c", "que"]
  ];

  for (const [masculine, feminine] of suffixPairs) {
    if (form.endsWith(masculine)) forms.add(`${form.slice(0, -masculine.length)}${feminine}`);
    if (form.endsWith(feminine)) forms.add(`${form.slice(0, -feminine.length)}${masculine}`);
  }
}

function addFrenchNumberForms(forms, form) {
  if (form.endsWith("s") || form.endsWith("x") || form.endsWith("z")) {
    forms.add(form.slice(0, -1));
  } else if (form.endsWith("al")) {
    forms.add(`${form.slice(0, -2)}aux`);
  } else if (form.endsWith("ail")) {
    forms.add(`${form.slice(0, -3)}aux`);
    forms.add(`${form}s`);
  } else if (form.endsWith("au") || form.endsWith("eu") || form.endsWith("eau")) {
    forms.add(`${form}x`);
  } else {
    forms.add(`${form}s`);
  }

  if (form.endsWith("aux")) forms.add(`${form.slice(0, -3)}al`);
  if (form.endsWith("eaux")) forms.add(form.slice(0, -1));
}

function inferFrenchNominalForms(word) {
  const form = normalizeFrenchSurface(word);
  if (!form) return [];

  const forms = new Set([form]);
  addFrenchNumberForms(forms, form);
  addFrenchGenderForms(forms, form);

  for (const derived of [...forms]) {
    addFrenchNumberForms(forms, derived);
    addFrenchGenderForms(forms, derived);
  }

  return [...forms];
}

function splitFrenchPhraseHead(value) {
  const phrase = cleanTerm(value);
  if (!phrase) return null;

  const parts = phrase.match(/^(\p{L}[\p{L}\p{M}'’\-]*)(.*)$/u);
  if (!parts) return null;
  return { head: parts[1], tail: parts[2] || "" };
}

function withFrenchPhraseTail(forms, tail) {
  return mergeUniqueForms(forms.map(form => `${form}${tail || ""}`));
}

function inferFrenchNominalPhraseForms(value) {
  const parts = splitFrenchPhraseHead(value);
  if (!parts) return [];

  const headForms = inferFrenchNominalForms(parts.head);
  return withFrenchPhraseTail(headForms, parts.tail);
}

function inferFrenchVerbPhraseInflections(value) {
  const parts = splitFrenchPhraseHead(value);
  if (!parts) return [];

  const headForms = inferFrenchVerbForms(parts.head);
  return withFrenchPhraseTail(headForms, parts.tail);
}

function lookupIndexedFrenchForms(normalizedTerm) {
  const index = window.FR_LEXICON_INDEX;
  if (!index) return [];

  const key = normalizeFrenchSurface(normalizedTerm.display);
  const lemmas = new Set(index.byForm?.[key] || []);
  if (index.byLemma?.[key]) lemmas.add(key);

  const forms = [];
  for (const lemma of lemmas) {
    forms.push(lemma, ...(index.byLemma?.[lemma] || []));
  }
  return mergeUniqueForms(forms);
}

function lookupWiktionaryForms(normalizedTerm) {
  // Adapter seam for a future Wiktionary/Wiktextract dataset or backend API.
  // This local fallback models Wiktionary-style lemma/form expansion for
  // common French noun/adjective gender and number variants.
  return inferFrenchNominalPhraseForms(normalizedTerm.display);
}

function lookupUnimorphInflections(normalizedTerm) {
  // Adapter seam for a future UniMorph dataset or backend API. This local
  // fallback covers common French finite verb and participle variants while
  // preserving phrase tails, e.g. "aboutissent à" -> "aboutit à".
  const indexedForms = lookupIndexedFrenchForms(normalizedTerm);
  if (indexedForms.length) return indexedForms;
  return inferFrenchVerbPhraseInflections(normalizedTerm.display);
}

function isFrenchConstructionTail(tail) {
  if (!tail) return false;
  const words = tail.match(/[\p{L}\p{M}'’\-]+/gu) || [];
  if (!words.length || words.length > 3) return false;

  const first = normalizeFrenchSurface(words[0]);
  return FRENCH_CONSTRUCTION_TAIL_STARTERS.has(first);
}

function extractFrenchConstructionHeads(forms, tail) {
  const heads = [];
  for (const form of forms || []) {
    const value = cleanTerm(form);
    if (!value.toLowerCase().endsWith(tail.toLowerCase())) continue;
    const head = cleanTerm(value.slice(0, -tail.length));
    if (head) heads.push(head);
  }
  return heads;
}

function buildFrenchConstruction(term, lexicalEntry) {
  const parts = splitFrenchPhraseHead(term);
  if (!parts) return null;

  const tail = cleanTerm(parts.tail);
  if (!isFrenchConstructionTail(tail)) return null;

  const headForms = mergeUniqueForms([
    parts.head,
    ...inferFrenchVerbForms(parts.head),
    ...extractFrenchConstructionHeads(lexicalEntry.unimorphForms || [], tail)
  ]);

  if (!headForms.length) return null;
  return { headForms, tail };
}

function findNearbyConstructionTail(sentence, fromIndex, tail) {
  const after = String(sentence || "").slice(fromIndex);
  const tailMatch = findWholeTermMatch(after, tail);
  if (!tailMatch) return null;

  const gap = after.slice(0, tailMatch.start);
  if (gap.length > FRENCH_CONSTRUCTION_MAX_GAP_CHARS) return null;

  const gapWords = gap.match(/[\p{L}\p{M}'’\-]+/gu) || [];
  if (gapWords.length > FRENCH_CONSTRUCTION_MAX_GAP_TOKENS) return null;

  return {
    start: fromIndex + tailMatch.start,
    end: fromIndex + tailMatch.end,
    text: tailMatch.text
  };
}

function findFrenchConstructionMatch(sentence, term, lexicalEntry) {
  const construction = buildFrenchConstruction(term, lexicalEntry);
  if (!construction) return null;

  const headMatches = findAllWholeTermMatches(sentence, construction.headForms);
  for (const headMatch of headMatches) {
    const tailMatch = findNearbyConstructionTail(sentence, headMatch.end, construction.tail);
    if (tailMatch) {
      return {
        ...headMatch,
        construction: {
          tail: construction.tail,
          tailStart: tailMatch.start,
          tailEnd: tailMatch.end
        }
      };
    }
  }

  return null;
}

function createLanguageAdapter(lang) {
  return {
    lang,
    lookup({ term, sentence, lexicalEntry }) {
      const normalizedTerm = normalizeTerm(term);
      const exact = findExactDictionaryMatch(sentence, [term, ...(lexicalEntry.forms || [])]);
      if (exact) return { match: exact, source: "exact-dictionary", normalizedTerm };

      const wiktionary = findExactDictionaryMatch(sentence, lexicalEntry.wiktionaryForms || []);
      if (wiktionary) return { match: wiktionary, source: "wiktionary-wiktextract", normalizedTerm };

      const unimorph = findExactDictionaryMatch(sentence, lexicalEntry.unimorphForms || []);
      if (unimorph) return { match: unimorph, source: "unimorph", normalizedTerm };

      const construction = findFrenchConstructionMatch(sentence, term, lexicalEntry);
      if (construction) return { match: construction, source: "unimorph-construction", normalizedTerm };

      return { match: null, source: "none", normalizedTerm };
    }
  };
}

async function resolveLexicalEntry(term) {
  const normalizedTerm = normalizeTerm(term);
  const dictionaryForms = [term, normalizedTerm.display].filter(Boolean);
  const wiktionaryForms = lookupWiktionaryForms(normalizedTerm);
  const unimorphForms = lookupUnimorphInflections(normalizedTerm);
  return {
    lemma: term,
    normalized: normalizedTerm,
    forms: mergeUniqueForms(dictionaryForms),
    wiktionaryForms,
    unimorphForms,
    allForms: mergeUniqueForms(dictionaryForms, wiktionaryForms, unimorphForms),
    lookupOrder: ["exact-dictionary", "wiktionary-wiktextract", "unimorph"]
  };
}

async function matchVocabTermInSentence(payload) {
  const term = cleanTerm(payload.term || "");
  const sentence = cleanSentence(payload.sentence || "");
  const manualForms = Array.isArray(payload.forms) ? payload.forms : [];
  const storedEntry = payload.lexicalEntry && typeof payload.lexicalEntry === "object" ? payload.lexicalEntry : null;
  if (!term || !sentence) return { ok: false, error: "Missing term or sentence." };

  const lexicalEntry = storedEntry || await resolveLexicalEntry(term);
  const adapter = createLanguageAdapter(payload.lang || "");
  const result = adapter.lookup({
    term,
    sentence,
    lexicalEntry: { ...lexicalEntry, forms: mergeUniqueForms(lexicalEntry.forms, manualForms) }
  });

  return { ok: true, ...result, lexicalEntry };
}

async function createVocabTermRecord(payload) {
  const term = cleanTerm(payload.term || "");
  if (!term) return { ok: false, error: "Missing term." };

  const now = new Date().toISOString();
  const normalizedTerm = normalizeTerm(term);
  const vocabTerms = await window.sync.getVocabTerms();

  if (vocabTerms[normalizedTerm.key]) {
    return { ok: false, error: `"${vocabTerms[normalizedTerm.key].term}" already exists.`, key: normalizedTerm.key };
  }

  const lexicalEntry = await resolveLexicalEntry(term);
  vocabTerms[normalizedTerm.key] = {
    term,
    normalized: normalizedTerm.key,
    normalization: normalizedTerm,
    lexicalEntry,
    createdAt: now,
    updatedAt: now,
    status: "new",
    selectedByUser: true,
    forms: lexicalEntry.forms,
    stats: createStats(),
    sentences: []
  };

  await window.sync.setVocabTerms(vocabTerms);
  return { ok: true, key: normalizedTerm.key, term, lexicalEntry };
}

window.lexicon = { matchVocabTermInSentence, createVocabTermRecord, resolveLexicalEntry };
