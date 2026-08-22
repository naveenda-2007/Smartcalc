/* =============================================================================
   SmartCalc — script.js
   Vanilla JavaScript. No frameworks, no eval().

   Contents:
     1. DOM references & state
     2. Theme (dark/light) handling
     3. Mode switch (basic/scientific)
     4. History (localStorage-backed)
     5. Expression builder (button + keyboard input)
     6. Safe expression parser/evaluator (tokenizer -> recursive-descent parser)
     7. Display rendering & error handling
     8. Copy-to-clipboard + toast
   ============================================================================= */

(function () {
  "use strict";

  /* ---------------------------------------------------------------------
     1. DOM references & state
  --------------------------------------------------------------------- */
  const expressionEl = document.getElementById("expression");
  const resultEl      = document.getElementById("result");
  const keypadEl      = document.getElementById("keypad");
  const modeSwitchEl  = document.querySelector(".mode-switch");
  const modeButtons   = document.querySelectorAll(".mode-btn");

  const themeToggle   = document.getElementById("themeToggle");
  const themeIcon     = document.getElementById("themeIcon");

  const historyToggle = document.getElementById("historyToggle");
  const historyPanel  = document.getElementById("historyPanel");
  const closeHistory  = document.getElementById("closeHistory");
  const clearHistory  = document.getElementById("clearHistory");
  const historyListEl = document.getElementById("historyList");
  const historyEmptyEl= document.getElementById("historyEmpty");

  const copyBtn       = document.getElementById("copyBtn");
  const toastEl       = document.getElementById("toast");

  const STORAGE_KEYS = {
    history: "smartcalc_history",
    theme: "smartcalc_theme"
  };
  const MAX_HISTORY = 40;

  // `expression` holds exactly what is shown on the top display line,
  // using display glyphs (× ÷ − π e sin cos tan log √ ^ %).
  let expression = "";
  // `lastResult` holds the last computed numeric result as a string,
  // used so pressing an operator right after "=" continues the chain.
  let lastResult = null;
  let justEvaluated = false;

  let history = loadHistory();

  /* ---------------------------------------------------------------------
     2. Theme (dark / light)
  --------------------------------------------------------------------- */
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    themeToggle.setAttribute("aria-pressed", theme === "light" ? "true" : "false");
    // Swap the icon: sun for light, moon for dark
    themeIcon.innerHTML = theme === "light"
      ? '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"/>'
      : '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
    localStorage.setItem(STORAGE_KEYS.theme, theme);
  }

  function initTheme() {
    const saved = localStorage.getItem(STORAGE_KEYS.theme);
    if (saved === "light" || saved === "dark") {
      applyTheme(saved);
      return;
    }
    // Fall back to the user's OS preference on first visit
    const prefersLight = window.matchMedia("(prefers-color-scheme: light)").matches;
    applyTheme(prefersLight ? "light" : "dark");
  }

  themeToggle.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme");
    applyTheme(current === "light" ? "dark" : "light");
  });

  /* ---------------------------------------------------------------------
     3. Mode switch (basic / scientific)
  --------------------------------------------------------------------- */
  function setMode(mode) {
    modeButtons.forEach((btn) => {
      const active = btn.dataset.mode === mode;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", String(active));
    });
    modeSwitchEl.setAttribute("data-active", mode);
    keypadEl.classList.toggle("is-scientific", mode === "scientific");
  }

  modeButtons.forEach((btn) => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  });

  /* ---------------------------------------------------------------------
     4. History (persisted to localStorage)
  --------------------------------------------------------------------- */
  function loadHistory() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.history);
      return raw ? JSON.parse(raw) : [];
    } catch (err) {
      // Corrupt or inaccessible storage shouldn't break the calculator
      console.warn("SmartCalc: could not read history from localStorage.", err);
      return [];
    }
  }

  function saveHistory() {
    try {
      localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(history));
    } catch (err) {
      console.warn("SmartCalc: could not persist history to localStorage.", err);
    }
  }

  function addHistoryEntry(expr, result) {
    history.unshift({ expr, result, ts: Date.now() });
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    saveHistory();
    renderHistory();
  }

  function renderHistory() {
    historyListEl.innerHTML = "";

    if (history.length === 0) {
      historyListEl.appendChild(historyEmptyEl);
      return;
    }

    history.forEach((entry) => {
      const li = document.createElement("li");
      li.className = "history-item";
      li.tabIndex = 0;
      li.setAttribute("role", "button");
      li.setAttribute("aria-label", `Recall ${entry.expr} equals ${entry.result}`);

      const exprDiv = document.createElement("div");
      exprDiv.className = "h-expr";
      exprDiv.textContent = entry.expr;

      const resultDiv = document.createElement("div");
      resultDiv.className = "h-result";
      resultDiv.textContent = entry.result;

      li.appendChild(exprDiv);
      li.appendChild(resultDiv);

      // Clicking a history row recalls that result into the display
      const recall = () => {
        expression = entry.result;
        lastResult = entry.result;
        justEvaluated = true;
        renderDisplay();
      };
      li.addEventListener("click", recall);
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); recall(); }
      });

      historyListEl.appendChild(li);
    });
  }

  function clearAllHistory() {
    history = [];
    saveHistory();
    renderHistory();
  }

  historyToggle.addEventListener("click", () => {
    const isOpen = historyPanel.classList.toggle("is-open");
    historyPanel.setAttribute("aria-hidden", String(!isOpen));
    historyToggle.setAttribute("aria-pressed", String(isOpen));
  });
  closeHistory.addEventListener("click", () => {
    historyPanel.classList.remove("is-open");
    historyPanel.setAttribute("aria-hidden", "true");
    historyToggle.setAttribute("aria-pressed", "false");
  });
  clearHistory.addEventListener("click", clearAllHistory);

  /* ---------------------------------------------------------------------
     5. Expression builder
  --------------------------------------------------------------------- */

  // Characters that count as a completed "operand" -- i.e. it's valid for
  // an operator, closing paren, or implicit-multiplication trigger to follow.
  const OPERAND_END = /[0-9)πe%]$/;
  const OPEN_TRIGGERS = new Set(["(", "sin", "cos", "tan", "log", "√", "π", "e"]);

  function lastChar() {
    return expression.slice(-1);
  }

  /** Appends text to the expression, inserting an implicit × where a human
   *  calculator user would expect one (e.g. "2π" or "5(3+1)"). */
  function append(text, { isOpenTrigger = false } = {}) {
    if (justEvaluated) {
      // Starting fresh after "=" — unless the new input continues the chain
      // with an operator, in which case we keep building from the result.
      const continuesChain = /^[+\-×÷%^]/.test(text);
      expression = continuesChain ? (lastResult ?? "") : "";
      justEvaluated = false;
    }

    if (isOpenTrigger && OPERAND_END.test(lastChar())) {
      expression += "×";
    }
    expression += text;
    renderDisplay();
  }

  function appendDigit(d) {
    append(d);
  }

  function appendDecimal() {
    // Prevent a second decimal point within the current number segment
    const trailingSegment = expression.split(/[+\-×÷%^()]/).pop();
    if (trailingSegment.includes(".")) return;
    append(expression === "" || /[+\-×÷%^(]$/.test(lastChar()) ? "0." : ".");
  }

  function appendOperator(op) {
    if (expression === "" && lastResult === null) {
      if (op !== "−") return; // only a leading minus is meaningful on empty input
      append(op);
      return;
    }
    if (expression === "" && lastResult !== null) {
      expression = lastResult; // continue from the previous result
    }
    // Replace a trailing operator instead of stacking two in a row
    if (/[+\-×÷%^]$/.test(lastChar())) {
      expression = expression.slice(0, -1) + op;
      renderDisplay();
      return;
    }
    append(op);
  }

  function appendParen(p) {
    append(p, { isOpenTrigger: p === "(" });
  }

  function appendFunction(name) {
    append(name + "(", { isOpenTrigger: true });
  }

  function appendConstant(sym) {
    append(sym, { isOpenTrigger: true });
  }

  function appendPercent() {
    if (!OPERAND_END.test(lastChar())) return;
    append("%");
  }

  /** Finds the trailing operand (a number, constant, or balanced parenthesised
   *  group) at the end of the expression so postfix keys (x², 1/x) can wrap it. */
  function findTrailingOperand() {
    if (expression === "") return null;

    if (lastChar() === ")") {
      let depth = 0;
      for (let i = expression.length - 1; i >= 0; i--) {
        if (expression[i] === ")") depth++;
        else if (expression[i] === "(") depth--;
        if (depth === 0) return expression.slice(i);
      }
      return null; // unbalanced — nothing sensible to wrap
    }

    const match = expression.match(/(\d+\.?\d*|\.\d+|π|e)$/);
    return match ? match[0] : null;
  }

  function appendSquare() {
    const operand = findTrailingOperand();
    if (!operand) return;
    expression = expression.slice(0, expression.length - operand.length) + `(${operand})^2`;
    renderDisplay();
  }

  function appendReciprocal() {
    const operand = findTrailingOperand();
    if (!operand) return;
    expression = expression.slice(0, expression.length - operand.length) + `1÷(${operand})`;
    renderDisplay();
  }

  function backspace() {
    if (justEvaluated) { clearAll(); return; }
    expression = expression.slice(0, -1);
    renderDisplay();
  }

  function clearAll() {
    expression = "";
    lastResult = null;
    justEvaluated = false;
    resultEl.classList.remove("is-error");
    renderDisplay();
  }

  /* ---------------------------------------------------------------------
     6. Safe expression parser / evaluator (no eval)

     Grammar:
       expression := term (('+'|'−') term)*
       term       := power (('×'|'÷') power)*
       power      := postfix ('^' power)?              (right-associative)
       postfix    := unary ('%')*
       unary      := '−' unary | primary
       primary    := NUMBER | CONST | '(' expression ')' | FUNC '(' expression ')'
  --------------------------------------------------------------------- */

  const FUNCTIONS = {
    sin: (x) => Math.sin(toRadians(x)),
    cos: (x) => Math.cos(toRadians(x)),
    tan: (x) => Math.tan(toRadians(x)),
    log: (x) => {
      if (x <= 0) throw new Error("Invalid input for log");
      return Math.log10(x);
    },
    "√": (x) => {
      if (x < 0) throw new Error("Invalid input for √");
      return Math.sqrt(x);
    }
  };

  function toRadians(deg) {
    return (deg * Math.PI) / 180;
  }

  function tokenize(expr) {
    const tokenPattern = /\d+\.?\d*|\.\d+|sin|cos|tan|log|√|π|e|[+\-×÷%^()]/g;
    const tokens = expr.match(tokenPattern);
    if (!tokens || tokens.join("") !== expr.replace(/\s+/g, "")) {
      throw new Error("Invalid expression");
    }
    return tokens;
  }

  function autoBalanceParens(tokens) {
    let open = 0;
    tokens.forEach((t) => {
      if (t === "(") open++;
      if (t === ")") open--;
    });
    while (open > 0) { tokens.push(")"); open--; }
    return tokens;
  }

  function createParser(tokens) {
    let pos = 0;
    const peek = () => tokens[pos];
    const next = () => tokens[pos++];

    function parseExpression() {
      let value = parseTerm();
      while (peek() === "+" || peek() === "−") {
        const op = next();
        const rhs = parseTerm();
        value = op === "+" ? value + rhs : value - rhs;
      }
      return value;
    }

    function parseTerm() {
      let value = parsePower();
      while (peek() === "×" || peek() === "÷") {
        const op = next();
        const rhs = parsePower();
        if (op === "÷") {
          if (rhs === 0) throw new Error("Cannot divide by zero");
          value = value / rhs;
        } else {
          value = value * rhs;
        }
      }
      return value;
    }

    function parsePower() {
      const base = parsePostfix();
      if (peek() === "^") {
        next();
        const exponent = parsePower(); // right-associative
        return Math.pow(base, exponent);
      }
      return base;
    }

    function parsePostfix() {
      let value = parseUnary();
      while (peek() === "%") {
        next();
        value = value / 100;
      }
      return value;
    }

    function parseUnary() {
      if (peek() === "−") {
        next();
        return -parseUnary();
      }
      return parsePrimary();
    }

    function parsePrimary() {
      const token = peek();

      if (token === undefined) throw new Error("Unexpected end of expression");

      if (/^\d/.test(token) || token.startsWith(".")) {
        next();
        return parseFloat(token);
      }

      if (token === "π") { next(); return Math.PI; }
      if (token === "e") { next(); return Math.E; }

      if (token === "(") {
        next();
        const value = parseExpression();
        if (peek() !== ")") throw new Error("Mismatched parentheses");
        next();
        return value;
      }

      if (FUNCTIONS[token]) {
        const fn = FUNCTIONS[token];
        next();
        if (peek() !== "(") throw new Error(`Expected "(" after ${token}`);
        next();
        const arg = parseExpression();
        if (peek() !== ")") throw new Error("Mismatched parentheses");
        next();
        return fn(arg);
      }

      throw new Error(`Unexpected token "${token}"`);
    }

    return {
      run() {
        const value = parseExpression();
        if (pos !== tokens.length) throw new Error("Unexpected trailing input");
        return value;
      }
    };
  }

  function evaluate(expr) {
    if (expr.trim() === "") return null;
    const tokens = autoBalanceParens(tokenize(expr));
    const value = createParser(tokens).run();
    if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
      throw new Error("Math error");
    }
    return value;
  }

  /** Formats a raw JS number for display: trims floating-point noise and
   *  switches to scientific notation for extreme magnitudes. */
  function formatNumber(num) {
    if (Object.is(num, -0)) num = 0;
    if (Math.abs(num) !== 0 && (Math.abs(num) >= 1e15 || Math.abs(num) < 1e-9)) {
      return num.toExponential(6).replace(/\.?0+e/, "e");
    }
    const rounded = Math.round((num + Number.EPSILON) * 1e10) / 1e10;
    return String(rounded);
  }

  /* ---------------------------------------------------------------------
     7. Display rendering & evaluate action
  --------------------------------------------------------------------- */
  function renderDisplay() {
    expressionEl.textContent = expression || "\u00A0";
    if (!justEvaluated) {
      // Live preview of the result as the user types, when it's already valid
      try {
        const preview = expression.trim() === "" ? null : evaluate(expression);
        resultEl.textContent = preview === null ? "0" : formatNumber(preview);
        resultEl.classList.remove("is-error");
      } catch {
        // Mid-typing expressions are often incomplete; keep showing the
        // last good number instead of flashing an error on every keystroke.
      }
    }
  }

  function showError(message) {
    resultEl.textContent = message;
    resultEl.classList.add("is-error");
  }

  function doEquals() {
    if (expression.trim() === "") return;
    try {
      const value = evaluate(expression);
      const formatted = formatNumber(value);
      addHistoryEntry(expression, formatted);
      resultEl.textContent = formatted;
      resultEl.classList.remove("is-error");
      lastResult = formatted;
      justEvaluated = true;
    } catch (err) {
      showError(
        /divide by zero/i.test(err.message) ? "Cannot divide by zero" : "Error"
      );
      justEvaluated = false;
    }
  }

  /* ---------------------------------------------------------------------
     Button wiring (single delegated listener + press animation)
  --------------------------------------------------------------------- */
  keypadEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".key");
    if (!btn) return;

    // Ripple/press animation
    btn.classList.remove("is-pressed");
    // eslint-disable-next-line no-unused-expressions
    void btn.offsetWidth; // restart animation
    btn.classList.add("is-pressed");

    const action = btn.dataset.action;
    const value = btn.dataset.value;

    switch (action) {
      case "digit": appendDigit(value); break;
      case "decimal": appendDecimal(); break;
      case "operator": appendOperator(value); break;
      case "paren": appendParen(value); break;
      case "func": appendFunction(value); break;
      case "sqrt": appendFunction(value); break;
      case "constant": appendConstant(value); break;
      case "percent": appendPercent(); break;
      case "square": appendSquare(); break;
      case "power": appendOperator("^"); break;
      case "reciprocal": appendReciprocal(); break;
      case "clear": clearAll(); break;
      case "backspace": backspace(); break;
      case "equals": doEquals(); break;
      default: break;
    }
  });

  /* ---------------------------------------------------------------------
     8. Keyboard support
  --------------------------------------------------------------------- */
  const KEY_OPERATOR_MAP = { "+": "+", "-": "−", "*": "×", "/": "÷", "%": "%", "^": "^" };

  window.addEventListener("keydown", (e) => {
    const { key } = e;

    if (/^[0-9]$/.test(key)) { appendDigit(key); return; }
    if (key === ".") { appendDecimal(); return; }
    if (key in KEY_OPERATOR_MAP) {
      e.preventDefault();
      if (key === "%") appendPercent();
      else appendOperator(KEY_OPERATOR_MAP[key]);
      return;
    }
    if (key === "(" || key === ")") { appendParen(key); return; }
    if (key === "Enter" || key === "=") { e.preventDefault(); doEquals(); return; }
    if (key === "Backspace") { backspace(); return; }
    if (key === "Escape") { clearAll(); return; }
  });

  /* ---------------------------------------------------------------------
     Copy result + toast
  --------------------------------------------------------------------- */
  function showToast(message) {
    toastEl.textContent = message;
    toastEl.classList.add("is-visible");
    window.clearTimeout(showToast._t);
    showToast._t = window.setTimeout(() => toastEl.classList.remove("is-visible"), 1800);
  }

  copyBtn.addEventListener("click", async () => {
    const text = resultEl.textContent;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for non-secure contexts / older browsers
        const temp = document.createElement("textarea");
        temp.value = text;
        temp.style.position = "fixed";
        temp.style.opacity = "0";
        document.body.appendChild(temp);
        temp.select();
        document.execCommand("copy");
        document.body.removeChild(temp);
      }
      showToast("Result copied");
    } catch (err) {
      console.warn("SmartCalc: copy failed.", err);
      showToast("Could not copy result");
    }
  });

  /* ---------------------------------------------------------------------
     Init
  --------------------------------------------------------------------- */
  initTheme();
  setMode("basic");
  renderHistory();
  renderDisplay();
})();