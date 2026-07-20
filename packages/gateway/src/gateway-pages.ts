const HOME_URL = "https://turbotunnel.dev/";
const DOCS_URL = "https://turbotunnel.dev/docs";
const TROUBLESHOOTING_URL = `${DOCS_URL}/troubleshooting`;
const PUBLIC_REQUEST_FAILURES_URL = `${TROUBLESHOOTING_URL}#a-public-request-fails`;

const LOGO_LIGHT = `<svg class="logo logo-light" width="20" height="20" viewBox="0 0 512 512" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<path d="M456.918 423H55.082L256 75L456.918 423Z" stroke="#FF1E56" stroke-width="28" stroke-linejoin="miter" stroke-miterlimit="20"/>
<path d="M361.281 367.784H150.719L256 185.43L361.281 367.784Z" fill="white" stroke="#0196FF" stroke-width="28" stroke-linejoin="miter" stroke-miterlimit="20"/>
<path d="M274.339 317.588H237.66L255.999 285.823L274.339 317.588Z" fill="black" stroke="black" stroke-width="24" stroke-linejoin="miter" stroke-miterlimit="20"/>
</svg>`;

const LOGO_DARK = `<svg class="logo logo-dark" width="20" height="20" viewBox="0 0 512 512" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<path d="M456.918 423H55.082L256 75L456.918 423Z" stroke="#FF1E56" stroke-width="28" stroke-linejoin="miter" stroke-miterlimit="20"/>
<path d="M361.281 367.784H150.719L256 185.43L361.281 367.784Z" fill="black" stroke="#0196FF" stroke-width="28" stroke-linejoin="miter" stroke-miterlimit="20"/>
<path d="M274.339 317.588H237.66L255.999 285.823L274.339 317.588Z" fill="white" stroke="white" stroke-width="24" stroke-linejoin="miter" stroke-miterlimit="20"/>
</svg>`;

const ARROW = `<svg class="arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>`;

