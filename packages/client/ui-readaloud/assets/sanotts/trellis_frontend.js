/* trellis_frontend.js -- browser-side Misaki/Kokoro phoneme frontend for the
 * Trellis-RIFT English model.
 *
 * WHAT THIS IS
 * ------------
 * A verbatim JavaScript port of the Python path that produced the model's
 * training/packaging contract:
 *
 *   phonemizer.backend.EspeakBackend(language='en-us',
 *       preserve_punctuation=True, with_stress=True, tie='^')
 *     -> misaki.espeak.EspeakFallback.__call__   (the E2M rewrite table)
 *       -> saanotts.kokoro_frontend.phonemes_to_token_ids
 *
 * The espeak-ng call itself is NOT reimplemented: it runs the same espeak-ng
 * 1.52.0 translator compiled to WebAssembly (mcu/ports/wasm/snt_g2p_wasm.c,
 * export `snt_g2p_text_to_ipa`) against the byte-identical en_dict. Everything
 * layered on top of espeak by phonemizer and misaki -- punctuation
 * preserve/restore, line post-processing, the tie rewrite, the E2M table -- is
 * ported here, rule for rule, in the same order.
 *
 * PORTED FROM (phonemizer 3.3.2, misaki 0.9.4):
 *   phonemizer/punctuation.py        Punctuation.preserve / _preserve_line / restore
 *   phonemizer/backend/base.py       BaseBackend.phonemize
 *   phonemizer/backend/espeak/espeak.py  EspeakBackend._phonemize_aux / _postprocess_line
 *   phonemizer/backend/espeak/wrapper.py EspeakWrapper.text_to_phonemes (in the C shim)
 *   misaki/espeak.py                 EspeakFallback.E2M and __call__
 *   saanotts/kokoro_frontend.py      validate_frontend / phonemes_to_token_ids
 *
 * DO NOT "improve" any rule here. The rules are the model's input contract;
 * a nicer rule is a wrong rule.
 *
 * LOADING
 * -------
 * Plain <script> (same as web/index.html loads snt_g2p.js): it defines the
 * global `SaanoTrellisFrontend`. It is also loadable in node via
 * vm.runInThisContext(fs.readFileSync(...)).
 *
 * This file does not touch the legacy Piper voice pipeline in any way.
 */
