# MCP Expose Checklist — QBO

## Server Info
- **Source MCP:** C:\Users\oreph\clawd\OrphilLLC\Clients\FinanceStackMCPs\QBOMCP\mcp-server
- **Service Name:** QBO
- **API Client Class:** QBOClient
- **Constructor Args:** accessToken: string, realmId: string, environment: 'sandbox' | 'production'
- **Tool Count:** 58
- **Target Directory:** C:\Users\oreph\clawd\OrphilLLC\Clients\FinanceStackMCPs\General\Exposed\QBO
- **Started:** 2026-03-06

## Phase 1: Read Source
- [x] Read api-client.ts — identified class name and constructor
- [x] Read tools.ts — confirmed tool count (58)
- [x] Read index.ts — confirmed stdio transport
- [x] Read package.json — noted dependencies
- [x] Read tsconfig.json — noted config

## Phase 2: Scaffold
- [x] Created target directory
- [x] Created package.json (with express added)
- [x] Created tsconfig.json
- [x] Created .gitignore (includes DEPLOYMENT.md)
- [x] Created .env.example (PORT only, no API keys)
- [x] Copied api-client.ts (unchanged)
- [x] Copied tools.ts (unchanged)
- [x] Created index.ts with Streamable HTTP transport
- [x] Auth model: Bearer + X-Realm-Id passthrough (no hardcoded keys)
- [x] Replaced all placeholders with actual values

## Phase 3: Build & Local Test
- [x] npm install — 0 vulnerabilities
- [x] npx tsc — 0 errors
- [x] Smoke test: server starts, shows correct tool count
- [x] Smoke test: shows "Bearer passthrough" auth mode

## Phase 4: GitHub
- [x] git init + commit
- [x] Created repo under agenticledger org
- [x] Pushed to main branch

## Phase 5: Railway Deploy
- [x] Created service in FinanceMCPs project
- [x] Set PORT=3100 env var
- [x] Connected GitHub repo
- [x] Deployment status: SUCCESS
- [x] Created public domain
- [x] Domain URL: qbo-mcp-production-7d87.up.railway.app

## Phase 6: End-to-End Tests
- [x] Health check returns 200 with correct tool count
- [x] POST /mcp without auth returns 401
- [x] MCP initialize returns session ID + serverInfo
- [x] tools/list returns all 58 tools
- [ ] (Optional) Live API call with real credentials works

## Phase 7: Documentation
- [x] Created DEPLOYMENT.md (gitignored)
- [x] Includes MCP URL, auth instructions, client config

## Final Validation
- [x] All Phase 1-7 items checked
- [x] Server is live and responding at public URL
- [x] No service credentials stored on the server
- [x] BUILD_CHECKLIST.md fully complete

## Result: PASSED
- **Completed:** 2026-03-06