const SHARED_STYLES = `
    :root {
      --background: #ffffff;
      --surface: #fafafa;
      --text: #171717;
      --secondary: #4d4d4d;
      --border: #0000001a;
      --mark: #00000070;
      --hover-fill: #0000000d;
      --input-bg: #ffffff;
      --warning: #aa4d00;
      --error: #ea001d;
      --error-bg: #ffeeef;
      --error-border: #ffd7d6;
      --button-bg: #171717;
      --button-text: #ffffff;
      --button-hover: #000000e8;
      --focus: #006bff;
      --focus-gap: #ffffff;
    }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; }
    body {
      margin: 0;
      background: var(--background);
      color: var(--text);
      font-family: "Geist Sans", "Helvetica Neue", Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .page {
      min-height: 100svh;
      display: grid;
      grid-template-rows: 64px 1fr;
      grid-template-columns: minmax(0, 1fr);
    }
    .frame { width: min(100% - 48px, 1080px); margin: 0 auto; }
    main.frame { display: grid; }
    header { border-bottom: 1px solid var(--border); }
    header .frame {
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      color: var(--text);
      font-size: 14px;
      font-weight: 600;
      letter-spacing: -0.28px;
      text-decoration: none;
    }
    .brand:hover { opacity: 0.8; }
    .brand:focus-visible {
      outline: none;
      border-radius: 6px;
      box-shadow: 0 0 0 2px var(--focus-gap), 0 0 0 4px var(--focus);
    }
    .logo { display: block; flex: none; }
    .logo-dark { display: none; }
    .docs-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 32px;
      padding: 0 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--background);
      color: var(--text);
      font-size: 14px;
      font-weight: 500;
      line-height: 20px;
      text-decoration: none;
    }
    .docs-link:hover { background: var(--hover-fill); }
    .docs-link:active { transform: scale(0.97); }
    .docs-link:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px var(--focus-gap), 0 0 0 4px var(--focus);
    }
    .docs-link .arrow { width: 14px; height: 14px; }
    .shell {
      position: relative;
      border-left: 1px solid var(--border);
      border-right: 1px solid var(--border);
      background:
        linear-gradient(var(--mark), var(--mark)) top 16px left 16px / 36px 1px no-repeat,
        linear-gradient(var(--mark), var(--mark)) top 16px left 16px / 1px 36px no-repeat,
        linear-gradient(var(--mark), var(--mark)) top 16px right 16px / 36px 1px no-repeat,
        linear-gradient(var(--mark), var(--mark)) top 16px right 16px / 1px 36px no-repeat,
        linear-gradient(var(--mark), var(--mark)) bottom 16px left 16px / 36px 1px no-repeat,
        linear-gradient(var(--mark), var(--mark)) bottom 16px left 16px / 1px 36px no-repeat,
        linear-gradient(var(--mark), var(--mark)) bottom 16px right 16px / 36px 1px no-repeat,
        linear-gradient(var(--mark), var(--mark)) bottom 16px right 16px / 1px 36px no-repeat;
    }
    .hero {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 96px 24px 64px;
      text-align: center;
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin: 0 0 24px;
      color: var(--secondary);
      font-family: "Geist Mono", "SFMono-Regular", Consolas, monospace;
      font-size: 12px;
      line-height: 16px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
    }
    .eyebrow-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--warning); }
    h1 {
      margin: 0;
      max-width: 20ch;
      font-size: 40px;
      line-height: 48px;
      letter-spacing: -2.4px;
      font-weight: 600;
      text-wrap: balance;
    }
    .lead {
      margin: 16px 0 0;
      max-width: 52ch;
      color: var(--secondary);
      font-size: 16px;
      line-height: 24px;
      text-wrap: balance;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: center;
      gap: 12px;
      margin-top: 32px;
    }
    form .actions { justify-content: flex-start; }
    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      height: 40px;
      padding: 0 16px;
      border-radius: 6px;
      font: inherit;
      font-size: 14px;
      font-weight: 500;
      line-height: 20px;
      text-decoration: none;
      cursor: pointer;
    }
    .button:active { transform: scale(0.97); }
    .button:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px var(--focus-gap), 0 0 0 4px var(--focus);
    }
    .button-primary {
      border: none;
      background: var(--button-bg);
      color: var(--button-text);
    }
    .button-primary:hover { background: var(--button-hover); }
    .button-secondary {
      border: 1px solid var(--border);
      background: var(--background);
      color: var(--text);
    }
    .button-secondary:hover { background: var(--hover-fill); }
    .steps {
      padding: 48px 24px 64px;
      border-top: 1px solid var(--border);
    }
    .steps-inner { max-width: 880px; margin: 0 auto; }
    .steps h2 {
      margin: 0 0 24px;
      font-size: 14px;
      line-height: 20px;
      letter-spacing: -0.28px;
      font-weight: 600;
    }
    ol {
      display: grid;
      gap: 24px;
      margin: 0;
      padding: 0;
      list-style: none;
      counter-reset: step;
    }
    li {
      display: grid;
      grid-template-columns: 32px minmax(0, 1fr);
      gap: 16px;
      counter-increment: step;
    }
    li::before {
      content: counter(step, decimal-leading-zero);
      color: var(--secondary);
      font-family: "Geist Mono", "SFMono-Regular", Consolas, monospace;
      font-size: 12px;
      line-height: 20px;
    }
    li strong {
      display: block;
      font-size: 14px;
      line-height: 20px;
      font-weight: 600;
      letter-spacing: -0.28px;
    }
    li span {
      display: block;
      margin-top: 4px;
      color: var(--secondary);
      font-size: 14px;
      line-height: 20px;
    }
    code {
      padding: 1px 5px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--surface);
      font-family: "Geist Mono", "SFMono-Regular", Consolas, monospace;
      font-size: 12px;
      line-height: 16px;
    }
    form { margin: 0; width: 100%; }
    .form { width: min(100%, 400px); display: grid; gap: 16px; text-align: left; }
    .error {
      margin: 0;
      padding: 10px 12px;
      border: 1px solid var(--error-border);
      border-radius: 6px;
      background: var(--error-bg);
      color: var(--error);
      font-size: 13px;
      line-height: 18px;
    }
    .field { display: grid; gap: 8px; }
    .field label {
      font-size: 13px;
      line-height: 16px;
      font-weight: 500;
      color: var(--text);
    }
    .field input {
      height: 40px;
      width: 100%;
      margin: 0;
      padding: 0 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--input-bg);
      color: var(--text);
      font: inherit;
      font-size: 14px;
      line-height: 20px;
    }
    .field input:focus {
      outline: none;
      border-color: var(--focus);
      box-shadow: 0 0 0 2px var(--focus-gap), 0 0 0 4px var(--focus);
    }
    .hint {
      margin: 0;
      color: var(--secondary);
      font-size: 13px;
      line-height: 18px;
    }
    @media (max-width: 600px) {
      .page { grid-template-rows: 56px 1fr; }
      .frame { width: min(100% - 32px, 1080px); }
      .shell { background: none; border: none; }
      .hero { padding: 64px 0 48px; align-items: flex-start; text-align: left; }
      h1 { font-size: 32px; line-height: 40px; letter-spacing: -1.28px; }
      .steps { padding: 32px 0 48px; }
      form .actions { flex-direction: column-reverse; align-items: stretch; }
      form .button { width: 100%; }
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --background: #000000;
        --surface: #0a0a0a;
        --text: #ededed;
        --secondary: #a0a0a0;
        --border: #ffffff24;
        --mark: #ffffff70;
        --hover-fill: #ffffff14;
        --input-bg: #000000;
        --warning: #ffae00;
        --error: #ff565f;
        --error-bg: #330a11;
        --error-border: #6f101b;
        --button-bg: #ededed;
        --button-text: #000000;
        --button-hover: #ffffffeb;
        --focus: #47a8ff;
        --focus-gap: #000000;
      }
      .logo-light { display: none; }
      .logo-dark { display: block; }
    }
`;

