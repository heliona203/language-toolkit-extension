(() => {
  const DEFAULTS = {
    mode: "normal",
    lang: "fr-FR",
    lookupSourceLang: "en",
    lookupTargetLang: "fr",
    density: 12,
    minLength: 4,
    audioMode: "sentence",
    accentMode: "flexible",
    foreignLanguageDetection: true,
    userLevel: "B1"
  };

  let originalBodyHTML = null;
  let activeSettings = { ...DEFAULTS };
  let selectionMode = false;
  let floatingButton = null;
  let toast = null;
  let autoIconTimer = null;

  init();

  async function init() {
    activeSettings = await chrome.storage.sync.get(DEFAULTS);

    if (
      activeSettings.foreignLanguageDetection &&
      activeSettings.mode === "normal" &&
      isLikelyForeignLanguagePage(activeSettings.lang)
    ) {
      showFloatingButton({
        persistent: false,
        label: "Cloze this page",
        onClick: () => {
          hideFloatingButton();
          applyCloze(activeSettings, { includeUserSelections: false, includeExtra: true });
        }
      });
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "GET_SELECTED_TEXT") {
      sendResponse({ text: getSelectedText() });
      return;
    }

    if (message.type === "GET_SELECTED_SENTENCE_FOR_SAVE") {
      (async () => {
        const pending = await chrome.runtime.sendMessage({ type: "GET_PENDING_TERM" });
        sendResponse({
          term: pending?.term || "",
          sentence: getSelectedText(),
          sourceUrl: location.href,
          sourceTitle: document.title,
          sourceSite: getSourceSite()
        });
      })();
      return true;
    }

    if (message.type === "ACTIVATE_PAGE") {
      activeSettings = { ...DEFAULTS, ...(message.settings || {}) };
      activatePage(activeSettings);
    }

    if (message.type === "MAKE_CLOZE_NOW") {
      activeSettings = { ...DEFAULTS, ...(message.settings || {}) };
      makeClozeFromCurrentState(activeSettings);
    }

    if (message.type === "CLEAR_CLOZE") {
      clearCloze();
    }
  });

  function activatePage(settings) {
    if (settings.mode === "normal") {
      applyCloze(settings, { includeUserSelections: false, includeExtra: true });
      return;
    }

    startSelectionMode(settings);

    showFloatingButton({
      persistent: true,
      label: settings.mode === "userDriven"
        ? "Create cloze from selected words + level-relevant extras"
        : "Create cloze from selected words only",
      onClick: () => makeClozeFromCurrentState(settings)
    });
  }

  function makeClozeFromCurrentState(settings) {
    if (settings.mode === "normal") {
      applyCloze(settings, { includeUserSelections: false, includeExtra: true });
      return;
    }

    const includeExtra = settings.mode === "userDriven";
    applyCloze(settings, {
      includeUserSelections: true,
      includeExtra
    });
  }

  function startSelectionMode(settings) {
    if (!originalBodyHTML) {
      originalBodyHTML = document.body.innerHTML;
    }

    selectionMode = true;
    wrapWordsForSelection(settings);
    showToast("Click words you want tested. Click the bottom-right icon when ready.");
  }

  function wrapWordsForSelection(settings) {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;

          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;

          const blockedTags = new Set([
            "SCRIPT", "STYLE", "TEXTAREA", "INPUT", "SELECT",
            "OPTION", "CODE", "PRE", "NOSCRIPT", "SVG", "BUTTON"
          ]);

          if (blockedTags.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
          if (parent.closest(".cloze-selectable-word, .cloze-wrapper, #inline-cloze-floating-button, #inline-cloze-toast")) return NodeFilter.FILTER_REJECT;
          if (!isVisible(parent)) return NodeFilter.FILTER_REJECT;

          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    for (const node of textNodes) {
      const fragment = createSelectableFragment(node.nodeValue, settings);
      if (fragment) node.parentNode.replaceChild(fragment, node);
    }
  }

  function createSelectableFragment(text, settings) {
    const tokens = text.match(/[\p{L}\p{M}'’-]+|[^\p{L}\p{M}'’-]+/gu);
    if (!tokens) return null;

    let changed = false;
    const fragment = document.createDocumentFragment();

    for (const token of tokens) {
      if (isWord(token) && token.replace(/['’\-]/g, "").length >= settings.minLength) {
        changed = true;
        const span = document.createElement("span");
        span.className = "cloze-selectable-word";
        span.textContent = token;
        span.dataset.answer = token;
        span.dataset.sentence = extractSentence(text, token);
        span.addEventListener("click", (event) => {
          if (!selectionMode) return;
          event.preventDefault();
          event.stopPropagation();
          span.classList.toggle("cloze-selected-word");
        });
        fragment.appendChild(span);
      } else {
        fragment.appendChild(document.createTextNode(token));
      }
    }

    return changed ? fragment : null;
  }

  function applyCloze(settings, options) {
    if (!originalBodyHTML) {
      originalBodyHTML = document.body.innerHTML;
    }

    selectionMode = false;
    hideFloatingButton();
    hideToast();

    if (document.querySelector(".cloze-selectable-word")) {
      convertSelectableWordsToCloze(settings, options);
    } else {
      applyAutomaticCloze(settings);
    }

    const firstInput = document.querySelector(".cloze-input");
    firstInput?.focus();
  }

  function convertSelectableWordsToCloze(settings, options) {
    const words = [...document.querySelectorAll(".cloze-selectable-word")];
    let extraCounter = 0;

    for (const span of words) {
      const selected = span.classList.contains("cloze-selected-word");

      const shouldAutoAdd =
        options.includeExtra &&
        !selected &&
        shouldAddLevelRelevantExtra(span.textContent, ++extraCounter, settings);

      if ((options.includeUserSelections && selected) || shouldAutoAdd) {
        const cloze = makeClozeElement(
          span.dataset.answer || span.textContent,
          span.dataset.sentence || span.textContent,
          settings
        );
        span.replaceWith(cloze);
      } else {
        span.replaceWith(document.createTextNode(span.textContent));
      }
    }
  }

  function applyAutomaticCloze(settings) {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;

          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;

          const blockedTags = new Set([
            "SCRIPT", "STYLE", "TEXTAREA", "INPUT", "SELECT",
            "OPTION", "CODE", "PRE", "NOSCRIPT", "SVG", "BUTTON"
          ]);

          if (blockedTags.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
          if (parent.closest(".cloze-wrapper, #inline-cloze-floating-button, #inline-cloze-toast")) return NodeFilter.FILTER_REJECT;
          if (!isVisible(parent)) return NodeFilter.FILTER_REJECT;

          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    let wordCounter = 0;

    for (const node of textNodes) {
      const replacement = createAutomaticClozeFragment(node.nodeValue, settings, () => {
        wordCounter += 1;
        return wordCounter;
      });

      if (replacement) node.parentNode.replaceChild(replacement, node);
    }
  }

  function createAutomaticClozeFragment(text, settings, nextWordNumber) {
    const tokens = text.match(/[\p{L}\p{M}'’-]+|[^\p{L}\p{M}'’-]+/gu);
    if (!tokens) return null;

    let changed = false;
    const fragment = document.createDocumentFragment();

    for (const token of tokens) {
      if (isWord(token)) {
        const number = nextWordNumber();

        if (shouldCloze(token, number, settings)) {
          changed = true;
          fragment.appendChild(makeClozeElement(token, extractSentence(text, token), settings));
          continue;
        }
      }

      fragment.appendChild(document.createTextNode(token));
    }

    return changed ? fragment : null;
  }

  function shouldCloze(word, wordNumber, settings) {
    const cleaned = word.replace(/['’\-]/g, "");
    if (cleaned.length < settings.minLength) return false;
    return wordNumber % settings.density === 0;
  }

  // Placeholder for real AI selection.
  // Later, replace this with a background/API call that scores words by userLevel and known vocabulary.
  function shouldAddLevelRelevantExtra(word, count, settings) {
    const cleaned = word.replace(/['’\-]/g, "");
    if (cleaned.length < settings.minLength) return false;

    const levelBoost = {
      A1: 20,
      A2: 16,
      B1: 12,
      B2: 10,
      C1: 8,
      C2: 7
    };

    const interval = levelBoost[settings.userLevel] || settings.density;
    return count % interval === 0;
  }

  function makeClozeElement(answer, sentence, settings) {
    const wrapper = document.createElement("span");
    wrapper.className = "cloze-wrapper";

    const input = document.createElement("input");
    input.className = "cloze-input";
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.inputMode = "text";
    input.dataset.answer = answer;
    input.dataset.sentence = sentence || answer;

    const replay = document.createElement("button");
    replay.className = "cloze-replay";
    replay.type = "button";
    replay.textContent = "🔊";
    replay.title = "Replay";
    replay.addEventListener("click", () => {
      speak(getAudioText(answer, input.dataset.sentence, settings), settings.lang);
    });

    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;

      event.preventDefault();

      clearInlineFeedback(wrapper);

      const exactCorrect = answersMatch(input.value, answer, false);
      const accentFlexibleCorrect = answersMatch(input.value, answer, true);
      const accentOnlyProblem = !exactCorrect && accentFlexibleCorrect;
      const strictAccents = settings.accentMode === "strict";

      const correct = exactCorrect || (!strictAccents && accentOnlyProblem);

      input.classList.toggle("correct", correct);
      input.classList.toggle("incorrect", !correct);

      if (accentOnlyProblem) {
        showAccentFeedback(wrapper, input.value, answer, strictAccents ? "strict" : "flexible");
      } else if (!correct) {
        revealAnswer(wrapper, answer);
      }

      if (settings.audioMode !== "off") {
        speak(getAudioText(answer, input.dataset.sentence, settings), settings.lang);
      }

      const next = findNextInput(input);
      if (next) next.focus();
    });

    wrapper.appendChild(input);
    wrapper.appendChild(replay);
    return wrapper;
  }

  function clearInlineFeedback(wrapper) {
    wrapper.querySelectorAll(".cloze-reveal, .cloze-accent-feedback, .cloze-accent-note").forEach(el => el.remove());
  }

  function showAccentFeedback(wrapper, userAnswer, correctAnswer, mode) {
    const feedback = document.createElement("span");
    feedback.className = `cloze-accent-feedback ${mode}`;
    feedback.title = mode === "strict"
      ? "Accent/spelling issue: strict mode counts this as wrong."
      : "Accepted in flexible mode, but note the accent/spelling correction.";
    feedback.textContent = correctAnswer;

    const note = document.createElement("span");
    note.className = "cloze-accent-note";
    note.textContent = mode === "strict" ? "accent" : "accent accepted";

    wrapper.appendChild(feedback);
    wrapper.appendChild(note);
  }

  function revealAnswer(wrapper, answer) {
    let reveal = wrapper.querySelector(".cloze-reveal");
    if (!reveal) {
      reveal = document.createElement("span");
      reveal.className = "cloze-reveal";
      wrapper.appendChild(reveal);
    }
    reveal.textContent = answer;
  }

  function findNextInput(current) {
    const inputs = [...document.querySelectorAll(".cloze-input")];
    const index = inputs.indexOf(current);
    return inputs[index + 1] || null;
  }

  function answersMatch(userAnswer, correctAnswer, ignoreAccents) {
    return normalizeAnswer(userAnswer, ignoreAccents) ===
      normalizeAnswer(correctAnswer, ignoreAccents);
  }

  function normalizeAnswer(value, ignoreAccents) {
    let out = String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/\s+/g, " ");

    if (ignoreAccents) {
      out = out.normalize("NFD").replace(/\p{Diacritic}/gu, "");
    }

    return out;
  }

  function extractSentence(text, answer) {
    const escaped = escapeRegex(answer);
    const sentenceRegex = new RegExp(
      `[^.!?。！？]*${escaped}[^.!?。！？]*[.!?。！？]?`,
      "iu"
    );

    const match = text.match(sentenceRegex);
    return match ? match[0].trim() : answer;
  }

  function getAudioText(answer, sentence, settings) {
    if (settings.audioMode === "answer") return answer;
    if (settings.audioMode === "both") return `${answer}. ${sentence}`;
    return sentence || answer;
  }

  function speak(text, lang) {
    if (!text || !("speechSynthesis" in window)) return;

    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.rate = 0.9;
    utterance.pitch = 1;

    const voices = window.speechSynthesis.getVoices();
    const bestVoice = chooseVoice(voices, lang);
    if (bestVoice) utterance.voice = bestVoice;

    window.speechSynthesis.speak(utterance);
  }

  function chooseVoice(voices, lang) {
    if (!voices || !voices.length) return null;

    const lowerLang = lang.toLowerCase();
    return (
      voices.find(v => v.lang.toLowerCase() === lowerLang) ||
      voices.find(v => v.lang.toLowerCase().startsWith(lowerLang.split("-")[0])) ||
      null
    );
  }

  function showFloatingButton({ persistent, label, onClick }) {
    hideFloatingButton();

    floatingButton = document.createElement("button");
    floatingButton.id = "inline-cloze-floating-button";
    floatingButton.type = "button";
    floatingButton.textContent = "☰";
    floatingButton.title = label || "Inline Cloze";
    floatingButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick?.();
    });

    document.body.appendChild(floatingButton);

    if (!persistent) {
      autoIconTimer = window.setTimeout(() => {
        hideFloatingButton();
      }, 5000);
    }
  }

  function hideFloatingButton() {
    if (autoIconTimer) {
      window.clearTimeout(autoIconTimer);
      autoIconTimer = null;
    }

    floatingButton?.remove();
    floatingButton = null;
  }

  function showToast(message) {
    hideToast();

    toast = document.createElement("div");
    toast.id = "inline-cloze-toast";
    toast.textContent = message;
    document.body.appendChild(toast);

    window.setTimeout(() => hideToast(), 4500);
  }

  function hideToast() {
    toast?.remove();
    toast = null;
  }

  function isLikelyForeignLanguagePage(targetLang) {
    const htmlLang = (document.documentElement.lang || "").toLowerCase();
    const targetPrefix = String(targetLang || "").split("-")[0].toLowerCase();

    if (htmlLang && targetPrefix && htmlLang.startsWith(targetPrefix)) {
      return true;
    }

    const sample = document.body?.innerText?.slice(0, 5000) || "";

    // Simple fallback: common accented/foreign scripts.
    // This is intentionally conservative and should later be replaced with CLD3/Compact Language Detector or API detection.
    if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(sample)) return true;
    if (/[àâçéèêëîïôûùüÿñáíóúäöß]/i.test(sample) && targetPrefix !== "en") return true;

    return false;
  }

  function getSelectedText() {
    return String(window.getSelection?.().toString() || "").trim().replace(/\s+/g, " ");
  }

  function getSourceSite() {
    const host = location.hostname;
    if (host.includes("wordreference")) return "WordReference";
    if (host.includes("linguee")) return "Linguee";
    return host;
  }

  function clearCloze() {
    selectionMode = false;
    hideFloatingButton();
    hideToast();

    if (originalBodyHTML) {
      document.body.innerHTML = originalBodyHTML;
      originalBodyHTML = null;
    }
  }

  function isVisible(el) {
    const style = window.getComputedStyle(el);
    return style &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      Number(style.opacity) !== 0;
  }

  function isWord(token) {
    return /^[\p{L}\p{M}'’-]+$/u.test(token);
  }

  function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
})();
