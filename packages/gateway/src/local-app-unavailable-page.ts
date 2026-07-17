export const localAppUnavailablePage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Local App Unavailable</title>
  <style>
    :root {
      --background: #ffffff;
      --surface: #fafafa;
      --text: #171717;
      --secondary: #4d4d4d;
      --border: #0000001a;
      --muted-border: #00000014;
      --warning-bg: #fff6de;
      --warning: #aa4d00;
      --button-text: #ffffff;
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
      grid-template-rows: 64px 1fr 64px;
    }
    .frame { width: min(100% - 48px, 1080px); margin: 0 auto; }
    header { border-bottom: 1px solid var(--muted-border); }
    header .frame, footer .frame {
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .brand { display: flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 600; }
    .mark { width: 0; height: 0; border-left: 8px solid transparent; border-right: 8px solid transparent; border-bottom: 14px solid var(--text); }
    .status-code, footer { color: var(--secondary); font-size: 13px; }
    main { display: grid; place-items: center; padding: 64px 0; }
    .card {
      width: min(100%, 640px);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 2px 2px #0000000a;
    }
    .summary { padding: 32px; }
    .state {
      width: fit-content;
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 24px;
      padding: 6px 10px;
      border-radius: 9999px;
      background: var(--warning-bg);
      color: var(--warning);
      font-size: 12px;
      font-weight: 500;
    }
    .state-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    h1 { margin: 0; font-size: 32px; line-height: 40px; letter-spacing: -1.28px; font-weight: 600; }
    .lead { max-width: 520px; margin: 12px 0 0; color: var(--secondary); font-size: 16px; line-height: 24px; }
    .guide { padding: 24px 32px; border-top: 1px solid var(--border); background: var(--surface); }
    h2 { margin: 0 0 16px; font-size: 14px; line-height: 20px; letter-spacing: -0.28px; font-weight: 600; }
    ol { display: grid; gap: 16px; margin: 0; padding-left: 20px; }
    li { padding-left: 4px; font-size: 14px; line-height: 20px; }
    li span { display: block; margin-top: 2px; color: var(--secondary); }
    code {
      padding: 2px 4px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--background);
      font-family: "Geist Mono", "SFMono-Regular", Consolas, monospace;
      font-size: 12px;
    }
    .actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 16px 32px;
      border-top: 1px solid var(--border);
    }
    .actions span { color: var(--secondary); font-size: 13px; line-height: 18px; }
    .button {
      flex: none;
      height: 40px;
      display: inline-flex;
      align-items: center;
      padding: 0 12px;
      border-radius: 6px;
      background: var(--text);
      color: var(--button-text);
      font-size: 14px;
      font-weight: 500;
      text-decoration: none;
    }
    .button:hover { opacity: 0.86; }
    .button:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--background), 0 0 0 4px #006bff; }
    @media (max-width: 600px) {
      .page { grid-template-rows: 56px 1fr 56px; }
      .frame { width: min(100% - 32px, 1080px); }
      main { align-items: start; padding: 32px 0; }
      .summary { padding: 24px; }
      h1 { font-size: 24px; line-height: 32px; letter-spacing: -0.96px; }
      .guide { padding: 24px; }
      .actions { align-items: stretch; flex-direction: column-reverse; padding: 20px 24px 24px; }
      .button { justify-content: center; }
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --background: #0a0a0a;
        --surface: #111111;
        --text: #ededed;
        --secondary: #a1a1a1;
        --border: #ffffff24;
        --muted-border: #ffffff1a;
        --warning-bg: #2d2006;
        --warning: #ffc543;
        --button-text: #171717;
      }
    }
  </style>
</head>
<body>
  <div class="page">
    <header>
      <div class="frame">
        <div class="brand"><span class="mark" aria-hidden="true"></span><span>Turbotunnel</span></div>
        <span class="status-code">Error 502</span>
      </div>
    </header>
    <main class="frame">
      <article class="card">
        <section class="summary">
          <div class="state"><span class="state-dot" aria-hidden="true"></span>Tunnel Online</div>
          <h1>Local App Unavailable</h1>
          <p class="lead">The public tunnel is connected, but the local app behind it is not responding.</p>
        </section>
        <section class="guide">
          <h2>Running This Tunnel?</h2>
          <ol>
            <li><strong>Start the local app.</strong><span>Confirm its development server is still running.</span></li>
            <li><strong>Check the port.</strong><span>It must match the port passed to <code>tt http</code> or set in <code>turbotunnel.json</code>.</span></li>
            <li><strong>Check the interface.</strong><span>If the app is not listening on localhost, restart with <code>tt http &lt;port&gt; --host &lt;host&gt;</code>.</span></li>
          </ol>
        </section>
        <div class="actions">
          <span>This URL will begin forwarding when the app responds.</span>
          <a class="button" href="">Retry Connection</a>
        </div>
      </article>
    </main>
    <footer><div class="frame"><span>Turbotunnel</span><span>Gateway Response</span></div></footer>
  </div>
</body>
</html>`;
