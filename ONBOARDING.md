# QuickBooks Online MCP Server — Setup Instructions

Connect your QuickBooks account to get AI-powered access to your accounting data through any MCP-compatible client (Claude Desktop, Claude Code, Cursor, etc.)

## Step 1: Authorize

Visit this link and sign into your QuickBooks account:

https://qbo-mcp-production-7d87.up.railway.app/auth/connect

After authorizing, you'll receive an API key (starts with `qbo_`). Copy it.

## Step 2: Configure your MCP client

Add this to your MCP configuration:

```json
{
  "mcpServers": {
    "quickbooks": {
      "url": "https://qbo-mcp-production-7d87.up.railway.app/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY_HERE"
      }
    }
  }
}
```

Replace `YOUR_API_KEY_HERE` with the key you got in Step 1.

**Where to put this config:**
- **Claude Desktop:** `claude_desktop_config.json`
- **Claude Code CLI:** `.mcp.json` in your project root
- **Cursor / Windsurf:** Your MCP server settings

## Step 3: Start using it

Once connected, you have 58 tools for QuickBooks including invoices, bills, customers, vendors, accounts, journal entries, and more. Just ask your AI assistant to interact with your books.

## Available Tools

| Category | Tools | Operations |
|----------|-------|------------|
| Accounts | 5 | Create, get, update, delete, list |
| Bills | 5 | Create, get, update, delete, list |
| Bill Payments | 5 | Create, get, update, delete, list |
| Customers | 5 | Create, get, update, delete, list |
| Deposits | 2 | Get, list |
| Employees | 5 | Create, get, update, delete, list |
| Estimates | 5 | Create, get, update, delete, list |
| Invoices | 5 | Create, get, update, delete, list |
| Items | 5 | Create, get, update, delete, list |
| Journal Entries | 5 | Create, get, update, delete, list |
| Purchases | 5 | Create, get, update, delete, list |
| Vendors | 5 | Create, get, update, delete, list |
| Company Info | 1 | Get |

## Notes

- Tokens auto-refresh for ~100 days. After that, visit the connect link again.
- Your credentials are never stored on the server as raw QBO tokens — only your encrypted API key.
- To check your connection status: `https://qbo-mcp-production-7d87.up.railway.app/auth/status/YOUR_API_KEY`
