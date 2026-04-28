# External Approval Bridge

This is a tiny public relay for one-click external approvals.

Why it exists:
- Freshworks `onExternalEvent` URLs are webhook-style endpoints.
- They are expected to be called from a backend service, not directly from browser JavaScript.
- Email clients also strip interactive HTML forms aggressively.

What this bridge does:
1. Opens a public approval landing page for the external approver.
2. Confirms the action.
3. Posts the approval token server-to-server back to the Freshworks app `onExternalEvent` URL.

## Run locally

```bash
node external-approval-bridge/server.mjs
```

The bridge listens on `http://localhost:8787` by default.

Health check:

```bash
curl http://localhost:8787/health
```

## Deploy

Host this folder anywhere you can run a small Node server:
- Render
- Railway
- Fly.io
- a small VM/container

If you deploy the bridge directly on a free Render web service, Render may show its own cold-start screen before this app can respond. That splash screen is outside this app, so it cannot be replaced from inside the same sleeping service.

To show your own "Connecting to Freshdesk..." experience instead, host the included [approval-launch.html](/Users/akashram/Desktop/fw Projects/approvalAutomations/external-approval-bridge/approval-launch.html) page on an always-on static host and point email links there first. The launch page polls the bridge `/health` endpoint and redirects only after the bridge wakes up.

Environment variables:

```text
PUBLIC_APPROVAL_LAUNCH_URL=https://driveautomation.co/approval-launch.html
APPROVAL_BRIDGE_RELAY_URL=https://approval-bridge.onrender.com
PUBLIC_APPROVAL_BRIDGE_URL=https://approval-bridge.onrender.com
```

If you already have a custom domain for the live bridge, that public bridge URL can be:

```text
https://driveautomation.co/approval
```

Once those URLs are live, the Freshworks app will start using them automatically for external approval buttons. Customers do not need to configure any bridge URL during app installation.

## Quick start

Run directly:

```bash
cd external-approval-bridge
node server.mjs
```

Or with the included package metadata:

```bash
cd external-approval-bridge
npm start
```

Or build and run with Docker:

```bash
docker build -t approvals-bridge external-approval-bridge
docker run -p 8787:8787 approvals-bridge
```

## Routing

The approval email buttons open either:

```text
https://driveautomation.co/approval
```

or, when `PUBLIC_APPROVAL_LAUNCH_URL` is set, the always-on wrapper page:

```text
https://driveautomation.co/approval-launch.html
```

The confirmation submit still goes to:

```text
https://driveautomation.co/approval/confirm
```

So if `driveautomation.co` is behind a reverse proxy or existing app server, those two paths need to be routed to this bridge process.
