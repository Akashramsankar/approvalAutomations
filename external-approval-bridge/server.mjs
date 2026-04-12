import http from "node:http";

const PORT = Number(process.env.PORT || 8787);

function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeText(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

function parseDecision(value) {
  return normalizeText(value).toLowerCase() === "rejected" ? "rejected" : "approved";
}

function isValidHookUrl(value) {
  try {
    const parsed = new URL(normalizeText(value));
    return parsed.protocol === "https:" && /\/event\/hook\//.test(parsed.pathname);
  } catch {
    return false;
  }
}

function buildLayout(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f7fb;
      --card: #ffffff;
      --text: #17324d;
      --muted: #62738a;
      --line: #d8e2ec;
      --primary: #17324d;
      --primary-soft: #eef5ff;
      --danger: #9d2b22;
      --danger-soft: #fff4f2;
      --success: #0b7a45;
      --success-soft: #e9f8f0;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      background: linear-gradient(180deg, #f8fbff 0%, var(--bg) 100%);
      font-family: Arial, sans-serif;
      color: var(--text);
    }
    .card {
      width: min(100%, 520px);
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 18px;
      box-shadow: 0 18px 48px rgba(23, 50, 77, 0.08);
      padding: 28px 24px;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 26px;
      line-height: 1.2;
    }
    p {
      margin: 0 0 14px;
      color: var(--muted);
      line-height: 1.6;
      font-size: 14px;
    }
    .meta {
      margin: 18px 0;
      padding: 14px 16px;
      border-radius: 14px;
      background: #f8fbff;
      border: 1px solid #e7eef8;
    }
    .meta strong {
      display: block;
      margin-bottom: 6px;
      font-size: 12px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: #406384;
    }
    .meta span {
      display: block;
      font-size: 14px;
      color: var(--text);
      line-height: 1.5;
      word-break: break-word;
    }
    .actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 22px;
    }
    button, .link {
      appearance: none;
      border: 0;
      border-radius: 999px;
      padding: 12px 18px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      text-decoration: none;
      font-family: Arial, sans-serif;
    }
    .btn-primary {
      background: var(--primary);
      color: #ffffff;
    }
    .btn-danger {
      background: var(--danger-soft);
      color: var(--danger);
      border: 1px solid #e8bdb8;
    }
    .btn-neutral {
      background: #f3f6fb;
      color: var(--text);
      border: 1px solid #d8e2ec;
    }
    .status-success {
      background: var(--success-soft);
      color: var(--success);
      border-color: #bfe7cf;
    }
    .status-error {
      background: #ffebe9;
      color: var(--danger);
      border-color: #f0c1bc;
    }
  </style>
</head>
<body>
  <main class="card">
    ${body}
  </main>
