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
    userLevel: "B1",
    hoverCaptureHotkey: { ctrl: true, shift: true, alt: false, meta: false, code: "KeyK" }
  };

  let originalBodyHTML = null;
  let activeSettings = { ...DEFAULTS };
  let selectionMode = false;
  let floatingButton = null;
  let toast = null;
  let autoIconTimer = null;
  let hoverCaptureActive = false;
  let hoverCapturePanel = null;
  let hoverCaptureHotkeyHeld = false;
  let hoverCaptureBlockCache = null;
  let lastPointerX = -1;
  let lastPointerY = -1;

  document.addEventListener("keydown", onGlobalHoverCaptureKeydown, true);
  document.addEventListener("keyup", onGlobalHoverCaptureKeyup, true);
  window.addEventListener("blur", onWindowBlurCancelHoverCaptureHold);
  document.addEventListener("mousemove", onGlobalPointerTrack, { capture: true, passive: true });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.hoverCaptureHotkey) {
      activeSettings.hoverCaptureHotkey = changes.hoverCaptureHotkey.newValue || DEFAULTS.hoverCaptureHotkey;
    }
  });

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

  // --- Hover capture: hold the configured hotkey, hover to highlight the sentence
  // under the cursor, click it to save. Releasing the hotkey (or Esc) cancels.

  function isEditableTarget(target) {
    if (!target) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  function matchesHoverCaptureHotkey(event) {
    const hotkey = activeSettings.hoverCaptureHotkey || DEFAULTS.hoverCaptureHotkey;
    if (!hotkey || !hotkey.code) return false;

    return event.code === hotkey.code &&
      event.ctrlKey === Boolean(hotkey.ctrl) &&
      event.shiftKey === Boolean(hotkey.shift) &&
      event.altKey === Boolean(hotkey.alt) &&
      event.metaKey === Boolean(hotkey.meta);
  }

  function onGlobalHoverCaptureKeydown(event) {
    if (event.repeat || hoverCaptureHotkeyHeld) return;
    if (isEditableTarget(event.target)) return;
    if (!matchesHoverCaptureHotkey(event)) return;
    if (hoverCaptureActive || hoverCapturePanel) return;

    hoverCaptureHotkeyHeld = true;
    startHoverCapture();
  }

  function onGlobalHoverCaptureKeyup(event) {
    if (!hoverCaptureHotkeyHeld) return;

    const hotkey = activeSettings.hoverCaptureHotkey || DEFAULTS.hoverCaptureHotkey;
    const releasedMainKey = event.code === hotkey.code;
    const releasedRequiredModifier =
      (hotkey.ctrl && !event.ctrlKey) ||
      (hotkey.shift && !event.shiftKey) ||
      (hotkey.alt && !event.altKey) ||
      (hotkey.meta && !event.metaKey);

    if (!releasedMainKey && !releasedRequiredModifier) return;

    hoverCaptureHotkeyHeld = false;
    if (hoverCaptureActive) {
      stopHoverCapture();
      hideToast();
    }
  }

  function onGlobalPointerTrack(event) {
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
  }

  function onWindowBlurCancelHoverCaptureHold() {
    if (!hoverCaptureHotkeyHeld) return;

    hoverCaptureHotkeyHeld = false;
    if (hoverCaptureActive) {
      stopHoverCapture();
      hideToast();
    }
  }

  function startHoverCapture() {
    if (hoverCaptureActive || hoverCapturePanel) return;

    hoverCaptureActive = true;
    document.addEventListener("mousemove", onHoverCaptureMouseMove, true);
    document.addEventListener("click", onHoverCaptureClick, true);
    document.addEventListener("keydown", onHoverCaptureKeydown, true);
    document.documentElement.style.cursor = "crosshair";

    // Paint the highlight right away using the cursor's last known position,
    // so it doesn't take a mouse jiggle after the hotkey to show anything.
    if (lastPointerX >= 0 && lastPointerY >= 0) {
      updateHoverCaptureHighlightAt(lastPointerX, lastPointerY);
    }

    showToast("Keep holding your hotkey and hover to highlight a sentence, then click to capture it. Release or Esc to cancel.");
  }

  function stopHoverCapture() {
    hoverCaptureActive = false;
    document.removeEventListener("mousemove", onHoverCaptureMouseMove, true);
    document.removeEventListener("click", onHoverCaptureClick, true);
    document.removeEventListener("keydown", onHoverCaptureKeydown, true);
    document.documentElement.style.cursor = "";
    clearHoverCaptureHighlight();
    hoverCaptureBlockCache = null;
  }

  function onHoverCaptureMouseMove(event) {
    updateHoverCaptureHighlightAt(event.clientX, event.clientY, event.target);
  }

  function updateHoverCaptureHighlightAt(x, y, target) {
    const el = target || document.elementFromPoint(x, y);
    if (el && el.closest("#lt-hover-capture-panel, #inline-cloze-toast, #inline-cloze-floating-button")) {
      clearHoverCaptureHighlight();
      return;
    }

    const sentence = getSentenceAtPoint(x, y);
    if (!sentence) {
      clearHoverCaptureHighlight();
      return;
    }

    highlightRange(sentence.range);
  }

  function onHoverCaptureClick(event) {
    if (event.target.closest("#lt-hover-capture-panel")) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const sentence = getSentenceAtPoint(event.clientX, event.clientY);
    stopHoverCapture();
    hideToast();

    if (!sentence || !sentence.text) {
      showToast("No sentence found there.");
      return;
    }

    openHoverCapturePanel(sentence.text, event.clientX, event.clientY);
  }

  function onHoverCaptureKeydown(event) {
    if (event.key !== "Escape") return;
    stopHoverCapture();
    hideToast();
    showToast("Sentence capture cancelled.");
  }

  const HOVER_CAPTURE_BLOCK_TAGS = new Set([
    "P", "LI", "TD", "TH", "DIV", "ARTICLE", "SECTION", "BLOCKQUOTE",
    "H1", "H2", "H3", "H4", "H5", "H6", "FIGCAPTION", "DD", "DT", "PRE",
    "SUMMARY", "CAPTION", "MAIN", "ASIDE", "HEADER", "FOOTER", "NAV", "FORM"
  ]);

  function isHoverCaptureBlockElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (HOVER_CAPTURE_BLOCK_TAGS.has(el.tagName)) return true;
    const display = window.getComputedStyle(el).display;
    return display === "block" || display === "list-item" || display === "flex" ||
      display === "grid" || display === "table" || display === "table-cell" ||
      display === "table-row" || display === "flow-root";
  }

  // Finds the nearest ancestor that represents a "paragraph"-like unit of text,
  // walking past inline wrappers (links, spans, bold/italic, etc.) that would
  // otherwise fragment the sentence across unrelated text nodes.
  function getHoverCaptureBlock(node) {
    let el = node.parentElement;
    while (el && el !== document.body && el !== document.documentElement && !isHoverCaptureBlockElement(el)) {
      el = el.parentElement;
    }
    if (!el || el === document.documentElement) return node.parentElement || document.body;
    return el;
  }

  function collectHoverCaptureTextNodes(root) {
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;

          const blockedTags = new Set([
            "SCRIPT", "STYLE", "TEXTAREA", "INPUT", "SELECT",
            "OPTION", "CODE", "PRE", "NOSCRIPT", "SVG", "BUTTON"
          ]);

          if (blockedTags.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
          if (parent.closest("#lt-hover-capture-panel, #inline-cloze-toast, #inline-cloze-floating-button")) {
            return NodeFilter.FILTER_REJECT;
          }
          if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
          if (!isVisible(parent)) return NodeFilter.FILTER_REJECT;

          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const nodes = [];
    let text = "";
    while (walker.nextNode()) {
      const current = walker.currentNode;
      const value = current.nodeValue;
      nodes.push({ node: current, start: text.length, end: text.length + value.length });
      text += value;
    }

    return { nodes, text };
  }

  function getHoverCaptureBlockInfo(block) {
    if (hoverCaptureBlockCache && hoverCaptureBlockCache.block === block) {
      return hoverCaptureBlockCache;
    }
    const { nodes, text } = collectHoverCaptureTextNodes(block);
    hoverCaptureBlockCache = { block, nodes, text };
    return hoverCaptureBlockCache;
  }

  function findHoverCaptureGlobalOffset(nodes, targetNode, targetOffset) {
    for (const entry of nodes) {
      if (entry.node === targetNode) return entry.start + targetOffset;
    }
    return null;
  }

  function buildHoverCaptureRange(nodes, start, end) {
    const range = document.createRange();
    let startSet = false;

    for (const entry of nodes) {
      if (!startSet && start >= entry.start && start <= entry.end) {
        range.setStart(entry.node, start - entry.start);
        startSet = true;
      }
      if (startSet && end >= entry.start && end <= entry.end) {
        range.setEnd(entry.node, end - entry.start);
        return range;
      }
    }

    return null;
  }

  function getSentenceAtPoint(x, y) {
    if (!document.caretRangeFromPoint) return null;

    const caretRange = document.caretRangeFromPoint(x, y);
    if (!caretRange) return null;

    const node = caretRange.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return null;

    const parent = node.parentElement;
    if (!parent || !isVisible(parent)) return null;
    if (parent.closest("#lt-hover-capture-panel, #inline-cloze-toast, #inline-cloze-floating-button")) return null;

    const block = getHoverCaptureBlock(node);
    const { nodes, text } = getHoverCaptureBlockInfo(block);
    if (!text.trim()) return null;

    const globalOffset = findHoverCaptureGlobalOffset(nodes, node, caretRange.startOffset);
    if (globalOffset == null) return null;

    const bounds = extractSentenceBoundsAtOffset(text, globalOffset);
    if (bounds) {
      const range = buildHoverCaptureRange(nodes, bounds.start, bounds.end);
      if (range) return { text: bounds.text, range };
    }

    // Couldn't confidently narrow down to a single sentence (e.g. no sentence
    // punctuation in this block) - fall back to the whole containing node.
    const fallbackRange = document.createRange();
    fallbackRange.selectNodeContents(block);
    return { text: text.trim(), range: fallbackRange };
  }

  function extractSentenceBoundsAtOffset(text, offset) {
    const regex = /[^.!?。！？]*[.!?。！？]+|[^.!?。！？]+$/gu;
    let match;

    while ((match = regex.exec(text))) {
      const start = match.index;
      const end = start + match[0].length;
      if (offset >= start && offset <= end) {
        const trimmed = match[0].trim();
        if (!trimmed) return null;
        return { text: trimmed, start, end };
      }
    }

    return null;
  }

  function highlightRange(range) {
    if (!window.Highlight || !CSS.highlights) return;
    CSS.highlights.set("lt-hover-capture", new Highlight(range));
  }

  function clearHoverCaptureHighlight() {
    if (!window.CSS || !CSS.highlights) return;
    CSS.highlights.delete("lt-hover-capture");
  }

  async function openHoverCapturePanel(sentenceText, x, y) {
    closeHoverCapturePanel();

    const data = await chrome.storage.local.get({ vocabTerms: {}, pendingVocabTerm: "" });
    const existingTerms = Object.values(data.vocabTerms || {})
      .map(entry => entry.term)
      .sort((a, b) => a.localeCompare(b));

    const panel = document.createElement("div");
    panel.id = "lt-hover-capture-panel";

    const preview = document.createElement("div");
    preview.className = "lt-hc-sentence";
    preview.textContent = sentenceText;
    panel.appendChild(preview);

    const select = document.createElement("select");
    for (const term of existingTerms) {
      const option = document.createElement("option");
      option.value = term;
      option.textContent = term;
      select.appendChild(option);
    }
    const newOption = document.createElement("option");
    newOption.value = "__new__";
    newOption.textContent = "+ New term…";
    select.appendChild(newOption);

    const newTermInput = document.createElement("input");
    newTermInput.type = "text";
    newTermInput.placeholder = "Type a new term";

    if (data.pendingVocabTerm && existingTerms.includes(data.pendingVocabTerm)) {
      select.value = data.pendingVocabTerm;
      newTermInput.style.display = "none";
    } else if (data.pendingVocabTerm) {
      select.value = "__new__";
      newTermInput.value = data.pendingVocabTerm;
    } else if (existingTerms.length) {
      newTermInput.style.display = "none";
    } else {
      select.value = "__new__";
    }

    select.addEventListener("change", () => {
      newTermInput.style.display = select.value === "__new__" ? "" : "none";
    });

    panel.appendChild(select);
    panel.appendChild(newTermInput);

    const errorBox = document.createElement("div");
    errorBox.className = "lt-hc-error";
    errorBox.style.display = "none";

    const actions = document.createElement("div");
    actions.className = "lt-hc-actions";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", () => closeHoverCapturePanel());

    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.className = "lt-hc-save";
    saveButton.textContent = "Save";
    saveButton.addEventListener("click", async () => {
      const term = cleanTermLocally(select.value === "__new__" ? newTermInput.value : select.value);
      if (!term) {
        errorBox.textContent = "Enter a term first.";
        errorBox.style.display = "";
        return;
      }

      const result = await chrome.runtime.sendMessage({
        type: "SAVE_SENTENCE",
        payload: {
          term,
          sentence: sentenceText,
          sourceUrl: location.href,
          sourceTitle: document.title,
          sourceSite: getSourceSite()
        }
      });

      if (!result?.ok) {
        errorBox.textContent = result?.error || "Could not save sentence.";
        errorBox.style.display = "";
        return;
      }

      closeHoverCapturePanel();
      showToast(`Saved sentence for "${term}".`);
    });

    actions.appendChild(cancelButton);
    actions.appendChild(saveButton);
    panel.appendChild(errorBox);
    panel.appendChild(actions);

    document.body.appendChild(panel);
    positionPanel(panel, x, y);
    document.addEventListener("keydown", onHoverCapturePanelKeydown, true);

    hoverCapturePanel = panel;
  }

  function positionPanel(panel, x, y) {
    const rect = panel.getBoundingClientRect();
    const margin = 12;
    const left = Math.min(Math.max(x, margin), window.innerWidth - rect.width - margin);
    const top = Math.min(Math.max(y, margin), window.innerHeight - rect.height - margin);
    panel.style.left = `${Math.max(left, margin)}px`;
    panel.style.top = `${Math.max(top, margin)}px`;
  }

  function onHoverCapturePanelKeydown(event) {
    if (event.key === "Escape") closeHoverCapturePanel();
  }

  function closeHoverCapturePanel() {
    document.removeEventListener("keydown", onHoverCapturePanelKeydown, true);
    hoverCapturePanel?.remove();
    hoverCapturePanel = null;
  }

  function cleanTermLocally(value) {
    return String(value || "").trim().replace(/\s+/g, " ").slice(0, 120);
  }
})();
