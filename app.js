/*
  Miraware Voice Medical Input - jQuery plugin
  Usage: $('.mmf-root').voiceMedicalForm(options)
*/

(function($){
  'use strict';

  const RecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition || null;

  const CONFIG = {
    defaults: {
      recognitionLangs: ['ar-SA', 'ar-EG', 'ar'],
      maxRecordingMs: 7000,
      maxAlternatives: 5,
      phraseHints: [],
      aggressiveTaaFix: false,
      onSave: null
    },
    selectors: {
      status: '.status, #status',
      review: '#review-btn, .mmf-review-btn',
      inputs: 'input.mmf-input[type=text], input[type=text]',
      mic: '.mic-btn'
    },
    dictionary: {
      aff: './vendor/dicts/ar.aff',
      dic: './vendor/dicts/ar.dic'
    },
    statuses: {
      ready: 'النظام جاهز للإدخال الصوتي والتجهيز للإرسال.',
      listening: 'جاري الاستماع والكتابة المباشرة...',
      dictLoading: 'جاري تحميل قاموس التصحيح محلياً...',
      dictReady: 'قاموس التصحيح محمل محلياً.',
      dictFallback: 'قيد التشغيل بدون قاموس التصحيح (الملفات المحلية غير موجودة).',
      dictInitFailed: 'فشل تهيئة قاموس التصحيح.',
      saved: 'تم تجهيز النص للإرسال.',
      noInputs: 'لا توجد حقول لإرسالها.',
      emptySave: 'أدخل نصًا قبل التجهيز.',
      autoStopped: 'تم إيقاف التسجيل تلقائيًا.',
      stopped: 'تم إيقاف الاستماع.',
      commitDone: 'تمت الكتابة داخل الحقل.'
    }
  };

  const SAFE_REPLACEMENTS = new Map([
    ['الى', 'إلى'],
    ['اذا', 'إذا'],
    ['ايضا', 'أيضا'],
    ['لان', 'لأن'],
    ['شي', 'شيء']
  ]);

  const DICTIONARY_CACHE = {
    promise: null,
    aff: null,
    dic: null
  };

  const EVENT_NAMESPACE = '.mmf';

  /**
   * Create a small console wrapper for the plugin.
   * @param {string} namespace Logger namespace.
   * @returns {{debug:Function,info:Function,warn:Function,error:Function}} Logger API.
   */
  function createLogger(namespace){
    const prefix = namespace ? '[' + namespace + ']' : '[mmf]';

    function forward(method, args){
      const target = console[method] || console.info || console.debug || function(){};
      target.apply(console, [prefix].concat(Array.from(args)));
    }

    return {
      /** @param {...*} */
      debug: function(){ forward('debug', arguments); },
      /** @param {...*} */
      info: function(){ forward('info', arguments); },
      /** @param {...*} */
      warn: function(){ forward('warn', arguments); },
      /** @param {...*} */
      error: function(){ forward('error', arguments); }
    };
  }

  /**
   * Escape a CSS selector fragment when native CSS.escape is unavailable.
   * @param {string} value Raw selector value.
   * @returns {string} Escaped selector fragment.
   */
  function escapeSelector(value){
    const input = String(value || '');
    if(window.CSS && typeof window.CSS.escape === 'function'){
      return window.CSS.escape(input);
    }
    return input.replace(/[^a-zA-Z0-9_-]/g, function(character){
      return '\\' + character;
    });
  }

  /**
   * Collapse repeated whitespace into single spaces.
   * @param {string} value Input text.
   * @returns {string} Normalized text.
   */
  function shrinkSpaces(value){
    return (value || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Strip Arabic diacritics from a string.
   * @param {string} value Input text.
   * @returns {string} Text without diacritics.
   */
  function stripArabicDiacritics(value){
    return (value || '').replace(/[\u0617-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/gu, '');
  }

  /**
   * Canonicalize an Arabic word for safe dictionary lookups.
   * @param {string} word Word to normalize.
   * @returns {string} Canonicalized word.
   */
  function canonicalizeArabicWord(word){
    return stripArabicDiacritics(word || '')
      .replace(/[\u0622\u0623\u0625\u0671]/gu, 'ا')
      .replace(/\u0649/gu, 'ي')
      .replace(/\u0629/gu, 'ه')
      .replace(/\u0640/gu, '')
      .trim();
  }

  /**
   * Apply a small set of deterministic Arabic word corrections.
   * @param {string} text Input text.
   * @returns {string} Corrected text.
   */
  function applySafeWordCorrections(text){
    if(!text) return text;
    return text.replace(/([\u0600-\u06FF]+)/gu, function(match){
      const canonical = canonicalizeArabicWord(match);
      if(SAFE_REPLACEMENTS.has(match)) return SAFE_REPLACEMENTS.get(match);
      if(SAFE_REPLACEMENTS.has(canonical)) return SAFE_REPLACEMENTS.get(canonical);
      return match;
    });
  }

  /**
   * Normalize spacing around punctuation in a live transcript.
   * @param {string} text Input text.
   * @returns {string} Live-normalized text.
   */
  function normalizeLiveTranscript(text){
    return shrinkSpaces((text || '')
      .replace(/\s+([\u060C\u061F.!,:;])/g, '$1')
      .replace(/([\u060C\u061F.!])(?=\S)/g, '$1 ')
    );
  }

  /**
   * Normalize Arabic speech text for committing to the input.
   * @param {string} text Input text.
   * @returns {string} Normalized Arabic text.
   */
  function normalizeArabicTranscript(text){
    return applySafeWordCorrections(normalizeLiveTranscript(text));
  }

  /**
   * Create plugin state in one place.
   * @param {object} options Resolved plugin options.
   * @returns {object} Mutable state container.
   */
  function createState(options){
    return {
      options: options,
      recognition: null,
      typoInstance: null,
      aggressiveTaaFix: !!options.aggressiveTaaFix,
      activeButton: null,
      activeInput: null,
      autoStopTimer: null,
      sessionBaseText: '',
      finalTranscript: '',
      recognitionHadError: false,
      langIndex: 0,
      phraseHintsEnabled: !!(options.phraseHints && options.phraseHints.length),
      retryWithoutPhrases: false
    };
  }

  /**
   * Collect the DOM nodes used by the plugin.
   * @param {HTMLElement} rootEl Plugin root element.
   * @returns {object} DOM references.
   */
  function collectDomRefs(rootEl){
    const $root = $(rootEl);
    const $status = $root.find(CONFIG.selectors.status).first();
    const $review = $root.find(CONFIG.selectors.review).first();
    const $inputs = $root.find(CONFIG.selectors.inputs);
    const $mics = $root.find(CONFIG.selectors.mic);

    return {
      rootEl: rootEl,
      $root: $root,
      $status: $status,
      $review: $review,
      $inputs: $inputs,
      $mics: $mics,
      statusEl: $status.get(0),
      reviewEl: $review.get(0),
      inputEls: $inputs.get(),
      micEls: $mics.get()
    };
  }

  /**
   * Validate required DOM structure and fail fast if it is missing.
   * @param {object} refs DOM references.
   */
  function assertDomRefs(refs){
    if(!refs.$status.length) throw new Error('mmf: status element not found');
    if(!refs.$mics.length) throw new Error('mmf: mic buttons not found');
    if(!refs.$review.length) throw new Error('mmf: review button not found');
  }

  /**
   * Update the visible status text.
   * @param {object} refs DOM references.
   * @param {string} message Status message.
   * @param {string} state Status state token.
   */
  function setStatus(refs, message, state){
    refs.$status.text(message).attr('data-state', state || '');
  }

  /**
   * Toggle the recording state of a mic button.
   * @param {HTMLElement} button Mic button.
   * @param {boolean} recording Whether recording is active.
   */
  function setButtonState(button, recording){
    if(!button) return;
    $(button).toggleClass('is-recording', !!recording).attr('aria-pressed', recording ? 'true' : 'false');
  }

  /**
   * Get the current value from an input element.
   * @param {HTMLInputElement|HTMLTextAreaElement} input Input element.
   * @returns {string} Input value.
   */
  function getInputValue(input){
    return $(input).val() || '';
  }

  /**
   * Set the value of an input element.
   * @param {HTMLInputElement|HTMLTextAreaElement} input Input element.
   * @param {string} value New value.
   */
  function setInputValue(input, value){
    $(input).val(value);
  }

  /**
   * Clear any pending auto-stop timer.
   * @param {object} state Plugin state.
   */
  function clearAutoStop(state){
    if(state.autoStopTimer){
      clearTimeout(state.autoStopTimer);
      state.autoStopTimer = null;
    }
  }

  /**
   * Stop the active recognition instance if one exists.
   * @param {object} state Plugin state.
   */
  function stopRecognition(state){
    if(state.recognition){
      state.recognition.stop();
    }
  }

  /**
   * Reset the active recognition state back to idle.
   * @param {object} state Plugin state.
   */
  function resetRecognitionState(state){
    clearAutoStop(state);
    if(state.activeButton) setButtonState(state.activeButton, false);
    state.recognition = null;
    state.activeButton = null;
    state.activeInput = null;
    state.sessionBaseText = '';
    state.finalTranscript = '';
    state.recognitionHadError = false;
    state.retryWithoutPhrases = false;
  }

  /**
   * Get the active recognition language.
   * @param {object} state Plugin state.
   * @returns {string} Current language tag.
   */
  function getLang(state){
    return state.options.recognitionLangs[state.langIndex] || state.options.recognitionLangs[0];
  }

  /**
   * Rotate to the next configured recognition language.
   * @param {object} state Plugin state.
   * @returns {string} Next language tag.
   */
  function rotateLang(state){
    state.langIndex = (state.langIndex + 1) % state.options.recognitionLangs.length;
    return getLang(state);
  }

  /**
   * Translate speech recognition errors into user-facing messages.
   * @param {string} code Recognition error code.
   * @returns {string} Localized message.
   */
  function describeError(code){
    switch(code){
      case 'not-allowed': return 'تم رفض إذن الميكروفون. اسمح للمتصفح باستخدام الميكروفون.';
      case 'no-speech': return 'لم يتم سماع كلام واضح. جرّب الاقتراب من المايك.';
      case 'audio-capture': return 'لا يمكن التقاط الصوت من الميكروفون.';
      case 'network': return 'تعذر الاتصال بخدمة التعرف الصوتي.';
      case 'language-not-supported': return 'اللغة العربية غير مدعومة في هذا المتصفح.';
      case 'phrases-not-supported': return 'المتصفح لا يدعم تحسين العبارات.';
      case 'aborted': return 'تم إيقاف الاستماع.';
      default: return 'حدث خطأ في التعرف الصوتي.';
    }
  }

  /**
   * Resolve the target input referenced by a mic button.
   * @param {object} refs DOM references.
   * @param {HTMLElement} button Mic button.
   * @returns {HTMLInputElement|HTMLTextAreaElement|null} Target input.
   */
  function resolveTarget(refs, button){
    const ref = button && button.dataset ? button.dataset.target : null;
    if(!ref) return null;

    if(ref.charAt(0) === '#' || ref.charAt(0) === '.'){
      return refs.$root.find(ref).get(0) || $(ref).get(0) || null;
    }

    const selector = '#' + escapeSelector(ref);
    return refs.$root.find(selector).get(0) || $(selector).get(0) || null;
  }

  /**
   * Load a local text file with explicit error handling.
   * @param {string} url File URL.
   * @returns {Promise<string>} File contents.
   */
  async function fetchText(url){
    const response = await fetch(url);
    if(!response.ok) throw new Error(url + ' not found (' + response.status + ')');
    return response.text();
  }

  /**
   * Parse a Hunspell-style .dic file into a word list.
   * @param {string} dicText Dictionary text.
   * @returns {Array<string>} Parsed words.
   */
  function parseDictionaryWords(dicText){
    return (dicText || '')
      .split(/\r?\n/)
      .map(function(line){ return line.trim(); })
      .filter(function(line){ return line && !/^#/.test(line); })
      .filter(function(line, index){ return index !== 0 || !/^[0-9]+$/.test(line); });
  }

  /**
   * Create a small local dictionary engine when Typo.js is unavailable.
   * @param {string} aff Dictionary affix content.
   * @param {string} dic Dictionary word list content.
   * @returns {{check:Function,suggest:Function}} Dictionary API.
   */
  function createLocalDictionaryEngine(aff, dic){
    const words = parseDictionaryWords(dic);
    const exactSet = new Set(words);
    const canonicalMap = new Map();

    words.forEach(function(word){
      const canonical = canonicalizeArabicWord(word);
      if(!canonicalMap.has(canonical)){
        canonicalMap.set(canonical, word);
      }
    });

    return {
      check: function(word){
        const value = String(word || '').trim();
        if(!value) return false;
        if(exactSet.has(value)) return true;
        return canonicalMap.has(canonicalizeArabicWord(value));
      },

      suggest: function(word, maxResults){
        const input = String(word || '').trim();
        if(!input) return [];

        if(exactSet.has(input)) return [input];

        const canonical = canonicalizeArabicWord(input);
        if(canonicalMap.has(canonical)){
          return [canonicalMap.get(canonical)];
        }

        return [];
      }
    };
  }

  /**
   * Initialize the Hunspell dictionary if Typo is available.
   * @param {object} state Plugin state.
   * @param {object} refs DOM references.
   * @param {object} logger Logger instance.
   * @param {string} aff Dictionary affix content.
   * @param {string} dic Dictionary word list content.
   */
  function initializeTypo(state, refs, logger, aff, dic){
    try{
      if(typeof Typo === 'function'){
        state.typoInstance = new Typo('ar', aff, dic, { platform: 'any' });
      }else{
        state.typoInstance = createLocalDictionaryEngine(aff, dic);
      }
      setStatus(refs, CONFIG.statuses.dictReady, 'success');
    }catch(error){
      state.typoInstance = null;
      setStatus(refs, CONFIG.statuses.dictInitFailed, 'error');
      logger.error('Typo init error', error);
    }
  }

  /**
   * Load the local dictionary asynchronously without blocking the UI.
   * @param {object} state Plugin state.
   * @param {object} refs DOM references.
   * @param {object} logger Logger instance.
   */
  async function loadLocalDictionary(state, refs, logger){
    setStatus(refs, CONFIG.statuses.dictLoading, '');

    try{
      if(!DICTIONARY_CACHE.promise){
        DICTIONARY_CACHE.promise = Promise.all([
          fetchText(CONFIG.dictionary.aff),
          fetchText(CONFIG.dictionary.dic)
        ]).then(function(results){
          DICTIONARY_CACHE.aff = results[0];
          DICTIONARY_CACHE.dic = results[1];
          return results;
        }).catch(function(error){
          DICTIONARY_CACHE.promise = null;
          DICTIONARY_CACHE.aff = null;
          DICTIONARY_CACHE.dic = null;
          throw error;
        });
      }

      const cached = await DICTIONARY_CACHE.promise;
      const aff = DICTIONARY_CACHE.aff || cached[0];
      const dic = DICTIONARY_CACHE.dic || cached[1];
      initializeTypo(state, refs, logger, aff, dic);
    }catch(error){
      logger.info('MMF: local dictionaries not loaded', error);
      setStatus(refs, CONFIG.statuses.dictFallback, '');
    }
  }

  /**
   * Extract the core Arabic token from surrounding punctuation.
   * @param {string} token Raw token.
   * @returns {{left:string,core:string,right:string}} Token parts.
   */
  function splitTokenAffixes(token){
    const match = token.match(/^([^\u0600-\u06FF0-9]*)([\u0600-\u06FF0-9]+)([^\u0600-\u06FF0-9]*)$/u);
    if(!match){
      return { left: '', core: token, right: '' };
    }

    return {
      left: match[1] || '',
      core: match[2] || '',
      right: match[3] || ''
    };
  }

  /**
   * Harmonize a suggestion with the original token when taa marbuta is involved.
   * @param {string} original Original token core.
   * @param {string} suggestion Suggested replacement.
   * @returns {string} Adjusted suggestion.
   */
  function harmonizeSuggestionEnding(original, suggestion){
    if(!original || !suggestion) return suggestion;
    if(original.slice(-1) === 'ة' && suggestion.slice(-1) === 'ه'){
      return suggestion.slice(0, -1) + 'ة';
    }
    return suggestion;
  }

  /**
   * Apply the optional aggressive taa-marbuta cleanup when enabled.
   * @param {object} state Plugin state.
   * @param {string} original Original token core.
   * @param {string} suggestion Suggested replacement.
   * @returns {string} Adjusted suggestion.
   */
  function applyAggressiveTaaFix(state, original, suggestion){
    if(!state.aggressiveTaaFix || !original || !suggestion) return suggestion;
    if(original.slice(-1) === 'ة' && suggestion.slice(-1) === 'ه'){
      return suggestion.slice(0, -1) + 'ة';
    }
    if(original.slice(-1) === 'ة' && suggestion.slice(-1) !== 'ة' && canonicalizeArabicWord(original).slice(-1) === 'ه'){
      return suggestion.slice(0, -1) + 'ة';
    }
    return suggestion;
  }

  /**
   * Prefer a taa marbuta ending when the dictionary accepts the variant.
   * @param {object} state Plugin state.
   * @param {string} core Token core.
   * @param {object} typoInstance Typo dictionary instance.
   * @param {string} candidate Suggested token core.
   * @returns {string} Variant with taa marbuta when it is safer.
   */
  function preferTaaMarbutaVariant(state, core, typoInstance, candidate){
    return candidate;
  }

  /**
   * Build a prioritized list of candidate spellings for a token core.
   * @param {object} state Plugin state.
   * @param {string} core Token core.
   * @param {object} typoInstance Typo dictionary instance.
   * @returns {Array<string>} Candidate spellings in priority order.
   */
  function buildDictionaryCandidates(state, core, typoInstance){
    const candidates = [];
    const seen = new Set();

    function addCandidate(value){
      const candidate = (value || '').trim();
      if(!candidate || seen.has(candidate)) return;
      seen.add(candidate);
      candidates.push(candidate);
    }

    addCandidate(core);

    const canonical = canonicalizeArabicWord(core);
    addCandidate(canonical);

    try{
      if(typeof typoInstance.suggest === 'function'){
        const suggestions = typoInstance.suggest(core, 3) || [];
        for(let index = 0; index < suggestions.length; index++){
          addCandidate(suggestions[index]);
        }
        if(canonical !== core){
          const canonicalSuggestions = typoInstance.suggest(canonical, 3) || [];
          for(let index = 0; index < canonicalSuggestions.length; index++){
            addCandidate(canonicalSuggestions[index]);
          }
        }
      }
    }catch(error){
      // Fall back to the candidates collected so far.
    }

    return candidates;
  }

  /**
   * Choose the best dictionary-approved candidate.
   * @param {object} state Plugin state.
   * @param {string} core Token core.
   * @param {object} typoInstance Typo dictionary instance.
   * @param {Array<string>} candidates Candidate spellings.
   * @returns {string} Best approved candidate or the original core.
   */
  function chooseDictionaryCandidate(state, core, typoInstance, candidates){
    for(let index = 0; index < candidates.length; index++){
      const candidate = candidates[index];
      try{
        if(typeof typoInstance.check === 'function' && typoInstance.check(candidate)){
          return preferTaaMarbutaVariant(state, core, typoInstance, candidate);
        }
      }catch(error){
        // Skip candidates that cannot be checked.
      }
    }

    return core;
  }

  /**
   * Prefer taa marbuta in a finalized text when the dictionary accepts it.
   * @param {object} state Plugin state.
   * @param {string} text Text to refine.
   * @param {object} typoInstance Typo dictionary instance.
   * @returns {string} Refined text.
   */
  function preferDictionaryTaaMarbutaInText(state, text, typoInstance){
    if(!text || !typoInstance || typeof typoInstance.check !== 'function') return text;

    return text.split(/(\s+)/).map(function(token){
      if(/^\s+$/.test(token)) return token;

      const parts = splitTokenAffixes(token);
      if(!parts.core) return token;

      const core = parts.core;
      const looksLikeTaaVariant = core.slice(-1) === 'ه' || canonicalizeArabicWord(core).slice(-1) === 'ه';
      if(!looksLikeTaaVariant) return token;

      const candidate = core.slice(-1) === 'ه' ? core : canonicalizeArabicWord(core);
      const taaVariant = candidate.slice(0, -1) + 'ة';

      try{
        if(typoInstance.check(taaVariant)){
          return parts.left + taaVariant + parts.right;
        }
      }catch(error){
        // Keep the original token if dictionary access fails.
      }

      return token;
    }).join('');
  }

  /**
   * Resolve the best correction for a single token core.
   * @param {string} core Token core.
   * @param {object} typoInstance Typo dictionary instance.
   * @returns {string} Corrected or original core.
   */
  function correctTokenCore(state, core, typoInstance){
    if(!core) return core;

    try{
      if(typeof typoInstance.check === 'function' && typoInstance.check(core)){
        return core;
      }
    }catch(error){
      return core;
    }

    const candidates = buildDictionaryCandidates(state, core, typoInstance).map(function(candidate){
      const harmonized = applyAggressiveTaaFix(state, core, harmonizeSuggestionEnding(core, candidate) || candidate) || candidate;
      return harmonized;
    });

    return chooseDictionaryCandidate(state, core, typoInstance, candidates);
  }

  /**
   * Apply typo-based corrections to a single token.
   * @param {string} token Raw token.
   * @param {object} typoInstance Typo dictionary instance.
   * @returns {string} Corrected token.
   */
  function correctToken(state, token, typoInstance){
    if(/^\s+$/.test(token)) return token;

    const parts = splitTokenAffixes(token);
    if(!parts.core) return token;

    const correctedCore = correctTokenCore(state, parts.core, typoInstance);
    return parts.left + correctedCore + parts.right;
  }

  /**
   * Apply typo corrections to a whole string while preserving spacing tokens.
   * @param {string} text Normalized text.
   * @param {object} typoInstance Typo dictionary instance.
   * @returns {string} Corrected text.
   */
  function applyTypoCorrections(state, text, typoInstance){
    return text.split(/(\s+)/).map(function(token){
      return correctToken(state, token, typoInstance);
    }).join('');
  }

  /**
   * Commit the provided text into an input element.
   * @param {object} state Plugin state.
   * @param {HTMLInputElement|HTMLTextAreaElement} input Input element.
   * @param {string} raw Raw text to commit.
   * @returns {string} Committed value.
   */
  function commitField(state, input, raw){
    const normalized = normalizeArabicTranscript(raw || '');
    const typoInstance = state.typoInstance;

    if(typoInstance){
      try{
        const fixed = applyTypoCorrections(state, normalized, typoInstance);
        setInputValue(input, fixed);
        return fixed;
      }catch(error){
        // Fall through to normalized text.
      }
    }

    setInputValue(input, normalized);
    return normalized;
  }

  /**
   * Pick the best transcript alternative from a recognition result.
   * @param {SpeechRecognitionResult|Array} result Recognition result.
   * @param {number} maxAlternatives Maximum alternatives to inspect.
   * @returns {string} Best candidate transcript.
   */
  function pickBestAlternative(result, maxAlternatives){
    const limit = Math.min(result.length || 1, maxAlternatives);
    let best = '';
    let bestScore = -Infinity;

    for(let index = 0; index < limit; index++){
      const candidate = (result[index] && result[index].transcript ? result[index].transcript : '').trim();
      if(!candidate) continue;

      const score = (candidate.match(/[أإآؤئء]/g) || []).length * 2 +
        (candidate.match(/ة\b/g) || []).length * 2 -
        (candidate.match(/ه\b/g) || []).length;

      if(score > bestScore){
        bestScore = score;
        best = candidate;
      }
    }

    return best || (result[0] && result[0].transcript ? result[0].transcript : '');
  }

  /**
   * Create a recognition instance and initialize its immutable settings.
   * @param {object} state Plugin state.
   * @returns {SpeechRecognition} Recognition instance.
   */
  function createRecognitionInstance(state){
    const recognition = new RecognitionClass();
    recognition.lang = getLang(state);
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = state.options.maxAlternatives;
    return recognition;
  }

  /**
   * Update the live input value while speech is still arriving.
   * @param {object} state Plugin state.
   * @param {string} interimTranscript Interim transcript fragment.
   */
  function updateLiveInput(state, interimTranscript){
    const merged = shrinkSpaces(state.sessionBaseText + ' ' + interimTranscript);
    setInputValue(state.activeInput, normalizeLiveTranscript(merged));
  }

  /**
   * Commit the current final transcript chunk and refresh the session base.
   * @param {object} state Plugin state.
   */
  function commitFinalChunk(state){
    const toCommit = shrinkSpaces(state.sessionBaseText + ' ' + state.finalTranscript);
    commitField(state, state.activeInput, toCommit);
    state.sessionBaseText = shrinkSpaces(getInputValue(state.activeInput));
    state.finalTranscript = '';
  }

  /**
   * Handle speech recognition results.
   * @param {SpeechRecognitionEvent} event Recognition event.
   * @param {object} state Plugin state.
   * @param {object} refs DOM references.
   * @param {object} logger Logger instance.
   */
  function handleRecognitionResult(event, state, refs, logger){
    let interim = '';

    for(let index = event.resultIndex; index < event.results.length; index++){
      const transcript = pickBestAlternative(event.results[index], state.options.maxAlternatives);
      if(event.results[index].isFinal){
        state.finalTranscript += transcript + ' ';
        commitFinalChunk(state);
      }else{
        interim += transcript;
      }
    }

    updateLiveInput(state, interim);
    logger.debug('mmf: recognition result updated');
  }

  /**
   * Handle speech recognition errors.
   * @param {SpeechRecognitionErrorEvent} event Recognition error event.
   * @param {object} state Plugin state.
   * @param {object} refs DOM references.
   * @param {object} logger Logger instance.
   */
  function handleRecognitionError(event, state, refs, logger){
    state.recognitionHadError = true;

    const code = event && event.error ? event.error : 'unknown';
    const message = describeError(code);

    if(code === 'aborted'){
      setStatus(refs, CONFIG.statuses.stopped, 'success');
      return;
    }

    if(code === 'language-not-supported'){
      const nextLanguage = rotateLang(state);
      setStatus(refs, message + ' تم التبديل إلى ' + nextLanguage, 'error');
      return;
    }

    if(code === 'phrases-not-supported'){
      state.phraseHintsEnabled = false;
      state.retryWithoutPhrases = true;
      setStatus(refs, 'المتصفح لا يدعم phrases. إعادة المحاولة بدونها...', 'error');
      return;
    }

    const details = event && event.message ? ' (' + event.message + ')' : '';
    setStatus(refs, message + ' [' + code + ']' + details, 'error');
    logger.warn('mmf: recognition error', code, event && event.message ? event.message : '');
  }

  /**
   * Schedule auto-stop for the active recognition session.
   * @param {object} state Plugin state.
   * @param {object} refs DOM references.
   * @param {object} logger Logger instance.
   */
  function scheduleAutoStop(state, refs, logger){
    clearAutoStop(state);
    state.autoStopTimer = setTimeout(function(){
      if(state.recognition){
        setStatus(refs, CONFIG.statuses.autoStopped, 'success');
        logger.debug('mmf: auto stop triggered');
        state.recognition.stop();
      }
    }, state.options.maxRecordingMs);
  }

  /**
   * Finish a recognition session and reset the local state.
   * @param {object} state Plugin state.
   * @param {object} refs DOM references.
   * @param {object} logger Logger instance.
   */
  function finalizeRecognition(state, refs, logger){
    if(state.activeInput){
      commitField(state, state.activeInput, getInputValue(state.activeInput));
    }

    if(state.retryWithoutPhrases && state.activeButton){
      const button = state.activeButton;
      resetRecognitionState(state);
      setTimeout(function(){
        startRecognition(button, state, refs, logger);
      }, 120);
      return;
    }

    if(!state.recognitionHadError){
      setStatus(refs, CONFIG.statuses.commitDone, 'success');
    }

    resetRecognitionState(state);
  }

  /**
   * Bind recognition lifecycle callbacks to the current instance.
   * @param {SpeechRecognition} recognition Recognition instance.
   * @param {object} state Plugin state.
   * @param {object} refs DOM references.
   * @param {object} logger Logger instance.
   */
  function bindRecognitionHandlers(recognition, state, refs, logger){
    recognition.onresult = function(event){
      handleRecognitionResult(event, state, refs, logger);
    };

    recognition.onerror = function(event){
      handleRecognitionError(event, state, refs, logger);
    };

    recognition.onend = function(){
      finalizeRecognition(state, refs, logger);
    };
  }

  /**
   * Start speech recognition for a given mic button.
   * @param {HTMLElement} button Mic button.
   * @param {object} state Plugin state.
   * @param {object} refs DOM references.
   * @param {object} logger Logger instance.
   */
  function startRecognition(button, state, refs, logger){
    logger.debug('mmf: startRecognition called', button);

    if(!RecognitionClass){
      setStatus(refs, 'التعرف الصوتي غير مدعوم. استخدم Chrome/Edge.', 'error');
      return;
    }

    if(state.recognition){
      if(button === state.activeButton){
        stopRecognition(state);
      }else{
        setStatus(refs, 'يوجد تسجيل شغال.', 'error');
      }
      return;
    }

    const targetInput = resolveTarget(refs, button);
    if(!targetInput){
      setStatus(refs, 'تعذر تحديد الحقل المستهدف.', 'error');
      return;
    }

    state.sessionBaseText = shrinkSpaces(getInputValue(targetInput));
    state.finalTranscript = '';
    state.recognitionHadError = false;
    state.activeButton = button;
    state.activeInput = targetInput;

    setButtonState(button, true);
    setStatus(refs, CONFIG.statuses.listening, '');

    const recognition = createRecognitionInstance(state);
    state.recognition = recognition;

    if(state.phraseHintsEnabled && 'phrases' in recognition && typeof window.SpeechRecognitionPhrase === 'function'){
      try{
        recognition.phrases = (state.options.phraseHints || []).map(function(phrase){
          return new window.SpeechRecognitionPhrase(phrase, 5.0);
        });
      }catch(error){
        logger.warn('mmf: phrase hints setup failed', error);
      }
    }

    bindRecognitionHandlers(recognition, state, refs, logger);

    try{
      recognition.start();
      scheduleAutoStop(state, refs, logger);
    }catch(error){
      logger.error('mmf: recognition start failed', error);
      setStatus(refs, 'تعذر بدء التسجيل.', 'error');
      resetRecognitionState(state);
    }
  }

  /**
   * Bind UI events using native DOM listeners for lower overhead.
   * @param {object} refs DOM references.
   * @param {object} state Plugin state.
   * @param {object} logger Logger instance.
   */
  function bindUi(refs, state, logger){
    refs.$root.on('click' + EVENT_NAMESPACE, '.mic-btn', function(){
      logger.debug('mmf: mic clicked', this, $(this).data('target') || '');
      startRecognition(this, state, refs, logger);
    });

    refs.$root.on('focusout' + EVENT_NAMESPACE, CONFIG.selectors.inputs, function(){
      commitField(state, this, getInputValue(this));
    });

    refs.$review.on('click' + EVENT_NAMESPACE, function(){
      if(!refs.inputEls.length){
        setStatus(refs, CONFIG.statuses.noInputs, 'error');
        return;
      }

      const values = refs.inputEls.slice(0, 2).map(function(input){
        return commitField(state, input, getInputValue(input));
      });
      const first = values[0] || '';
      const second = values[1] || '';

      if(!first && !second){
        setStatus(refs, CONFIG.statuses.emptySave, 'error');
        return;
      }

      setStatus(refs, CONFIG.statuses.saved, 'success');

      if(typeof state.options.onSave === 'function'){
        state.options.onSave({
          firstValue: first,
          secondValue: second,
          raw: { first: first, second: second }
        });
      }

      refs.$root.trigger('mmf:save', { firstValue: first, secondValue: second });

      try{
        refs.rootEl.dispatchEvent(new CustomEvent('mmf:save', {
          detail: { firstValue: first, secondValue: second }
        }));
      }catch(error){
        logger.warn('mmf: custom event dispatch failed', error);
      }
    });
  }

  /**
   * Build the public API for a single root instance.
   * @param {object} state Plugin state.
   * @param {object} refs DOM references.
   * @param {object} logger Logger instance.
   * @returns {{startMicForTarget:Function,normalize:Function}} Public API.
   */
  function createPublicApi(state, refs, logger){
    const publicApi = {
      /**
       * Start recording for a target input selector or id.
       * @param {string} target Target selector or id.
       * @returns {boolean} Whether a matching mic button was found.
       */
      startMicForTarget: function(target){
        const rawTarget = target || '';
        const selector = rawTarget.charAt(0) === '#' || rawTarget.charAt(0) === '.' ? rawTarget : '#' + rawTarget;
        const input = refs.$root.find(selector).get(0) || $(selector).get(0);
        if(!input) return false;

        const button = refs.micEls.find(function(micButton){
          const targetRef = micButton.dataset ? micButton.dataset.target : '';
          return targetRef === input.id || targetRef === '#' + input.id;
        });

        if(!button) return false;

        startRecognition(button, state, refs, logger);
        return true;
      },

      /**
       * Expose the same Arabic normalization used internally.
       * @param {string} text Input text.
       * @returns {string} Normalized text.
       */
      normalize: function(text){
        return normalizeArabicTranscript(text);
      },

      /**
       * Tear down event handlers and stop any active recognition session.
       */
      destroy: function(){
        stopRecognition(state);
        resetRecognitionState(state);
        refs.$root.off(EVENT_NAMESPACE);
        refs.$review.off(EVENT_NAMESPACE);
        if(window.__mmf === publicApi){
          window.__mmf = null;
        }
      }
    };

    return publicApi;
  }

  /**
   * Initialize the plugin for a single root.
   * @param {jQuery} $root Root wrapper.
   * @param {object} options Plugin options.
   * @returns {object} Public API.
   */
  function pluginFactory($root, options){
    const rootEl = $root.get(0);
    if(!rootEl) throw new Error('mmf: root element not found');

    const logger = createLogger('mmf');
    const resolvedOptions = $.extend({}, CONFIG.defaults, options || {});
    const refs = collectDomRefs(rootEl);
    const state = createState(resolvedOptions);

    assertDomRefs(refs);
    bindUi(refs, state, logger);

    setStatus(refs, CONFIG.statuses.ready, 'success');
    void loadLocalDictionary(state, refs, logger);

    return createPublicApi(state, refs, logger);
  }

  $.fn.voiceMedicalForm = function(options){
    const results = this.map(function(){
      return pluginFactory($(this), options);
    }).get();

    if(results.length === 1){
      window.__mmf = results[0];
    }

    return this;
  };

  /**
   * Auto-bootstrap the first demo root when present.
   */
  $(function(){
    const $demo = $('.mmf-root').first();
    if($demo.length && $demo.find('.mic-btn').length){
      $demo.voiceMedicalForm();
    }
  });

})(jQuery);
