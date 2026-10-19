// Where the portal sends context checks.
// "" = same origin (/api/...), which Netlify proxies to the Pydantic AI service (see netlify.toml).
// For local testing against `uvicorn main:app --port 8000`, set "http://localhost:8000"
// and start the backend with ALLOWED_ORIGINS=http://localhost:5500 (or whatever port you serve on).
window.GATE_API_BASE = "";
