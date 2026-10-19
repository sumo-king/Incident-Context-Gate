# Incident Context Gate — customer demo

A scaled-down demo of the customer side of the incident context gate: a staff member reports an
infrastructure incident, and before it can be logged, an AI check (Claude, via Pydantic AI) decides
whether the description has enough context for an engineer to start work without calling them back.
If not, it asks up to three plain-language follow-up questions.

```
Browser ──► Netlify (static portal)  ──/api/*──►  Render (FastAPI + Pydantic AI)  ──►  Claude
                 frontend/                proxy          backend/
```

**Why two hosts?** Netlify Functions only run JavaScript, TypeScript and Go at request time, so the
Python agent can't live on Netlify. Netlify serves the portal and proxies `/api/*` to the Python
service, so the browser only ever talks to one origin (no CORS setup needed).

If the AI service is unreachable, the portal falls back to built-in keyword rules and says so in the
top bar, so a demo never dead-ends.

## The customer workflow

1. **What's affected** — pick a system type (VM, Windows, Linux, storage), enter its name, pick the environment.
2. **Describe it** — free-text description, then *Check my description*. The context panel shows seven slots:

   | Slot | Required to log |
   |---|---|
   | Affected system, What's happening, When it started, Who's affected | Yes, all four |
   | Error messages, Recent changes, What you've tried | At least two |

   Missing details come back as follow-up questions. After two checks without passing, the customer
   can still log it, but the ticket is flagged as needing more information.
3. **Review and log** — shows the AI-written summary for the engineer, suggested priority and resolver group.
4. **Confirmation** — mock INC number and what happens next. Nothing is sent to ServiceNow.

The *Try an example* links fill in a vague, a half-complete and a detailed report for demoing.

## Deploy

### 1. Put the project on GitHub
Push this folder as a repo (private is fine).

### 2. Deploy the backend to Render
1. [render.com](https://render.com) → **New → Blueprint** → pick the repo. It reads `render.yaml`.
2. Paste your `ANTHROPIC_API_KEY` when asked.
3. When it's live, open `https://<your-service>.onrender.com/api/health`. You should see `{"ok": true, ...}`.

### 3. Point Netlify at it and deploy the portal
1. In `netlify.toml`, replace `incident-context-gate-api.onrender.com` with your Render host. Commit.
2. [netlify.com](https://app.netlify.com) → **Add new site → Import an existing project** → pick the repo.
   Build settings come from `netlify.toml` (publish directory `frontend`, no build command).
3. Open the site. The top bar should read *Context check: Claude via Pydantic AI*.

**Before a live demo:** Render's free tier sleeps after ~15 minutes idle and takes up to a minute to
wake. Open the site a minute early; the portal pings the service on load and switches from
*built-in rules* to *Claude* once it's awake. A paid instance avoids this.

## Run locally

```bash
cd backend
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...                 # Windows: set ANTHROPIC_API_KEY=...
export ALLOWED_ORIGINS=http://localhost:5500
uvicorn main:app --reload --port 8000
```

In another terminal:

```bash
cd frontend
python -m http.server 5500
```

Set `window.GATE_API_BASE = "http://localhost:8000"` in `frontend/config.js`, then open
http://localhost:5500. (Leave it as `""` for Netlify.)

### Tests
```bash
cd backend && pip install pytest && python -m pytest -q
```
Tests use Pydantic AI's `FunctionModel` in place of Claude, so they need no API key. They cover the
verdict validator, the API contract and the rate limit.

## How the AI part works

`backend/agent.py` defines a Pydantic AI `Agent` with:

- **Structured output** — `ContextAssessment` in `models.py`: verdict, score, a status for each of
  the seven slots with a short evidence note, up to three follow-ups, an engineer summary, priority
  and resolver group. Claude has to return this shape; Pydantic validates it.
- **An output validator** that enforces the gate rule in code. If Claude says "enough context" while
  a required slot is missing (or the reverse), the validator raises `ModelRetry` and Claude corrects
  itself. The model judges the language; the code owns the rule.
- **Prompt-injection guarding** — the description is fenced in tags and treated as data.

Switch models with the `MODEL` env var (any Pydantic AI model string), e.g.
`anthropic:claude-haiku-5-5` for cheaper, faster checks.

## Cost and safety for a public demo URL

- Each check is one Claude call (two if the validator asks for a retry).
- The API rate-limits to 20 checks per IP per 10 minutes (`RATE_LIMIT_PER_10_MIN`).
- Set a monthly spend limit on your Anthropic account as a backstop.
- Don't type real server names or customer data into a public demo.

## From demo to the real build

The real system runs on EC2 with FastAPI, Jinja2 and Apache, so `agent.py` and `models.py` drop
into it as they are. What this demo leaves out: the ServiceNow integration, scanning the named
server, suggested customer fixes, escalation to engineers, and the ops-side closure check.

## Project layout

```
netlify.toml          Netlify build + /api proxy
render.yaml           Render blueprint for the API
frontend/             Static portal (index.html, styles.css, app.js, config.js)
backend/
  main.py             FastAPI app: /api/health, /api/assess, rate limit
  agent.py            Pydantic AI agent, instructions, output validator
  models.py           Request and response models
  tests/test_gate.py  Tests with a stand-in model
```



brew install ollama
OLLAMA_CONTEXT_LENGTH=8192 ollama serve        # separate tab
ollama pull qwen3.5:9b

pip install -r requirements.txt
export OLLAMA_BASE_URL=http://localhost:11434/v1
export ALLOWED_ORIGINS=http://localhost:5500
uvicorn main:app --reload --port 8000