interface PageOptions {
  title: string;
  eyebrow: string;
  state?: string;
  heading: string;
  lead: string;
  actions: string;
  extra?: string;
}

function renderPage(options: PageOptions): string {
  const dot =
    options.state === undefined ? "" : `<span class="eyebrow-dot" aria-hidden="true"></span>`;
  const state = options.state === undefined ? "" : ` · ${options.state}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${options.title}</title>
  <style>${SHARED_STYLES}
  </style>
</head>
<body>
  <div class="page">
    <header>
      <div class="frame">
        <a class="brand" href="${HOME_URL}">
          ${LOGO_LIGHT}
          ${LOGO_DARK}
          <span>Turbotunnel</span>
        </a>
        <a class="docs-link" href="${DOCS_URL}">Docs${ARROW}</a>
      </div>
    </header>
    <main class="frame">
      <div class="shell">
        <section class="hero">
          <p class="eyebrow">${dot}Error ${options.eyebrow}${state}</p>
          <h1>${options.heading}</h1>
          <p class="lead">${options.lead}</p>
          <div class="actions">${options.actions}</div>
        </section>
        ${options.extra ?? ""}
      </div>
    </main>
  </div>
</body>
</html>`;
}

const RETRY_BUTTON = `<a class="button button-primary" href="">Retry</a>`;

function docsButton(href: string): string {
  return `<a class="button button-secondary" href="${href}">Troubleshoot in Docs${ARROW}</a>`;
}

function stepsSection(heading: string, items: string): string {
  return `<section class="steps">
          <div class="steps-inner">
            <h2>${heading}</h2>
            <ol>${items}</ol>
          </div>
        </section>`;
}

function step(title: string, description: string): string {
  return `<li><div><strong>${title}</strong><span>${description}</span></div></li>`;
}

