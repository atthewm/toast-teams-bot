/**
 * Normalized data models for the control tower.
 * These types define the shape of alerts, readiness scores,
 * invoice status, vendor price changes, and item margins
 * flowing through the control tower pipeline.
 */

export type Severity = "green" | "yellow" | "red";
export type AlertStatus = "open" | "acknowledged" | "resolved";

export interface ControlTowerAlert {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: Severity;
  topic: string;
  storeId: string;
  dateWindow: string;
  whatHappened: string;
  whyItMatters: string;
  keyMetrics: Record<string, string | number>;
  recommendedAction: string;
  owner: string;
  dueTime: string | null;
  createdAt: string;
  fingerprint: string;
  shadowMode: boolean;
  /** Whether this duplicates an existing live Toast notification */
  duplicatesExisting: string | null;
  /** Source system: marginedge, toast, computed */
  sourceSystem: string;
}

export interface InvoiceStatus {
  totalInvoices: number;
  totalValue: number;
  byStatus: { status: string; count: number; value: number }[];
  closedCount: number;
  closedPercent: number;
  openCount: number;
}

export interface ReadinessScore {
  overallScore: number;
  components: {
    name: string;
    weight: number;
    score: number;
    details: string;
  }[];
  missing: { component: string; items: string[]; count: number }[];
}

export interface VendorPriceChangeEntry {
  vendorName: string;
  productName: string;
  previousPrice: number;
  currentPrice: number;
  changePercent: number;
}

export interface ItemMarginEntry {
  itemName: string;
  menuPrice: number;
  estimatedCost: number;
  marginPercent: number;
  costComplete: boolean;
  recentVolume: number;
}
