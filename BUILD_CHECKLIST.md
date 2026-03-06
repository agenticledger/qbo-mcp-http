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
- [ ] npm install — 0 vulnerabilities
- [ ] npx tsc — 0 errors
- [ ] Smoke test: server starts, shows correct tool count
- [ ] Smoke test: shows "Bearer passthrough" auth mode

## Phase 4: GitHub
- [ ] git init + commit
- [ ] Created repo under agenticledger org
- [ ] Pushed to main branch

## Phase 5: Railway Deploy
- [ ] Created service in FinanceMCPs project
- [ ] Set PORT=3100 env var
- [ ] Connected GitHub repo
- [ ] Deployment status: SUCCESS
- [ ] Created public domain
- [ ] Domain URL: TBD

## Phase 6: End-to-End Tests
- [ ] Health check returns 200 with correct tool count
- [ ] POST /mcp without auth returns 401
- [ ] MCP initialize returns session ID + serverInfo
- [ ] tools/list returns all 58 tools
- [ ] (Optional) Live API call with real credentials works

## Phase 7: Documentation
- [ ] Created DEPLOYMENT.md (gitignored)
- [ ] Includes MCP URL, auth instructions, client config

## Final Validation
- [ ] All Phase 1-7 items checked
- [ ] Server is live and responding at public URL
- [ ] No service credentials stored on the server
- [ ] BUILD_CHECKLIST.md fully complete