export const localAppUnavailablePage = renderPage({
  title: "Local app unavailable",
  eyebrow: "502",
  state: "Tunnel online",
  heading: "Local app unavailable",
  lead: "The tunnel is online, but your local app is not responding. This URL starts forwarding once the app responds.",
  actions: `${RETRY_BUTTON}${docsButton(PUBLIC_REQUEST_FAILURES_URL)}`,
  extra: stepsSection(
    "If you run this tunnel",
    `${step("Start the app", "Make sure the development server is running.")}
            ${step("Match the port", "Use the same port as <code>tt http</code> or <code>turbotunnel.json</code>.")}
            ${step("Match the host", "If the app is not on localhost, restart with <code>tt http &lt;port&gt; --host &lt;host&gt;</code>.")}`,
  ),
});

export function passwordLoginPage(options?: { error?: string }): string {
  const error =
    options?.error === undefined ? "" : `<p class="error" role="alert">${options.error}</p>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Password required</title>
  <style>${SHARED_STYLES}
  </style>
</head>
<body>
  <div class="page">
    <header>
      <div class="frame">
        <a class="brand" href="${HOME_URL}">
          ${LOGO_LIGHT}
          ${LOGO_DARK}
          <span>Turbotunnel</span>
        </a>
        <a class="docs-link" href="${DOCS_URL}">Docs${ARROW}</a>
      </div>
    </header>
    <main class="frame">
      <div class="shell">
        <section class="hero">
          <p class="eyebrow">Protected tunnel</p>
          <h1>Password required</h1>
          <p class="lead">Enter the password for this tunnel to continue. Access lasts for this browser session.</p>
          <form class="form" method="post" action="/_turbotunnel/login">
            <div class="field">
              <label for="password">Password</label>
              <input id="password" name="password" type="password" required autofocus autocomplete="current-password">
            </div>
            <div class="actions">
              <button class="button button-primary" type="submit">Continue</button>
            </div>
            ${error}
          </form>
        </section>
      </div>
    </main>
  </div>
</body>
</html>`;
}

export const tunnelNotFoundPage = renderPage({
  title: "Tunnel not found",
  eyebrow: "404",
  heading: "Tunnel not found",
  lead: "No active tunnel is registered for this host. The local app was not contacted.",
  actions: `${RETRY_BUTTON}${docsButton(TROUBLESHOOTING_URL)}`,
  extra: stepsSection(
    "If you run this tunnel",
    `${step("Start the tunnel", "Run <code>tt http</code> or <code>tt dev</code> so the gateway can register this host.")}
            ${step("Match the public URL", "Open the host printed by the CLI, not an old or mistyped domain.")}
            ${step("Check local status", "Run <code>tt status</code> to confirm the tunnel is still connected.")}`,
  ),
});

export const routeNotReadyPage = renderPage({
  title: "Tunnel not ready",
  eyebrow: "503",
  state: "Registry loading",
  heading: "Tunnel not ready",
  lead: "The gateway is still loading tunnel routes. The local app was not contacted.",
  actions: `${RETRY_BUTTON}${docsButton(TROUBLESHOOTING_URL)}`,
  extra: stepsSection(
    "What to try",
    `${step("Wait and retry", "Route catch-up usually finishes within a few seconds after a cold start.")}
            ${step("Keep the CLI connected", "Leave <code>tt http</code> or <code>tt dev</code> running while you refresh.")}
            ${step("Check gateway status", "Run <code>tt status</code> to confirm the gateway and tunnel are healthy.")}`,
  ),
});

export const routeConflictPage = renderPage({
  title: "Tunnel route conflict",
  eyebrow: "503",
  heading: "Tunnel route conflict",
  lead: "More than one active registration matches this host. The local app was not contacted.",
  actions: `${RETRY_BUTTON}${docsButton(TROUBLESHOOTING_URL)}`,
  extra: stepsSection(
    "If you run this tunnel",
    `${step("Stop extra clients", "Close other <code>tt http</code> or <code>tt dev</code> sessions for the same host or slug.")}
            ${step("Keep one session", "Run a single tunnel client, then wait for the old session to disconnect.")}
            ${step("Retry", "Refresh after only one registration remains active.")}`,
  ),
});
