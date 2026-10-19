(() => {
  "use strict";

  const API = (window.GATE_API_BASE || "").replace(/\/$/, "");
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  const SLOTS = [
    { key: "affected_object", name: "Affected system", core: true },
    { key: "symptom", name: "What's happening", core: true },
    { key: "start_time", name: "When it started", core: true },
    { key: "impact", name: "Who's affected", core: true },
    { key: "error_details", name: "Error messages" },
    { key: "recent_changes", name: "Recent changes" },
    { key: "steps_taken", name: "What you've tried" },
  ];
  const CATEGORY_LABEL = {
    virtual_machine: "Virtual machine", windows_server: "Windows server",
    linux_server: "Linux server", storage: "Storage",
  };
  const ENV_LABEL = { production: "Production", uat: "UAT", development: "Development", dr: "DR" };
  const GROUP = {
    virtual_machine: "Virtualisation", windows_server: "Windows Server",
    linux_server: "Linux", storage: "Storage & Backup",
  };
  const EXAMPLES = {
    vague: "Server is very slow, please fix urgently.",
    partial: "Since about 8am today the VM is really slow and our app keeps timing out. Users are complaining.",
    good: "Since 08:15 today the loan origination app on this VM times out after about 30 seconds for everyone at the Rosebank branch (around 40 people), so they can't capture applications. Users see \"504 Gateway Timeout\". The VM was migrated to the new cluster in last night's change window. We restarted the app service at 09:00 but nothing changed.",
  };

  const state = {
    step: 1,
    mode: "unknown", // "ai" | "rules" | "unknown"
    checks: 0,
    answers: [],     // [{question, answer}]
    result: null,
    flagged: false,
    checkedText: "",
  };

  /* ---------- Connection to the Pydantic AI service ---------- */

  function setMode(mode) {
    state.mode = mode;
    const el = $("#mode");
    el.dataset.mode = mode;
    $("#mode-text").textContent = mode === "ai"
      ? "Context check: Claude via Pydantic AI"
      : mode === "rules" ? "Context check: built-in rules (AI service offline)"
      : "Connecting to context check…";
  }

  async function fetchJSON(url, opts = {}, timeoutMs = 10000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      const isJSON = (res.headers.get("content-type") || "").includes("application/json");
      const body = isJSON ? await res.json() : null;
      if (!res.ok || !isJSON) {
        const err = new Error((body && body.detail) || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  // Free hosting tiers sleep when idle, so keep pinging for a minute while the service wakes.
  async function warmUp(attempt = 0) {
    try {
      const h = await fetchJSON(`${API}/api/health`, {}, 15000);
      if (h && h.ok) return setMode("ai");
    } catch (_) { /* fall through */ }
    if (state.mode !== "ai") setMode("rules");
    if (attempt < 5) setTimeout(() => warmUp(attempt + 1), 12000);
  }

  /* ---------- Built-in rules (used when the AI service is unreachable) ---------- */

  const RULES = {
    symptom: [/slow|time(s|d)? ?out|timing out|down|unreachable|can'?t (connect|log|access|open)|cannot|fail|crash|hang|freez|unresponsive|not (respond|start|boot|load|work)|high cpu|memory|disk|full|latency|error/i],
    start_time: [/\b\d{1,2}[:h]\d{2}\b|\b\d{1,2}\s?(am|pm)\b|since|this morning|today|yesterday|last night|ago|monday|tuesday|wednesday|thursday|friday|saturday|sunday/i],
    impact: [/\b\d+\s*(users?|people|staff|branches|clients|customers)\b|everyone|all users|nobody|no one|branch|business|critical|outage|can'?t (work|capture|process|trade)|department|team|payments?|payroll/i],
    error_details: [/error|code|0x[0-9a-f]{3,}|exception|alert|event id|\b[45]\d\d\b|"[^"]{4,}"/i],
    recent_changes: [/patch|update|deploy|change|migrat|upgrade|reboot(ed)? (last|yesterday)|no changes|nothing changed|new (version|release)/i],
    steps_taken: [/tried|restart(ed)?|reboot(ed)?|cleared|checked|logged (off|out)|nothing yet|haven'?t tried|reinstall/i],
  };
  const QUESTIONS = {
    symptom: ["What exactly are you seeing? For example, an app timing out, a page not loading, or a login failing.", "\"Slow\" or \"broken\" can mean many things, so the specific symptom tells us where to look first."],
    start_time: ["When did this start? A rough time is fine.", "We match the time against monitoring and change records."],
    impact: ["Who is affected, and roughly how many people? What can't they do?", "Impact sets the priority and how fast someone is assigned."],
    error_details: ["Is there an error message or code? Copy it exactly if you can.", "Exact errors often point straight to the cause."],
    recent_changes: ["Was anything changed recently, like patches, a deployment or a reboot? \"Not that I know of\" is fine.", "Most incidents follow a change, so this saves a lot of digging."],
    steps_taken: ["Have you tried anything yet, like restarting the app or using another machine?", "So the engineer doesn't repeat what you've already done."],
  };

  function assessWithRules(draft) {
    const text = [draft.description, ...draft.follow_up_answers.map((a) => a.answer)].join("\n");
    const status = { affected_object: draft.affected_object ? "found" : "missing" };
    for (const [key, patterns] of Object.entries(RULES)) {
      const hit = patterns.some((p) => p.test(text));
      status[key] = hit ? "found" : "missing";
    }
    if (status.symptom === "found" && text.trim().split(/\s+/).length < 8) status.symptom = "partial";

    const core = ["affected_object", "symptom", "start_time", "impact"];
    const support = ["error_details", "recent_changes", "steps_taken"];
    const coreOk = core.every((k) => status[k] === "found");
    const supportN = support.filter((k) => status[k] !== "missing").length;
    const open = coreOk && supportN >= 2;

    let score = 0;
    for (const k of core) score += status[k] === "found" ? 18 : status[k] === "partial" ? 9 : 0;
    for (const k of support) score += status[k] === "found" ? 9 : status[k] === "partial" ? 4 : 0;

    const follow_ups = open ? [] : [...core, ...support]
      .filter((k) => status[k] !== "found" && QUESTIONS[k])
      .filter((k) => core.includes(k) || !coreOk || supportN < 2)
      .slice(0, 3)
      .map((k) => ({ key: k, question: QUESTIONS[k][0], why: QUESTIONS[k][1] }));

    const prod = draft.environment === "production";
    const wide = /\b([2-9]\d|\d{3,})\s*(users?|people|staff)|everyone|all users|outage|down\b/i.test(text);
    const priority = prod && wide ? "P2" : prod ? "P3" : "P4";
    const firstSentence = draft.description.split(/(?<=[.!?])\s/)[0].slice(0, 220);

    return {
      verdict: open ? "enough_context" : "needs_more_context",
      score: Math.min(score, 100),
      slots: SLOTS.map((s) => ({ key: s.key, status: status[s.key], evidence: null })),
      follow_ups,
      customer_message: open
        ? "That's everything an engineer needs to get started."
        : "A few details are missing. Answering the questions below means nobody needs to call you back.",
      engineer_summary: `${CATEGORY_LABEL[draft.category]} ${draft.affected_object} (${ENV_LABEL[draft.environment]}): ${firstSentence}`,
      suggested_priority: priority,
      resolver_group: GROUP[draft.category],
    };
  }

  /* ---------- Rendering ---------- */

  function renderSlots(result) {
    const list = $("#slots");
    list.replaceChildren();
    const byKey = Object.fromEntries((result ? result.slots : []).map((s) => [s.key, s]));
    for (const s of SLOTS) {
      const slot = byKey[s.key];
      const li = document.createElement("li");
      li.className = "slot";
      if (slot) li.dataset.status = slot.status;

      const icon = document.createElement("span");
      icon.className = "slot-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = slot ? { found: "✓", partial: "~", missing: "" }[slot.status] : "";

      const name = document.createElement("span");
      name.className = "slot-name";
      name.textContent = s.name;
      if (s.core) {
        const c = document.createElement("span");
        c.className = "slot-core";
        c.textContent = "required";
        name.append(c);
      }
      const sr = document.createElement("span");
      sr.className = "sr-only";
      sr.textContent = slot ? `: ${slot.status}` : ": not checked";
      name.append(sr);

      li.append(icon, name);
      if (slot && slot.evidence) {
        const ev = document.createElement("span");
        ev.className = "slot-evidence";
        ev.textContent = slot.evidence;
        li.append(ev);
      }
      list.append(li);
    }
  }

  function setGate(gateState, label, message, score) {
    const gate = $("#gate");
    gate.dataset.state = gateState;
    $("#gate-state").textContent = label;
    if (message !== undefined) $("#gate-msg").textContent = message;
    if (score !== undefined) $("#meter-fill").style.width = `${score}%`;
  }

  function renderFollowUps(items) {
    const wrap = $("#followups");
    const list = $("#followup-list");
    list.replaceChildren();
    wrap.hidden = !items.length;
    items.forEach((f, i) => {
      const div = document.createElement("div");
      div.className = "fu";
      const id = `fu-${i}`;
      const label = document.createElement("label");
      label.className = "label";
      label.htmlFor = id;
      label.textContent = f.question;
      const why = document.createElement("span");
      why.className = "why";
      why.textContent = f.why;
      const input = document.createElement("textarea");
      input.id = id;
      input.rows = 2;
      input.maxLength = 1000;
      input.dataset.question = f.question;
      input.style.minHeight = "3.5rem";
      div.append(label, why, input);
      list.append(div);
    });
  }

  function showStep(n) {
    state.step = n;
    for (const id of ["step-1", "step-2", "step-3", "step-done"]) $(`#${id}`).hidden = true;
    $(n === "done" ? "#step-done" : `#step-${n}`).hidden = false;
    $$("#stepper li").forEach((li) => {
      const s = Number(li.dataset.step);
      li.classList.toggle("is-current", s === n);
      li.classList.toggle("is-done", n === "done" || s < n);
    });
    $("#stepper").hidden = n === "done";
    window.scrollTo({ top: 0 });
    const h = $(n === "done" ? "#step-done h1" : `#step-${n} h1`);
    h.setAttribute("tabindex", "-1");
    h.focus({ preventScroll: true });
  }

  /* ---------- Flow ---------- */

  const val = (name) => $(`input[name="${name}"]:checked`).value;

  function draft() {
    return {
      category: val("category"),
      affected_object: $("#object").value.trim(),
      environment: val("env"),
      description: $("#desc").value.trim(),
      follow_up_answers: state.answers,
    };
  }

  function collectAnswers() {
    for (const input of $$("#followup-list textarea")) {
      const answer = input.value.trim();
      if (answer) state.answers.push({ question: input.dataset.question, answer });
    }
  }

  async function runCheck() {
    const err = $("#check-error");
    err.hidden = true;
    if (!$("#desc").value.trim()) {
      err.textContent = "Write a description first, even a short one.";
      err.hidden = false;
      $("#desc").focus();
      return;
    }
    collectAnswers();
    const d = draft();
    const btn = $("#check");
    btn.disabled = true;
    btn.textContent = "Checking…";
    setGate("checking", "Checking…", state.mode === "ai" ? "Claude is reading your description." : "Reading your description.");

    let result = null;
    if (state.mode !== "rules") {
      try {
        result = await fetchJSON(`${API}/api/assess`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(d),
        }, 45000);
        setMode("ai");
      } catch (e) {
        if (e.status === 429) {
          err.textContent = e.message;
          err.hidden = false;
        }
        setMode("rules");
      }
    }
    if (!result) result = assessWithRules(d);

    state.result = result;
    state.checks += 1;
    state.checkedText = d.description;
    btn.disabled = false;
    renderSlots(result);

    const open = result.verdict === "enough_context";
    setGate(open ? "open" : "closed", open ? "Ready to log" : "Needs more detail", result.customer_message, result.score);
    renderFollowUps(open ? [] : result.follow_ups);
    btn.hidden = open;
    btn.textContent = "Check again";
    $("#to-3").hidden = !open;
    $("#override").hidden = open || state.checks < 2;
    if (open) $("#to-3").focus();
    else if (result.follow_ups.length) $("#fu-0").focus();
  }

  function resetGate() {
    state.result = null;
    state.checks = 0;
    state.answers = [];
    renderSlots(null);
    renderFollowUps([]);
    setGate("", "Not checked yet", "Write your description, then select Check my description.", 0);
    $("#check").hidden = false;
    $("#check").textContent = "Check my description";
    $("#to-3").hidden = true;
    $("#override").hidden = true;
  }

  function fillReview() {
    const d = draft();
    const r = state.result || assessWithRules(d);
    $("#r-object").textContent = d.affected_object;
    $("#r-category").textContent = CATEGORY_LABEL[d.category];
    $("#r-env").textContent = ENV_LABEL[d.environment];
    $("#r-group").textContent = r.resolver_group;
    $("#r-priority").textContent = r.suggested_priority;
    $("#r-summary").textContent = r.engineer_summary;
    const extras = d.follow_up_answers.map((a) => `\n\n${a.question}\n${a.answer}`).join("");
    $("#r-desc").textContent = d.description + extras;
    $("#r-flag").hidden = !state.flagged;
  }

  /* ---------- Events ---------- */

  $("#to-2").addEventListener("click", () => {
    const ok = $("#object").value.trim().length > 0;
    $("#object-error").hidden = ok;
    $("#object").setAttribute("aria-invalid", String(!ok));
    if (!ok) return $("#object").focus();
    showStep(2);
  });
  $("#back-1").addEventListener("click", () => showStep(1));
  $("#check").addEventListener("click", runCheck);
  $("#to-3").addEventListener("click", () => { state.flagged = false; fillReview(); showStep(3); });
  $("#log-anyway").addEventListener("click", () => { collectAnswers(); state.flagged = true; fillReview(); showStep(3); });
  $("#back-2").addEventListener("click", () => showStep(2));

  $("#desc").addEventListener("input", () => {
    // Editing after a check means the verdict no longer applies.
    if (state.result && $("#desc").value.trim() !== state.checkedText) {
      $("#check").hidden = false;
      $("#to-3").hidden = true;
      setGate("", "Description changed", "Check again to update the result.");
    }
  });

  $$("[data-example]").forEach((b) => b.addEventListener("click", () => {
    resetGate();
    $("#desc").value = EXAMPLES[b.dataset.example];
    $("#desc").focus();
  }));

  $("#submit").addEventListener("click", () => {
    const r = state.result || assessWithRules(draft());
    $("#inc-number").textContent = "INC" + String(Math.floor(1e6 + Math.random() * 9e6)).padStart(7, "0");
    $("#d-group").textContent = r.resolver_group;
    $("#d-priority").textContent = r.suggested_priority;
    showStep("done");
  });

  $("#again").addEventListener("click", () => {
    $("#object").value = "";
    $("#desc").value = "";
    $('input[name="category"][value="virtual_machine"]').checked = true;
    $('input[name="env"][value="production"]').checked = true;
    state.flagged = false;
    resetGate();
    showStep(1);
  });

  renderSlots(null);
  warmUp();
})();