(function (root) {
  "use strict";

  /* ---------------------------------------------------------------- vocab */

  /* The frozen 62-symbol vocabulary embedded in the Trellis-RIFT package
   * (payload["frontend"]["vocabulary"] of
   * trellis-rift-text-to-wave-995058-v2.pt). Kept here so the browser can run
   * without fetching the checkpoint; validateFrontend() below re-checks it
   * against a package-supplied copy whenever one is available. */
  var DEFAULT_VOCABULARY = {
    "<pad>": 0, "<bos>": 1, "<eos>": 2,
    " ": 3, "!": 4, "\"": 5, "(": 6, ")": 7, ",": 8, ".": 9, ":": 10, ";": 11,
    "?": 12, "A": 13, "I": 14, "O": 15, "T": 16, "W": 17, "Y": 18, "b": 19,
    "d": 20, "f": 21, "h": 22, "i": 23, "j": 24, "k": 25, "l": 26, "m": 27,
    "n": 28, "p": 29, "s": 30, "t": 31, "u": 32, "v": 33, "w": 34, "z": 35,
    "æ": 36, "ð": 37, "ŋ": 38, "ɐ": 39, "ɑ": 40,
    "ɔ": 41, "ə": 42, "ɛ": 43, "ɜ": 44, "ɡ": 45,
    "ɪ": 46, "ɹ": 47, "ʃ": 48, "ʊ": 49, "ʌ": 50,
    "ʒ": 51, "ʤ": 52, "ʧ": 53, "ˈ": 54, "ˌ": 55,
    "θ": 56, "ᵊ": 57, "ᵻ": 58, "—": 59, "“": 60,
    "”": 61
  };

  var SPECIAL_IDS = { "<pad>": 0, "<bos>": 1, "<eos>": 2 };
  var DEFAULT_MAX_TOKENS = 207;   /* configs.front.max_tokens */

  /* ---------------------------------------------------- error type ------ */

  /* Every failure path throws; nothing is swallowed. `kind` lets callers tell
   * an expected rejection (too long / empty) from a real bug. */
  function FrontendError(kind, message) {
    var e = new Error(message);
    e.name = "TrellisFrontendError";
    e.kind = kind;
    return e;
  }

  /* ------------------------------------------------- punctuation -------- */

  /* phonemizer/punctuation.py: _DEFAULT_MARKS */
  var DEFAULT_MARKS = ";:,.!?¡¿—…\"«»“”(){}[]";

  function marksCharClass(marks) {
    var out = "";
    for (var i = 0; i < marks.length; i++) {
      var cp = marks.charCodeAt(i);
      out += "\\u" + ("0000" + cp.toString(16)).slice(-4);
    }
    return out;
  }

  /* Python: re.compile(fr'(\s*[{re.escape(marks)}]+\s*)+') */
  function buildMarksRe(marks) {
    return new RegExp("(\\s*[" + marksCharClass(marks) + "]+\\s*)+", "g");
  }

  function findAll(re, line) {
    re.lastIndex = 0;
    var matches = [];
    var m;
    while ((m = re.exec(line)) !== null) {
      matches.push({ text: m[0], start: m.index });
      if (m[0].length === 0) { re.lastIndex++; }  /* cannot happen: [..]+ */
    }
    return matches;
  }

  /* phonemizer/punctuation.py: Punctuation._preserve_line */
  function preserveLine(line, num, marksRe) {
    var matches = findAll(marksRe, line);
    if (matches.length === 0) return { lines: [line], marks: [] };

    /* the line is made only of punctuation marks */
    if (matches.length === 1 && matches[0].text === line) {
      return { lines: [], marks: [{ index: num, mark: line, position: "A" }] };
    }

    var marks = [];
    for (var i = 0; i < matches.length; i++) {
      var position = "I";
      if (i === 0 && line.indexOf(matches[i].text) === 0) position = "B";
      else if (i === matches.length - 1 &&
               line.lastIndexOf(matches[i].text) === line.length - matches[i].text.length) {
        position = "E";
      }
      marks.push({ index: num, mark: matches[i].text, position: position });
    }

    /* split the line into sublines, each separated by a punctuation mark */
    var preserved = [];
    var rest = line;
    for (var j = 0; j < marks.length; j++) {
      var split = rest.split(marks[j].mark);
      var prefix = split[0];
      var suffix = split.slice(1).join(marks[j].mark);
      preserved.push(prefix);
      rest = suffix;
    }
    preserved.push(rest);
    return { lines: preserved, marks: marks };
  }

  /* phonemizer/punctuation.py: Punctuation.preserve */
  function preserve(textLines, marksRe) {
    var preservedText = [];
    var preservedMarks = [];
    for (var num = 0; num < textLines.length; num++) {
      var r = preserveLine(textLines[num], num, marksRe);
      preservedText = preservedText.concat(r.lines);
      preservedMarks = preservedMarks.concat(r.marks);
    }
    var kept = [];
    for (var k = 0; k < preservedText.length; k++) {
      if (preservedText[k]) kept.push(preservedText[k]);   /* drops '' chunks */
    }
    return { lines: kept, marks: preservedMarks };
  }

  /* phonemizer/punctuation.py: Punctuation.restore */
  function restore(textLines, marks, sepWord, strip) {
    var text = textLines.slice();
    var pending = marks.slice();
    var out = [];
    var pos = 0;
    var guard = 0;

    while (text.length || pending.length) {
      if (guard++ > 100000) {
        throw FrontendError("internal", "punctuation restore did not terminate");
      }
      if (!pending.length) {
        for (var i = 0; i < text.length; i++) {
          var line = text[i];
          if (!strip && sepWord && line.slice(-sepWord.length) !== sepWord) line = line + sepWord;
          out.push(line);
        }
        text = [];
      } else if (!text.length) {
        var joined = "";
        for (var j = 0; j < pending.length; j++) joined += pending[j].mark;
        out.push(joined.split(" ").join(sepWord));
        pending = [];
      } else {
        var current = pending[0];
        if (current.index === pos) {
          pending = pending.slice(1);
          var mark = current.mark.split(" ").join(sepWord);
          if (sepWord && text[0].slice(-sepWord.length) === sepWord) {
            text[0] = text[0].slice(0, text[0].length - sepWord.length);
          }
          if (current.position === "B") {
            text[0] = mark + text[0];
          } else if (current.position === "E") {
            out.push(text[0] + mark +
                     ((strip || mark.slice(-sepWord.length) === sepWord) ? "" : sepWord));
            text = text.slice(1);
            pos += 1;
          } else if (current.position === "A") {
            out.push(mark + ((strip || mark.slice(-sepWord.length) === sepWord) ? "" : sepWord));
            pos += 1;
          } else {   /* position === 'I' */
            if (text.length === 1) {
              text[0] = text[0] + mark;
            } else {
              var firstWord = text[0];
              text = text.slice(1);
              text[0] = firstWord + mark + text[0];
            }
          }
        } else {
          out.push(text[0]);
          text = text.slice(1);
          pos += 1;
        }
      }
    }
    return out;
  }

  /* ------------------------------------------- espeak line post-process - */

  var TIE_DEFAULT = "͡";   /* the tie espeak actually emits */
  var TIE_MISAKI = "^";         /* the tie misaki asks phonemizer for */

  /* phonemizer/backend/espeak/espeak.py: EspeakBackend._postprocess_line,
   * specialized for with_stress=True, tie='^', strip=False,
   * language_switch='keep-flags' (identity), separator=default (word=' ').
   *
   * Returns null for the `if not line: return ''` branch marker -- callers get
   * the empty string, same as python. */
  function postprocessLine(line) {
    line = line.trim().split("\n").join(" ").split("  ").join(" ");
    line = line.replace(/_+/g, "_");
    line = line.replace(/_ /g, " ");
    /* KeepFlags.process() returns the utterance unchanged */
    if (!line) return "";

    var words = line.split(" ");
    var outLine = "";
    for (var i = 0; i < words.length; i++) {
      /* _process_stress is the identity when with_stress=True */
      var word = words[i].trim();
      /* strip=False but tie is not None -> no '_' is appended */
      /* _process_tie: tie != '͡' -> replace the default tie by the requested one */
      word = word.split(TIE_DEFAULT).join(TIE_MISAKI);
      outLine += word + " ";
    }
    /* strip=False -> the trailing word separator is kept */
    return outLine;
  }

  /* ---------------------------------------------------------- E2M -------- */

  /* misaki/espeak.py: EspeakFallback.E2M, already in the exact order python
   * produces (sorted by -len(key), stable over the dict's insertion order).
   * Verified against:
   *   python -c "from misaki.espeak import EspeakFallback; print(EspeakFallback.E2M)"
   */
  var SYLLABIC = "̩";   /* COMBINING VERTICAL LINE BELOW, python chr(809) */
  var NASAL = "̃";      /* COMBINING TILDE */

  var E2M = [
    ["ʔˌn" + SYLLABIC, "ʔn"],
    ["ʔn" + SYLLABIC, "ʔn"],
    ["a^ɪ", "I"],
    ["a^ʊ", "W"],
    ["d^ʒ", "ʤ"],
    ["e^ɪ", "A"],
    ["t^ʃ", "ʧ"],
    ["ɔ^ɪ", "Y"],
    ["ə^l", "ᵊl"],
    ["ʲo", "jo"],
    ["ʲə", "jə"],
    ["e", "A"],
    ["ʲ", ""],
    ["ɚ", "əɹ"],
    ["r", "ɹ"],
    ["x", "k"],
    ["ç", "k"],
    ["ɐ", "ə"],
    ["ɬ", "l"],
    [NASAL, ""]
  ];

  function replaceAll(haystack, needle, replacement) {
    if (needle === "") return haystack;
    return haystack.split(needle).join(replacement);
  }

  /* misaki/espeak.py: EspeakFallback.__call__ tail, british=False, version=None */
  function applyE2M(ps) {
    ps = ps.trim();
    for (var i = 0; i < E2M.length; i++) {
      ps = replaceAll(ps, E2M[i][0], E2M[i][1]);
    }
    /* re.sub(r'(\S)̩', r'ᵊ\1', ps).replace(chr(809), '') */
    ps = ps.replace(new RegExp("(\\S)" + SYLLABIC, "g"), "ᵊ$1");
    ps = replaceAll(ps, SYLLABIC, "");

    ps = replaceAll(ps, "o^ʊ", "O");
    ps = replaceAll(ps, "ɜːɹ", "ɜɹ");
    ps = replaceAll(ps, "ɜː", "ɜɹ");
    ps = replaceAll(ps, "ɪə", "iə");
    ps = replaceAll(ps, "ː", "");

    ps = replaceAll(ps, "o", "ɔ");            /* for espeak < 1.52 */
    ps = replaceAll(ps, "ɾ", "T");            /* version != '2.0' */
    ps = replaceAll(ps, "ʔ", "t");
    return replaceAll(ps, "^", "");
  }

  /* ------------------------------------------------------- tokenizer ----- */

  /* saanotts/kokoro_frontend.py: validate_frontend */
  function validateFrontend(frontend, expectedVocabSize) {
    if (!frontend || typeof frontend !== "object") {
      throw FrontendError("frontend", "frontend metadata must be an object");
    }
    if (frontend.type !== "misaki_en_character_phonemes") {
      throw FrontendError("frontend", "unexpected frontend type " + JSON.stringify(frontend.type));
    }
    if (frontend.tokenizer !== "unicode_character") {
      throw FrontendError("frontend", "frontend tokenizer must be unicode_character");
    }
    if (frontend.unknown_policy !== "drop_like_kokoro") {
      throw FrontendError("frontend", "frontend unknown policy changed");
    }
    var vocab = frontend.vocabulary;
    if (!vocab || typeof vocab !== "object" || Object.keys(vocab).length === 0) {
      throw FrontendError("frontend", "frontend vocabulary must be a non-empty object");
    }
    var symbols = Object.keys(vocab);
    for (var i = 0; i < symbols.length; i++) {
      if (typeof vocab[symbols[i]] !== "number" || !Number.isInteger(vocab[symbols[i]])) {
        throw FrontendError("frontend", "frontend vocabulary must map strings to integer IDs");
      }
    }
    for (var special in SPECIAL_IDS) {
      if (vocab[special] !== SPECIAL_IDS[special]) {
        throw FrontendError("frontend", "frontend requires " + special + "=" + SPECIAL_IDS[special]);
      }
    }
    var ids = symbols.map(function (s) { return vocab[s]; }).sort(function (a, b) { return a - b; });
    for (var j = 0; j < ids.length; j++) {
      if (ids[j] !== j) {
        throw FrontendError("frontend", "frontend vocabulary IDs must be unique and contiguous from zero");
      }
    }
    if (expectedVocabSize != null && symbols.length !== expectedVocabSize) {
      throw FrontendError("frontend", "frontend vocabulary has " + symbols.length +
                          " entries, expected " + expectedVocabSize);
    }
    var normalized = {};
    for (var k = 0; k < symbols.length; k++) normalized[symbols[k]] = vocab[symbols[k]];
    return normalized;
  }

  /* saanotts/kokoro_frontend.py: phonemes_to_token_ids
   *
   * Iterates UTF-16 code units the way python iterates code points -- every
   * vocabulary symbol is BMP and single-code-unit, so an astral character can
   * only ever be dropped, which is what python does with it too. */
  function phonemesToTokenIds(phonemes, vocabulary, maxTokens) {
    if (typeof phonemes !== "string") {
      throw FrontendError("type", "phonemes must be a string");
    }
    if (maxTokens < 2) {
      throw FrontendError("config", "max_tokens must allow BOS and EOS");
    }
    var kept = [];
    var dropped = "";
    for (var i = 0; i < phonemes.length; i++) {
      var ch = phonemes[i];
      var known = Object.prototype.hasOwnProperty.call(vocabulary, ch);
      if (known && !Object.prototype.hasOwnProperty.call(SPECIAL_IDS, ch)) kept.push(ch);
      if (!known) dropped += ch;
    }
    if (!kept.length) {
      throw FrontendError("empty", "phonemization produced no symbols in the packaged vocabulary");
    }
    var ids = [SPECIAL_IDS["<bos>"]];
    for (var j = 0; j < kept.length; j++) ids.push(vocabulary[kept[j]] | 0);
    ids.push(SPECIAL_IDS["<eos>"]);
    if (ids.length > maxTokens) {
      throw FrontendError("too_long", "phoneme sequence has " + ids.length +
                          " tokens including BOS/EOS; maximum is " + maxTokens);
    }
    return { ids: ids, dropped: dropped };
  }

  /* ------------------------------------------------- wasm espeak bridge -- */

  /* Wraps the Emscripten module built by mcu/ports/wasm/build_g2p.sh.
   * `snt_g2p_text_to_ipa` is a NEW export; `snt_g2p_text_to_ids` and the Piper
   * id tables are untouched by this file. */
  function makeEspeakIpa(module, options) {
    options = options || {};
    var bufBytes = options.bufferBytes || 16384;
    if (typeof module._snt_g2p_text_to_ipa !== "function" &&
        typeof module.cwrap !== "function") {
      throw FrontendError("wasm", "g2p module exposes neither _snt_g2p_text_to_ipa nor cwrap");
    }
    var call = typeof module._snt_g2p_text_to_ipa === "function"
      ? module._snt_g2p_text_to_ipa
      : module.cwrap("snt_g2p_text_to_ipa", "number", ["number", "number", "number"]);

    var RC = {
      "-1": "bad arguments or espeak init failure",
      "-2": "could not select the en-us voice",
      "-3": "output buffer too small (raise bufferBytes)",
      "-4": "espeak clause loop did not terminate",
      "-5": "could not restore the previously selected espeak voice"
    };

    return function espeakIpa(text) {
      var nBytes = module.lengthBytesUTF8(text) + 1;
      var textPtr = module._malloc(nBytes);
      var outPtr = module._malloc(bufBytes);
      if (!textPtr || !outPtr) {
        if (textPtr) module._free(textPtr);
        if (outPtr) module._free(outPtr);
        throw FrontendError("wasm", "out of wasm heap while phonemizing");
      }
      try {
        module.stringToUTF8(text, textPtr, nBytes);
        var rc = call(textPtr, outPtr, bufBytes);
        if (rc < 0) {
          throw FrontendError("wasm", "snt_g2p_text_to_ipa failed: rc=" + rc +
                              " (" + (RC[String(rc)] || "unknown error") + ")");
        }
        return module.UTF8ToString(outPtr);
      } finally {
        module._free(textPtr);
        module._free(outPtr);
      }
    };
  }

  /* --------------------------------------------------------- frontend ---- */

  /* options:
   *   espeakIpa   function(text) -> raw espeak IPA with U+0361 ties (required
   *               unless `module` is given)
   *   module      an initialized snt_g2p.js Emscripten module
   *   frontend    the package's payload["frontend"] object (validated if given)
   *   vocabulary  explicit vocabulary (defaults to the package's frozen one)
   *   maxTokens   defaults to 207 (configs.front.max_tokens)
   */
  function createFrontend(options) {
    options = options || {};
    var espeakIpa = options.espeakIpa;
    if (!espeakIpa) {
      if (!options.module) {
        throw FrontendError("config", "createFrontend needs either `espeakIpa` or `module`");
      }
      espeakIpa = makeEspeakIpa(options.module, options);
    }
    var vocabulary = options.frontend
      ? validateFrontend(options.frontend, options.expectedVocabSize)
      : (options.vocabulary || DEFAULT_VOCABULARY);
    var maxTokens = options.maxTokens == null ? DEFAULT_MAX_TOKENS : options.maxTokens;
    var marksRe = buildMarksRe(options.punctuationMarks || DEFAULT_MARKS);

    /* phonemizer BaseBackend.phonemize([text]) for a single utterance */
    function phonemizeLines(text) {
      var pre = preserve([text], marksRe);
      var phonemized = [];
      for (var i = 0; i < pre.lines.length; i++) {
        phonemized.push(postprocessLine(espeakIpa(pre.lines[i])));
      }
      return restore(phonemized, pre.marks, " ", false);
    }

    /* misaki.espeak.EspeakFallback.__call__(token) */
    function phonemize(text) {
      if (typeof text !== "string") throw FrontendError("type", "text must be a string");
      var lines = phonemizeLines(text);
      if (!lines.length) {
        throw FrontendError("empty", "phonemizer returned no output for " + JSON.stringify(text));
      }
      return applyE2M(lines[0]);
    }

    function textToIds(text) {
      var phonemes = phonemize(text);
      var result = phonemesToTokenIds(phonemes, vocabulary, maxTokens);
      return { phonemes: phonemes, ids: result.ids, dropped: result.dropped };
    }

    return {
      phonemize: phonemize,
      phonemizeLines: phonemizeLines,
      textToIds: textToIds,
      phonemesToTokenIds: function (ps) { return phonemesToTokenIds(ps, vocabulary, maxTokens); },
      vocabulary: vocabulary,
      maxTokens: maxTokens
    };
  }

  root.SaanoTrellisFrontend = {
    createFrontend: createFrontend,
    makeEspeakIpa: makeEspeakIpa,
    validateFrontend: validateFrontend,
    phonemesToTokenIds: phonemesToTokenIds,
    applyE2M: applyE2M,
    postprocessLine: postprocessLine,
    preserve: preserve,
    restore: restore,
    buildMarksRe: buildMarksRe,
    DEFAULT_VOCABULARY: DEFAULT_VOCABULARY,
    DEFAULT_MARKS: DEFAULT_MARKS,
    DEFAULT_MAX_TOKENS: DEFAULT_MAX_TOKENS,
    E2M: E2M
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
