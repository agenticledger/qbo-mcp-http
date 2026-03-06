import { z } from 'zod';
import { QBOClient } from './api-client.js';

/**
 * QuickBooks Online MCP Tool Definitions
 *
 * 58 tools across 12 entity types:
 * Account, Bill, BillPayment, Customer, Deposit,
 * Employee, Estimate, Invoice, Item, JournalEntry,
 * Purchase, Vendor, CompanyInfo
 */

interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodType<any>;
  handler: (client: QBOClient, args: any) => Promise<any>;
}

const paginationParams = {
  limit: z.number().optional().describe('max results (default 100, max 1000)'),
  offset: z.number().optional().describe('offset for pagination'),
};

export const tools: ToolDef[] = [
  // ==================== ACCOUNT (5) ====================
  {
    name: 'account_create',
    description: 'Create a chart of accounts entry',
    inputSchema: z.object({
      Name: z.string().describe('account name'),
      AccountType: z.enum([
        'Bank', 'Other Current Asset', 'Fixed Asset', 'Other Asset',
        'Accounts Receivable', 'Equity', 'Expense', 'Other Expense',
        'Cost of Goods Sold', 'Accounts Payable', 'Credit Card',
        'Long Term Liability', 'Other Current Liability', 'Income', 'Other Income',
      ]).describe('account type'),
      AccountSubType: z.string().optional().describe('account subtype'),
      Description: z.string().optional().describe('account description'),
      AcctNum: z.string().optional().describe('account number'),
    }),
    handler: async (client, args) => client.createAccount(args),
  },
  {
    name: 'account_get',
    description: 'Get an account by ID',
    inputSchema: z.object({
      Id: z.string().describe('account ID'),
    }),
    handler: async (client, args) => client.getAccount(args.Id),
  },
  {
    name: 'account_update',
    description: 'Update an existing account',
    inputSchema: z.object({
      Id: z.string().describe('account ID'),
      SyncToken: z.string().describe('sync token for locking'),
      Name: z.string().optional().describe('updated name'),
      Description: z.string().optional().describe('updated description'),
      Active: z.boolean().optional().describe('active status'),
    }),
    handler: async (client, args) => client.updateAccount(args),
  },
  {
    name: 'account_delete',
    description: 'Deactivate an account',
    inputSchema: z.object({
      Id: z.string().describe('account ID'),
      SyncToken: z.string().describe('sync token for locking'),
    }),
    handler: async (client, args) => client.deleteAccount(args.Id, args.SyncToken),
  },
  {
    name: 'accounts_list',
    description: 'Query accounts with filters',
    inputSchema: z.object({
      Name: z.string().optional().describe('filter by name'),
      AccountType: z.string().optional().describe('filter by type'),
      Active: z.boolean().optional().describe('filter by active'),
      ...paginationParams,
    }),
    handler: async (client, args) => client.queryAccounts(args),
  },

  // ==================== BILL (5) ====================
  {
    name: 'bill_create',
    description: 'Create a vendor bill',
    inputSchema: z.object({
      VendorRef: z.object({ value: z.string().describe('vendor ID') }).describe('vendor reference'),
      Line: z.array(z.any()).describe('bill line items'),
      TxnDate: z.string().optional().describe('date YYYY-MM-DD'),
      DueDate: z.string().optional().describe('due date YYYY-MM-DD'),
    }),
    handler: async (client, args) => client.createBill(args),
  },
  {
    name: 'bill_get',
    description: 'Get a bill by ID',
    inputSchema: z.object({
      Id: z.string().describe('bill ID'),
    }),
    handler: async (client, args) => client.getBill(args.Id),
  },
  {
    name: 'bill_update',
    description: 'Update an existing bill',
    inputSchema: z.object({
      Id: z.string().describe('bill ID'),
      SyncToken: z.string().describe('sync token for locking'),
      Line: z.array(z.any()).optional().describe('updated line items'),
      DueDate: z.string().optional().describe('updated due date'),
    }),
    handler: async (client, args) => client.updateBill(args),
  },
  {
    name: 'bill_delete',
    description: 'Delete a bill',
    inputSchema: z.object({
      Id: z.string().describe('bill ID'),
      SyncToken: z.string().describe('sync token for locking'),
    }),
    handler: async (client, args) => client.deleteBill(args.Id, args.SyncToken),
  },
  {
    name: 'bills_list',
    description: 'Query bills with filters',
    inputSchema: z.object({
      VendorRef: z.string().optional().describe('filter by vendor ID'),
      TxnDate: z.string().optional().describe('filter by date'),
      DueDate: z.string().optional().describe('filter by due date'),
      ...paginationParams,
    }),
    handler: async (client, args) => client.queryBills(args),
  },

  // ==================== BILL PAYMENT (5) ====================
  {
    name: 'bill_payment_create',
    description: 'Create a bill payment',
    inputSchema: z.object({
      VendorRef: z.object({ value: z.string().describe('vendor ID') }).describe('vendor reference'),
      PayType: z.enum(['Check', 'CreditCard']).describe('payment type'),
      TotalAmt: z.number().describe('total payment amount'),
      TxnDate: z.string().optional().describe('date YYYY-MM-DD'),
    }),
    handler: async (client, args) => client.createBillPayment(args),
  },
  {
    name: 'bill_payment_get',
    description: 'Get a bill payment by ID',
    inputSchema: z.object({
      Id: z.string().describe('bill payment ID'),
    }),
    handler: async (client, args) => client.getBillPayment(args.Id),
  },
  {
    name: 'bill_payment_update',
    description: 'Update an existing bill payment',
    inputSchema: z.object({
      Id: z.string().describe('bill payment ID'),
      SyncToken: z.string().describe('sync token for locking'),
      TotalAmt: z.number().optional().describe('updated amount'),
    }),
    handler: async (client, args) => client.updateBillPayment(args),
  },
  {
    name: 'bill_payment_delete',
    description: 'Delete a bill payment',
    inputSchema: z.object({
      Id: z.string().describe('bill payment ID'),
      SyncToken: z.string().describe('sync token for locking'),
    }),
    handler: async (client, args) => client.deleteBillPayment(args.Id, args.SyncToken),
  },
  {
    name: 'bill_payments_list',
    description: 'Query bill payments with filters',
    inputSchema: z.object({
      VendorRef: z.string().optional().describe('filter by vendor ID'),
      TxnDate: z.string().optional().describe('filter by date'),
      ...paginationParams,
    }),
    handler: async (client, args) => client.queryBillPayments(args),
  },

  // ==================== CUSTOMER (5) ====================
  {
    name: 'customer_create',
    description: 'Create a customer',
    inputSchema: z.object({
      DisplayName: z.string().describe('customer display name'),
      GivenName: z.string().optional().describe('first name'),
      FamilyName: z.string().optional().describe('last name'),
      CompanyName: z.string().optional().describe('company name'),
      PrimaryEmailAddr: z.object({ Address: z.string().describe('email') }).optional().describe('primary email'),
    }),
    handler: async (client, args) => client.createCustomer(args),
  },
  {
    name: 'customer_get',
    description: 'Get a customer by ID',
    inputSchema: z.object({
      Id: z.string().describe('customer ID'),
    }),
    handler: async (client, args) => client.getCustomer(args.Id),
  },
  {
    name: 'customer_update',
    description: 'Update an existing customer',
    inputSchema: z.object({
      Id: z.string().describe('customer ID'),
      SyncToken: z.string().describe('sync token for locking'),
      DisplayName: z.string().optional().describe('updated display name'),
      Active: z.boolean().optional().describe('active status'),
    }),
    handler: async (client, args) => client.updateCustomer(args),
  },
  {
    name: 'customer_delete',
    description: 'Deactivate a customer (soft delete)',
    inputSchema: z.object({
      Id: z.string().describe('customer ID'),
      SyncToken: z.string().describe('sync token for locking'),
    }),
    handler: async (client, args) => client.deleteCustomer(args.Id, args.SyncToken),
  },
  {
    name: 'customers_list',
    description: 'Query customers with filters',
    inputSchema: z.object({
      DisplayName: z.string().optional().describe('filter by name'),
      Active: z.boolean().optional().describe('filter by active'),
      ...paginationParams,
    }),
    handler: async (client, args) => client.queryCustomers(args),
  },

  // ==================== DEPOSIT (2, read-only) ====================
  {
    name: 'deposit_get',
    description: 'Get a deposit by ID',
    inputSchema: z.object({
      Id: z.string().describe('deposit ID'),
    }),
    handler: async (client, args) => client.getDeposit(args.Id),
  },
  {
    name: 'deposits_list',
    description: 'Query deposits with filters',
    inputSchema: z.object({
      TxnDate: z.string().optional().describe('filter by date YYYY-MM-DD'),
      DepositToAccountRef: z.string().optional().describe('filter by account ID'),
      startDate: z.string().optional().describe('start date YYYY-MM-DD'),
      endDate: z.string().optional().describe('end date YYYY-MM-DD'),
      ...paginationParams,
    }),
    handler: async (client, args) => client.queryDeposits(args),
  },

  // ==================== EMPLOYEE (5) ====================
  {
    name: 'employee_create',
    description: 'Create an employee record',
    inputSchema: z.object({
      GivenName: z.string().describe('first name'),
      FamilyName: z.string().describe('last name'),
      DisplayName: z.string().optional().describe('display name'),
      EmployeeNumber: z.string().optional().describe('employee number'),
      HiredDate: z.string().optional().describe('hire date YYYY-MM-DD'),
    }),
    handler: async (client, args) => client.createEmployee(args),
  },
  {
    name: 'employee_get',
    description: 'Get an employee by ID',
    inputSchema: z.object({
      Id: z.string().describe('employee ID'),
    }),
    handler: async (client, args) => client.getEmployee(args.Id),
  },
  {
    name: 'employee_update',
    description: 'Update an existing employee',
    inputSchema: z.object({
      Id: z.string().describe('employee ID'),
      SyncToken: z.string().describe('sync token for locking'),
      GivenName: z.string().optional().describe('updated first name'),
      FamilyName: z.string().optional().describe('updated last name'),
      Active: z.boolean().optional().describe('active status'),
    }),
    handler: async (client, args) => client.updateEmployee(args),
  },
  {
    name: 'employee_delete',
    description: 'Deactivate an employee (soft delete)',
    inputSchema: z.object({
      Id: z.string().describe('employee ID'),
      SyncToken: z.string().describe('sync token for locking'),
    }),
    handler: async (client, args) => client.deleteEmployee(args.Id, args.SyncToken),
  },
  {
    name: 'employees_list',
    description: 'Query employees with filters',
    inputSchema: z.object({
      GivenName: z.string().optional().describe('filter by first name'),
      FamilyName: z.string().optional().describe('filter by last name'),
      Active: z.boolean().optional().describe('filter by active'),
      ...paginationParams,
    }),
    handler: async (client, args) => client.queryEmployees(args),
  },

  // ==================== ESTIMATE (5) ====================
  {
    name: 'estimate_create',
    description: 'Create an estimate/quote',
    inputSchema: z.object({
      CustomerRef: z.object({ value: z.string().describe('customer ID') }).describe('customer reference'),
      Line: z.array(z.any()).describe('estimate line items'),
      TxnDate: z.string().optional().describe('date YYYY-MM-DD'),
      ExpirationDate: z.string().optional().describe('expiration YYYY-MM-DD'),
    }),
    handler: async (client, args) => client.createEstimate(args),
  },
  {
    name: 'estimate_get',
    description: 'Get an estimate by ID',
    inputSchema: z.object({
      Id: z.string().describe('estimate ID'),
    }),
    handler: async (client, args) => client.getEstimate(args.Id),
  },
  {
    name: 'estimate_update',
    description: 'Update an existing estimate',
    inputSchema: z.object({
      Id: z.string().describe('estimate ID'),
      SyncToken: z.string().describe('sync token for locking'),
      Line: z.array(z.any()).optional().describe('updated line items'),
      ExpirationDate: z.string().optional().describe('updated expiration'),
    }),
    handler: async (client, args) => client.updateEstimate(args),
  },
  {
    name: 'estimate_delete',
    description: 'Delete an estimate',
    inputSchema: z.object({
      Id: z.string().describe('estimate ID'),
      SyncToken: z.string().describe('sync token for locking'),
    }),
    handler: async (client, args) => client.deleteEstimate(args.Id, args.SyncToken),
  },
  {
    name: 'estimates_list',
    description: 'Query estimates with filters',
    inputSchema: z.object({
      CustomerRef: z.string().optional().describe('filter by customer ID'),
      TxnDate: z.string().optional().describe('filter by date'),
      ...paginationParams,
    }),
    handler: async (client, args) => client.queryEstimates(args),
  },

  // ==================== INVOICE (5) ====================
  {
    name: 'invoice_create',
    description: 'Create an invoice',
    inputSchema: z.object({
      CustomerRef: z.object({ value: z.string().describe('customer ID') }).describe('customer reference'),
      Line: z.array(z.any()).describe('invoice line items'),
      TxnDate: z.string().optional().describe('date YYYY-MM-DD'),
      DueDate: z.string().optional().describe('due date YYYY-MM-DD'),
    }),
    handler: async (client, args) => client.createInvoice(args),
  },
  {
    name: 'invoice_get',
    description: 'Get an invoice by ID',
    inputSchema: z.object({
      Id: z.string().describe('invoice ID'),
    }),
    handler: async (client, args) => client.getInvoice(args.Id),
  },
  {
    name: 'invoice_update',
    description: 'Update an existing invoice',
    inputSchema: z.object({
      Id: z.string().describe('invoice ID'),
      SyncToken: z.string().describe('sync token for locking'),
      Line: z.array(z.any()).optional().describe('updated line items'),
      DueDate: z.string().optional().describe('updated due date'),
    }),
    handler: async (client, args) => client.updateInvoice(args),
  },
  {
    name: 'invoice_delete',
    description: 'Delete an invoice',
    inputSchema: z.object({
      Id: z.string().describe('invoice ID'),
      SyncToken: z.string().describe('sync token for locking'),
    }),
    handler: async (client, args) => client.deleteInvoice(args.Id, args.SyncToken),
  },
  {
    name: 'invoices_list',
    description: 'Query invoices with filters',
    inputSchema: z.object({
      CustomerRef: z.string().optional().describe('filter by customer ID'),
      TxnDate: z.string().optional().describe('filter by date'),
      DueDate: z.string().optional().describe('filter by due date'),
      ...paginationParams,
    }),
    handler: async (client, args) => client.queryInvoices(args),
  },

  // ==================== ITEM (5) ====================
  {
    name: 'item_create',
    description: 'Create a product or service item',
    inputSchema: z.object({
      Name: z.string().describe('item name'),
      Type: z.enum(['Inventory', 'Service', 'NonInventory']).describe('item type'),
      Description: z.string().optional().describe('item description'),
      UnitPrice: z.number().optional().describe('unit price'),
      IncomeAccountRef: z.object({ value: z.string().describe('account ID') }).optional().describe('income account'),
    }),
    handler: async (client, args) => client.createItem(args),
  },
  {
    name: 'item_get',
    description: 'Get an item by ID',
    inputSchema: z.object({
      Id: z.string().describe('item ID'),
    }),
    handler: async (client, args) => client.getItem(args.Id),
  },
  {
    name: 'item_update',
    description: 'Update an existing item',
    inputSchema: z.object({
      Id: z.string().describe('item ID'),
      SyncToken: z.string().describe('sync token for locking'),
      Name: z.string().optional().describe('updated name'),
      Description: z.string().optional().describe('updated description'),
      UnitPrice: z.number().optional().describe('updated price'),
      Active: z.boolean().optional().describe('active status'),
    }),
    handler: async (client, args) => client.updateItem(args),
  },
  {
    name: 'item_delete',
    description: 'Deactivate an item (soft delete)',
    inputSchema: z.object({
      Id: z.string().describe('item ID'),
      SyncToken: z.string().describe('sync token for locking'),
    }),
    handler: async (client, args) => client.deleteItem(args.Id, args.SyncToken),
  },
  {
    name: 'items_list',
    description: 'Query items with filters',
    inputSchema: z.object({
      Name: z.string().optional().describe('filter by name'),
      Type: z.string().optional().describe('filter by type'),
      Active: z.boolean().optional().describe('filter by active'),
      ...paginationParams,
    }),
    handler: async (client, args) => client.queryItems(args),
  },

  // ==================== JOURNAL ENTRY (5) ====================
  {
    name: 'journal_entry_create',
    description: 'Create a journal entry',
    inputSchema: z.object({
      Line: z.array(z.any()).describe('journal lines (must balance)'),
      TxnDate: z.string().optional().describe('date YYYY-MM-DD'),
      PrivateNote: z.string().optional().describe('private memo'),
    }),
    handler: async (client, args) => client.createJournalEntry(args),
  },
  {
    name: 'journal_entry_get',
    description: 'Get a journal entry by ID',
    inputSchema: z.object({
      Id: z.string().describe('journal entry ID'),
    }),
    handler: async (client, args) => client.getJournalEntry(args.Id),
  },
  {
    name: 'journal_entry_update',
    description: 'Update an existing journal entry',
    inputSchema: z.object({
      Id: z.string().describe('journal entry ID'),
      SyncToken: z.string().describe('sync token for locking'),
      Line: z.array(z.any()).optional().describe('updated lines'),
      PrivateNote: z.string().optional().describe('updated memo'),
    }),
    handler: async (client, args) => client.updateJournalEntry(args),
  },
  {
    name: 'journal_entry_delete',
    description: 'Delete a journal entry',
    inputSchema: z.object({
      Id: z.string().describe('journal entry ID'),
      SyncToken: z.string().describe('sync token for locking'),
    }),
    handler: async (client, args) => client.deleteJournalEntry(args.Id, args.SyncToken),
  },
  {
    name: 'journal_entries_list',
    description: 'Query journal entries with filters',
    inputSchema: z.object({
      TxnDate: z.string().optional().describe('filter by date'),
      ...paginationParams,
    }),
    handler: async (client, args) => client.queryJournalEntries(args),
  },

  // ==================== PURCHASE (5) ====================
  {
    name: 'purchase_create',
    description: 'Create a purchase transaction',
    inputSchema: z.object({
      AccountRef: z.object({ value: z.string().describe('bank/card account ID') }).describe('account reference'),
      PaymentType: z.enum(['Cash', 'Check', 'CreditCard']).describe('payment type'),
      Line: z.array(z.any()).describe('purchase line items'),
      TxnDate: z.string().optional().describe('date YYYY-MM-DD'),
    }),
    handler: async (client, args) => client.createPurchase(args),
  },
  {
    name: 'purchase_get',
    description: 'Get a purchase by ID',
    inputSchema: z.object({
      Id: z.string().describe('purchase ID'),
    }),
    handler: async (client, args) => client.getPurchase(args.Id),
  },
  {
    name: 'purchase_update',
    description: 'Update an existing purchase',
    inputSchema: z.object({
      Id: z.string().describe('purchase ID'),
      SyncToken: z.string().describe('sync token for locking'),
      Line: z.array(z.any()).optional().describe('updated line items'),
    }),
    handler: async (client, args) => client.updatePurchase(args),
  },
  {
    name: 'purchase_delete',
    description: 'Delete a purchase',
    inputSchema: z.object({
      Id: z.string().describe('purchase ID'),
      SyncToken: z.string().describe('sync token for locking'),
    }),
    handler: async (client, args) => client.deletePurchase(args.Id, args.SyncToken),
  },
  {
    name: 'purchases_list',
    description: 'Query purchases with filters',
    inputSchema: z.object({
      PaymentType: z.string().optional().describe('filter by payment type'),
      TxnDate: z.string().optional().describe('filter by date'),
      ...paginationParams,
    }),
    handler: async (client, args) => client.queryPurchases(args),
  },

  // ==================== VENDOR (5) ====================
  {
    name: 'vendor_create',
    description: 'Create a vendor',
    inputSchema: z.object({
      DisplayName: z.string().describe('vendor display name'),
      CompanyName: z.string().optional().describe('company name'),
      GivenName: z.string().optional().describe('first name'),
      FamilyName: z.string().optional().describe('last name'),
      PrimaryEmailAddr: z.object({ Address: z.string().describe('email') }).optional().describe('primary email'),
    }),
    handler: async (client, args) => client.createVendor(args),
  },
  {
    name: 'vendor_get',
    description: 'Get a vendor by ID',
    inputSchema: z.object({
      Id: z.string().describe('vendor ID'),
    }),
    handler: async (client, args) => client.getVendor(args.Id),
  },
  {
    name: 'vendor_update',
    description: 'Update an existing vendor',
    inputSchema: z.object({
      Id: z.string().describe('vendor ID'),
      SyncToken: z.string().describe('sync token for locking'),
      DisplayName: z.string().optional().describe('updated display name'),
      CompanyName: z.string().optional().describe('updated company name'),
      Active: z.boolean().optional().describe('active status'),
    }),
    handler: async (client, args) => client.updateVendor(args),
  },
  {
    name: 'vendor_delete',
    description: 'Deactivate a vendor (soft delete)',
    inputSchema: z.object({
      Id: z.string().describe('vendor ID'),
      SyncToken: z.string().describe('sync token for locking'),
    }),
    handler: async (client, args) => client.deleteVendor(args.Id, args.SyncToken),
  },
  {
    name: 'vendors_list',
    description: 'Query vendors with filters',
    inputSchema: z.object({
      DisplayName: z.string().optional().describe('filter by name'),
      CompanyName: z.string().optional().describe('filter by company'),
      Active: z.boolean().optional().describe('filter by active'),
      ...paginationParams,
    }),
    handler: async (client, args) => client.queryVendors(args),
  },

  // ==================== COMPANY INFO (1) ====================
  {
    name: 'company_info_get',
    description: 'Get company information',
    inputSchema: z.object({}),
    handler: async (client) => client.getCompanyInfo(),
  },
];