</body>
</html>`;
}

function sendHtml(res, statusCode, title, body) {
  res.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
  res.end(buildLayout(title, body));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function renderApprovalPage(url) {
  const decision = parseDecision(url.searchParams.get("decision"));
  const toneClass = decision === "approved" ? "btn-primary" : "btn-danger";
  const actionLabel = decision === "approved" ? "Approve" : "Reject";
  const ticketSubject = normalizeText(url.searchParams.get("ticket_subject")) || "Approval request";
  const ruleName = normalizeText(url.searchParams.get("rule_name"));
  const approver = normalizeText(url.searchParams.get("approver"));
  const requestId = normalizeText(url.searchParams.get("request_id"));

  if (!isValidHookUrl(url.searchParams.get("hook")) || !normalizeText(url.searchParams.get("token"))) {
    return {
      status: 400,
      title: "Invalid Approval Link",
      body: `
        <h1>Invalid approval link</h1>
        <p>This approval link is missing required details or is no longer valid.</p>
      `,
    };
  }

  return {
    status: 200,
    title: `${actionLabel} Approval`,
    body: `
      <h1>${actionLabel} this approval?</h1>
      <p>Confirm your decision below. This updates the original Freshdesk approval request and the sidebar state for the ticket.</p>
      <div class="meta">
        <strong>Ticket</strong>
        <span>${escapeHtml(ticketSubject)}</span>
      </div>
      ${ruleName ? `
        <div class="meta">
          <strong>Rule</strong>
          <span>${escapeHtml(ruleName)}</span>
        </div>
      ` : ""}
      ${approver ? `
        <div class="meta">
          <strong>Approver</strong>
          <span>${escapeHtml(approver)}</span>
        </div>
      ` : ""}
      ${requestId ? `
        <div class="meta">
          <strong>Approval Request ID</strong>
          <span>${escapeHtml(requestId)}</span>
        </div>
      ` : ""}
      <form method="POST" action="/approval/confirm">
        <input type="hidden" name="hook" value="${escapeHtml(url.searchParams.get("hook"))}">
        <input type="hidden" name="token" value="${escapeHtml(url.searchParams.get("token"))}">
        <input type="hidden" name="decision" value="${escapeHtml(decision)}">
        <input type="hidden" name="ticket_subject" value="${escapeHtml(ticketSubject)}">
        <div class="actions">
          <button class="${toneClass}" type="submit">${actionLabel}</button>
          <a class="link btn-neutral" href="javascript:window.close()">Cancel</a>
        </div>
      </form>
    `,
  };
}

async function relayApproval(hook, token) {
  const response = await fetch(hook, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      approval_token: token,
    }).toString(),
  });

  let payload = null;
  const responseText = await response.text();
  try {
    payload = responseText ? JSON.parse(responseText) : null;
  } catch {
    payload = { message: responseText };
  }

  return {
    ok: response.ok && payload && payload.success !== false,
    status: response.status,
    payload: payload || {},
  };
}

function renderResultPage(decision, result, ticketSubject) {
  const approved = parseDecision(decision) === "approved";
  const success = Boolean(result && result.ok);
  const title = success
    ? approved ? "Approval Recorded" : "Rejection Recorded"
    : "Approval Could Not Be Processed";
  const message = success
    ? approved
      ? "The approval decision has been recorded. The original Freshdesk ticket should update shortly."
      : "The rejection has been recorded. The original Freshdesk ticket should update shortly."
    : normalizeText(result && result.payload && (result.payload.message || result.payload.detail)) ||
      "The approval action could not be completed.";

  return {
    status: success ? 200 : 500,
    title,
    body: `
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      ${ticketSubject ? `
        <div class="meta">
          <strong>Ticket</strong>
          <span>${escapeHtml(ticketSubject)}</span>
        </div>
      ` : ""}
      <div class="actions">
        <a class="link ${success ? "status-success" : "status-error"}" href="javascript:window.close()">
          ${success ? "Close" : "Close"}
        </a>
      </div>
    `,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && requestUrl.pathname === "/health") {
      sendText(res, 200, "ok");
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/approval") {
      const page = renderApprovalPage(requestUrl);
      sendHtml(res, page.status, page.title, page.body);
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/approval/confirm") {
      const rawBody = await readBody(req);
      const form = new URLSearchParams(rawBody);
      const hook = normalizeText(form.get("hook"));
      const token = normalizeText(form.get("token"));
      const decision = parseDecision(form.get("decision"));
      const ticketSubject = normalizeText(form.get("ticket_subject"));

      if (!isValidHookUrl(hook) || !token) {
        sendHtml(res, 400, "Invalid Approval Request", `
          <h1>Invalid approval request</h1>
          <p>This approval action is missing required details or has already expired.</p>
        `);
        return;
      }

      const result = await relayApproval(hook, token);
      const page = renderResultPage(decision, result, ticketSubject);
      sendHtml(res, page.status, page.title, page.body);
      return;
    }

    sendHtml(res, 404, "Not Found", `
      <h1>Approval bridge is running</h1>
      <p>Use <code>/approval</code> to open an approval landing page or <code>/health</code> for a health check.</p>
    `);
  } catch (error) {
    sendHtml(res, 500, "Bridge Error", `
      <h1>Bridge error</h1>
      <p>${escapeHtml(error && error.message ? error.message : "Unexpected error.")}</p>
    `);
  }
});

server.listen(PORT, () => {
  console.log(`Approval bridge listening on http://localhost:${PORT}`);
});
