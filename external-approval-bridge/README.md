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

This app is now wired to use the Drive Automation domain by default:

```text
https://driveautomation.co
```

So the bridge should be deployed behind that domain, with the approval page reachable at:

```text
https://driveautomation.co/approval
```

Once that route is live, the Freshworks app will start using it automatically for external approval buttons. Customers do not need to configure any bridge URL during app installation.

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

The approval email buttons open:

```text
https://driveautomation.co/approval
```

And the confirmation submit goes to:

```text
https://driveautomation.co/approval/confirm
```

So if `driveautomation.co` is behind a reverse proxy or existing app server, those two paths need to be routed to this bridge process.
