/**
 * QuickBooks Online API Client
 *
 * Base URL: https://quickbooks.api.intuit.com/v3/company/{realmId}
 * Auth: OAuth 2.0 Bearer token
 * Pagination: MAXRESULTS + STARTPOSITION (QBO SQL dialect)
 */

const PROD_URL = 'https://quickbooks.api.intuit.com';
const SANDBOX_URL = 'https://sandbox-quickbooks.api.intuit.com';

export class QBOClient {
  private accessToken: string;
  private realmId: string;
  private baseUrl: string;

  constructor(accessToken: string, realmId: string, environment: 'sandbox' | 'production' = 'production') {
    if (!accessToken) throw new Error('QBO access token is required');
    if (!realmId) throw new Error('QBO realm ID (company ID) is required');
    this.accessToken = accessToken;
    this.realmId = realmId;
    this.baseUrl = environment === 'sandbox' ? SANDBOX_URL : PROD_URL;
  }

  private get companyUrl(): string {
    return `${this.baseUrl}/v3/company/${this.realmId}`;
  }

  private async request<T>(
    endpoint: string,
    options: { method?: string; body?: any; params?: Record<string, string | number | undefined> } = {}
  ): Promise<T> {
    const { method = 'GET', body, params } = options;
    const url = new URL(`${this.companyUrl}${endpoint}`);
    url.searchParams.append('minorversion', '75');

    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) url.searchParams.append(key, String(value));
      });
    }

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.accessToken}`,
      'Accept': 'application/json',
    };
    if (body) headers['Content-Type'] = 'application/json';

    const response = await fetch(url.toString(), {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`QBO API ${response.status}: ${text}`);
    }

    return response.json();
  }

  private async query(sql: string): Promise<any> {
    const url = `${this.companyUrl}/query?query=${encodeURIComponent(sql)}&minorversion=75`;
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Accept': 'application/json',
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`QBO Query ${response.status}: ${text}`);
    }
    return response.json();
  }

  private buildQuery(entity: string, filters: Record<string, any>, limit = 100, offset = 0): string {
    const conditions: string[] = [];
    const exclude = ['limit', 'offset'];

    for (const [key, value] of Object.entries(filters)) {
      if (exclude.includes(key) || value === undefined || value === null) continue;
      if (typeof value === 'string') {
        const safe = value.replace(/'/g, "''");
        conditions.push(`${key} LIKE '%${safe}%'`);
      } else if (typeof value === 'boolean') {
        conditions.push(`${key} = ${value}`);
      } else if (typeof value === 'number') {
        conditions.push(`${key} = ${value}`);
      }
    }

    let sql = `SELECT * FROM ${entity}`;
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`;
    if (offset > 0) sql += ` STARTPOSITION ${offset + 1}`;
    sql += ` MAXRESULTS ${Math.min(limit, 1000)}`;
    return sql;
  }

  // ===== ACCOUNT =====
  async createAccount(data: any) { return this.request<any>('/account', { method: 'POST', body: data }); }
  async getAccount(id: string) { return this.request<any>(`/account/${encodeURIComponent(id)}`); }
  async updateAccount(data: any) { return this.request<any>('/account', { method: 'POST', body: { ...data, sparse: data.sparse !== false } }); }
  async deleteAccount(id: string, syncToken: string) { return this.request<any>('/account', { method: 'POST', body: { Id: id, SyncToken: syncToken, Active: false, sparse: true } }); }
  async queryAccounts(filters: any = {}) { return this.query(this.buildQuery('Account', filters, filters.limit, filters.offset)); }

  // ===== BILL =====
  async createBill(data: any) { return this.request<any>('/bill', { method: 'POST', body: data }); }
  async getBill(id: string) { return this.request<any>(`/bill/${encodeURIComponent(id)}`); }
  async updateBill(data: any) { return this.request<any>('/bill', { method: 'POST', body: { ...data, sparse: data.sparse !== false } }); }
  async deleteBill(id: string, syncToken: string) { return this.request<any>('/bill', { method: 'POST', body: { Id: id, SyncToken: syncToken }, params: { operation: 'delete' } }); }
  async queryBills(filters: any = {}) { return this.query(this.buildQuery('Bill', filters, filters.limit, filters.offset)); }

  // ===== BILL PAYMENT =====
  async createBillPayment(data: any) { return this.request<any>('/billpayment', { method: 'POST', body: data }); }
  async getBillPayment(id: string) { return this.request<any>(`/billpayment/${encodeURIComponent(id)}`); }
  async updateBillPayment(data: any) { return this.request<any>('/billpayment', { method: 'POST', body: { ...data, sparse: data.sparse !== false } }); }
  async deleteBillPayment(id: string, syncToken: string) { return this.request<any>('/billpayment', { method: 'POST', body: { Id: id, SyncToken: syncToken }, params: { operation: 'delete' } }); }
  async queryBillPayments(filters: any = {}) { return this.query(this.buildQuery('BillPayment', filters, filters.limit, filters.offset)); }

  // ===== CUSTOMER =====
  async createCustomer(data: any) { return this.request<any>('/customer', { method: 'POST', body: data }); }
  async getCustomer(id: string) { return this.request<any>(`/customer/${encodeURIComponent(id)}`); }
  async updateCustomer(data: any) { return this.request<any>('/customer', { method: 'POST', body: { ...data, sparse: data.sparse !== false } }); }
  async deleteCustomer(id: string, syncToken: string) { return this.request<any>('/customer', { method: 'POST', body: { Id: id, SyncToken: syncToken, Active: false, sparse: true } }); }
  async queryCustomers(filters: any = {}) { return this.query(this.buildQuery('Customer', filters, filters.limit, filters.offset)); }

  // ===== DEPOSIT (read-only) =====
  async getDeposit(id: string) { return this.request<any>(`/deposit/${encodeURIComponent(id)}`); }
  async queryDeposits(filters: any = {}) {
    const conditions: string[] = [];
    if (filters.TxnDate) conditions.push(`TxnDate = '${filters.TxnDate}'`);
    if (filters.DepositToAccountRef) conditions.push(`DepositToAccountRef = '${filters.DepositToAccountRef}'`);
    if (filters.startDate) conditions.push(`TxnDate >= '${filters.startDate}'`);
    if (filters.endDate) conditions.push(`TxnDate <= '${filters.endDate}'`);
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filters.limit || 100, 1000);
    const offset = filters.offset || 0;
    let sql = `SELECT * FROM Deposit${where}`;
    if (offset > 0) sql += ` STARTPOSITION ${offset + 1}`;
    sql += ` MAXRESULTS ${limit}`;
    return this.query(sql);
  }

  // ===== EMPLOYEE =====
  async createEmployee(data: any) { return this.request<any>('/employee', { method: 'POST', body: data }); }
  async getEmployee(id: string) { return this.request<any>(`/employee/${encodeURIComponent(id)}`); }
  async updateEmployee(data: any) { return this.request<any>('/employee', { method: 'POST', body: { ...data, sparse: data.sparse !== false } }); }
  async deleteEmployee(id: string, syncToken: string) { return this.request<any>('/employee', { method: 'POST', body: { Id: id, SyncToken: syncToken, Active: false, sparse: true } }); }
  async queryEmployees(filters: any = {}) { return this.query(this.buildQuery('Employee', filters, filters.limit, filters.offset)); }

  // ===== ESTIMATE =====
  async createEstimate(data: any) { return this.request<any>('/estimate', { method: 'POST', body: data }); }
  async getEstimate(id: string) { return this.request<any>(`/estimate/${encodeURIComponent(id)}`); }
  async updateEstimate(data: any) { return this.request<any>('/estimate', { method: 'POST', body: { ...data, sparse: data.sparse !== false } }); }
  async deleteEstimate(id: string, syncToken: string) { return this.request<any>('/estimate', { method: 'POST', body: { Id: id, SyncToken: syncToken }, params: { operation: 'delete' } }); }
  async queryEstimates(filters: any = {}) { return this.query(this.buildQuery('Estimate', filters, filters.limit, filters.offset)); }

  // ===== INVOICE =====
  async createInvoice(data: any) { return this.request<any>('/invoice', { method: 'POST', body: data }); }
  async getInvoice(id: string) { return this.request<any>(`/invoice/${encodeURIComponent(id)}`); }
  async updateInvoice(data: any) { return this.request<any>('/invoice', { method: 'POST', body: { ...data, sparse: data.sparse !== false } }); }
  async deleteInvoice(id: string, syncToken: string) { return this.request<any>('/invoice', { method: 'POST', body: { Id: id, SyncToken: syncToken }, params: { operation: 'delete' } }); }
  async queryInvoices(filters: any = {}) { return this.query(this.buildQuery('Invoice', filters, filters.limit, filters.offset)); }

  // ===== ITEM =====
  async createItem(data: any) { return this.request<any>('/item', { method: 'POST', body: data }); }
  async getItem(id: string) { return this.request<any>(`/item/${encodeURIComponent(id)}`); }
  async updateItem(data: any) { return this.request<any>('/item', { method: 'POST', body: { ...data, sparse: data.sparse !== false } }); }
  async deleteItem(id: string, syncToken: string) { return this.request<any>('/item', { method: 'POST', body: { Id: id, SyncToken: syncToken, Active: false, sparse: true } }); }
  async queryItems(filters: any = {}) { return this.query(this.buildQuery('Item', filters, filters.limit, filters.offset)); }

  // ===== JOURNAL ENTRY =====
  async createJournalEntry(data: any) { return this.request<any>('/journalentry', { method: 'POST', body: data }); }
  async getJournalEntry(id: string) { return this.request<any>(`/journalentry/${encodeURIComponent(id)}`); }
  async updateJournalEntry(data: any) { return this.request<any>('/journalentry', { method: 'POST', body: { ...data, sparse: data.sparse !== false } }); }
  async deleteJournalEntry(id: string, syncToken: string) { return this.request<any>('/journalentry', { method: 'POST', body: { Id: id, SyncToken: syncToken }, params: { operation: 'delete' } }); }
  async queryJournalEntries(filters: any = {}) { return this.query(this.buildQuery('JournalEntry', filters, filters.limit, filters.offset)); }

  // ===== PURCHASE =====
  async createPurchase(data: any) { return this.request<any>('/purchase', { method: 'POST', body: data }); }
  async getPurchase(id: string) { return this.request<any>(`/purchase/${encodeURIComponent(id)}`); }
  async updatePurchase(data: any) { return this.request<any>('/purchase', { method: 'POST', body: { ...data, sparse: data.sparse !== false } }); }
  async deletePurchase(id: string, syncToken: string) { return this.request<any>('/purchase', { method: 'POST', body: { Id: id, SyncToken: syncToken }, params: { operation: 'delete' } }); }
  async queryPurchases(filters: any = {}) { return this.query(this.buildQuery('Purchase', filters, filters.limit, filters.offset)); }

  // ===== VENDOR =====
  async createVendor(data: any) { return this.request<any>('/vendor', { method: 'POST', body: data }); }
  async getVendor(id: string) { return this.request<any>(`/vendor/${encodeURIComponent(id)}`); }
  async updateVendor(data: any) { return this.request<any>('/vendor', { method: 'POST', body: { ...data, sparse: data.sparse !== false } }); }
  async deleteVendor(id: string, syncToken: string) { return this.request<any>('/vendor', { method: 'POST', body: { Id: id, SyncToken: syncToken, Active: false, sparse: true } }); }
  async queryVendors(filters: any = {}) { return this.query(this.buildQuery('Vendor', filters, filters.limit, filters.offset)); }

  // ===== COMPANY INFO =====
  async getCompanyInfo() { return this.request<any>(`/companyinfo/${this.realmId}`); }
}
