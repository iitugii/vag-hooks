import path from "path";
import { Request, Response, Router } from "express";

import { prisma } from "../lib/prisma";
import { lookupProviderName } from "./employees";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  res.sendFile(path.resolve(__dirname, "../../public/paysheet.html"));
});

type WeeklySummaryRow = {
  provider_id: string | null;
  total_sales: number | null;
  total_tips: number | null;
  service_percentage: number | null;
  tip_fee_percentage: number | null;
  special_deduction: number | null;
  transactions: unknown;
};

type ProviderSummary = {
  providerId: string;
  providerName: string | null;
  totalSales: number;
  tips: number;
  servicePercentage: number | null;
  tipFeePercentage: number | null;
  specialDeduction: number;
  housePay: number;
  techPay: number;
  tipFeeAmount: number;
  techAssistantFee: number;
  commissionComparison: CommissionComparison | null;
  transactions: ProviderTransaction[];
};

type ProviderTransaction = {
  eventId: string;
  timestamp: string | null;
  sale: number;
  tip: number;
  itemSold: string | null;
};

type CommissionComparison = {
  actualPercent: number;
  actualAmount: number;
  baselinePercent: number;
  baselineAmount: number;
  deltaAmount: number;
};

type RawTransaction = {
  eventId?: string | null;
  timestamp?: string | null;
  sale?: number | null;
  tip?: number | null;
  itemSold?: string | null;
};

router.get("/data", async (req: Request, res: Response) => {
  try {
    const weekStartParam = (req.query.weekStart as string) || "";
    const { weekStart, weekEnd } = resolveWeekRange(weekStartParam);

    const rows = await prisma.$queryRaw<WeeklySummaryRow[]>`
      WITH base AS (
        SELECT
          "eventId",
          payload,
          COALESCE("createdDate", "receivedAt") AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York' AS ts_local,
          COALESCE(
            NULLIF((payload->>'serviceProviderId')::text, ''),
            NULLIF((payload->'payload'->>'serviceProviderId')::text, '')
          ) AS provider_id
        FROM "WebhookEvent"
      ),
      week_scope AS (
        SELECT *, ts_local::date AS day_local
        FROM base
        WHERE provider_id IS NOT NULL
          AND ts_local::date BETWEEN ${weekStart}::date AND ${weekEnd}::date
      ),
      normalized AS (
        SELECT
          "eventId" AS event_id,
          provider_id,
          ts_local,
          day_local,
          COALESCE(
            (payload->>'amountDue')::numeric,
            (payload->'payload'->>'amountDue')::numeric,
            (payload->>'amount_due')::numeric,
            (payload->'payload'->>'amount_due')::numeric
          )::double precision AS amount_due_raw,
          COALESCE(
            NULLIF((payload->>'itemSold')::text, ''),
            NULLIF((payload->'payload'->>'itemSold')::text, ''),
            NULLIF((payload->>'serviceName')::text, ''),
            NULLIF((payload->'payload'->>'serviceName')::text, '')
          ) AS item_sold,
          COALESCE(
            (payload->>'tip')::numeric,
            (payload->'payload'->>'tip')::numeric,
            (payload->>'tipAmount')::numeric,
            (payload->'payload'->>'tipAmount')::numeric,
            (payload->>'gratuity')::numeric,
            (payload->'payload'->>'gratuity')::numeric,
            0
          )::double precision AS tip_amount,
          (
            COALESCE((payload->>'ccAmount')::numeric, (payload->'payload'->>'ccAmount')::numeric, 0) +
            COALESCE((payload->>'cashAmount')::numeric, (payload->'payload'->>'cashAmount')::numeric, 0) +
            COALESCE((payload->>'checkAmount')::numeric, (payload->'payload'->>'checkAmount')::numeric, 0) +
            COALESCE((payload->>'achAmount')::numeric, (payload->'payload'->>'achAmount')::numeric, 0) +
            COALESCE((payload->>'otherAmount')::numeric, (payload->'payload'->>'otherAmount')::numeric, 0) +
            COALESCE((payload->>'bankAccountAmount')::numeric, (payload->'payload'->>'bankAccountAmount')::numeric, 0) +
            COALESCE((payload->>'vagaroPayLaterAmount')::numeric, (payload->'payload'->>'vagaroPayLaterAmount')::numeric, 0)
          )::double precision AS tender_total
        FROM week_scope
      ),
      normalized_final AS (
        SELECT
          event_id,
          provider_id,
          ts_local,
          day_local,
          CASE
            WHEN amount_due_raw IS NOT NULL AND amount_due_raw <> 0 THEN amount_due_raw
            WHEN tender_total IS NOT NULL AND tender_total <> 0 THEN tender_total
            ELSE COALESCE(amount_due_raw, 0)
          END AS sale_amount,
          tip_amount,
          item_sold
        FROM normalized
      ),
      deduped AS (
        SELECT DISTINCT ON (event_id)
          event_id,
          provider_id,
          ts_local,
          sale_amount,
          tip_amount,
          item_sold
        FROM normalized_final
        ORDER BY event_id, ts_local DESC
      )
      SELECT
        d.provider_id,
        SUM(GREATEST(d.sale_amount - d.tip_amount, 0)) AS total_sales,
        SUM(d.tip_amount) AS total_tips,
        MAX(pp."servicePercentage") AS service_percentage,
        MAX(pp."tipFeePercentage") AS tip_fee_percentage,
        MAX(pp."specialDeduction") AS special_deduction,
        COALESCE(
          json_agg(
            json_build_object(
              'eventId', d.event_id,
              'timestamp', d.ts_local,
              'sale', d.sale_amount,
              'tip', d.tip_amount,
              'itemSold', d.item_sold
            )
            ORDER BY d.ts_local
          ),
          '[]'::json
        ) AS transactions
      FROM deduped d
      LEFT JOIN "ProviderPercentage" pp ON pp."providerId" = d.provider_id
      GROUP BY d.provider_id
      ORDER BY d.provider_id;
    `;

    const providers: ProviderSummary[] = rows.map((row: WeeklySummaryRow) => {
      const providerId = row.provider_id || "(unknown)";
      const providerName = lookupProviderName(providerId) || null;
      const totalSales = roundCurrency(Number(row.total_sales || 0));
      const tips = roundCurrency(Number(row.total_tips || 0));

      const rawTransactions = Array.isArray(row.transactions)
        ? (row.transactions as RawTransaction[])
        : [];

      const transactions: ProviderTransaction[] = rawTransactions
        .map(tx => {
          const eventId = tx?.eventId ? String(tx.eventId) : "";
          if (!eventId) return null;
          return {
            eventId,
            timestamp: typeof tx?.timestamp === "string" ? tx.timestamp : null,
            sale: Number(tx?.sale || 0),
            tip: Number(tx?.tip || 0),
            itemSold: typeof tx?.itemSold === "string" && tx.itemSold.trim() ? tx.itemSold : null,
          };
        })
        .filter((tx): tx is ProviderTransaction => tx !== null);

      const servicePercentage =
        row.service_percentage === null || row.service_percentage === undefined
          ? null
          : Number(row.service_percentage);

      const tipFeePercentage =
        row.tip_fee_percentage === null || row.tip_fee_percentage === undefined
          ? null
          : Number(row.tip_fee_percentage);

      const specialDeductionRaw =
        row.special_deduction === null || row.special_deduction === undefined
          ? 0
          : Number(row.special_deduction);

      const techServiceRaw =
        servicePercentage === null ? 0 : totalSales * (servicePercentage / 100);
      const houseServiceRaw = totalSales - techServiceRaw;

      const tipFeePct = tipFeePercentage === null ? 0 : tipFeePercentage;
      const tipFeeRaw = tips * (tipFeePct / 100);
      const techTipRaw = tips - tipFeeRaw;

      const assistantEligibleCount = transactions.filter(tx => Math.max(tx.sale - tx.tip, 0) >= 1).length;
      const assistantRate =
        servicePercentage === null ? 0 : servicePercentage >= 50 ? 2 : 1;
      const techAssistantFeeRaw = assistantEligibleCount * assistantRate;

      const housePay = roundCurrency(
        houseServiceRaw + tipFeeRaw + techAssistantFeeRaw + specialDeductionRaw
      );
      const techPay = roundCurrency(
        Math.max(techServiceRaw + techTipRaw - techAssistantFeeRaw - specialDeductionRaw, 0)
      );
      const techAssistantFee = roundCurrency(techAssistantFeeRaw);
      const tipFeeAmount = roundCurrency(tipFeeRaw);
      const specialDeduction = roundCurrency(specialDeductionRaw);

      const commissionComparison:
        | CommissionComparison
        | null = servicePercentage !== null && servicePercentage < 50
        ? {
            actualPercent: roundPercentage(servicePercentage),
            actualAmount: roundCurrency(techServiceRaw),
            baselinePercent: 50,
            baselineAmount: roundCurrency(totalSales * 0.5),
            deltaAmount: roundCurrency(totalSales * 0.5 - techServiceRaw),
          }
        : null;

      return {
        providerId,
        providerName,
        totalSales,
        tips,
        servicePercentage,
        tipFeePercentage,
        specialDeduction,
        housePay,
        techPay,
        tipFeeAmount,
        techAssistantFee,
        commissionComparison,
        transactions,
      };
    });

    const totals = providers.reduce(
      (acc, row) => {
        acc.totalSales += row.totalSales;
        acc.tips += row.tips;
        acc.housePay += row.housePay;
        acc.techPay += row.techPay;
        acc.tipFee += row.tipFeeAmount;
        acc.techAssistantFee += row.techAssistantFee;
        acc.specialDeduction += row.specialDeduction;
        return acc;
      },
      {
        totalSales: 0,
        tips: 0,
        housePay: 0,
        techPay: 0,
        tipFee: 0,
        techAssistantFee: 0,
        specialDeduction: 0,
      }
    );

    const totalsRounded = {
      totalSales: roundCurrency(totals.totalSales),
      tips: roundCurrency(totals.tips),
      housePay: roundCurrency(totals.housePay),
      techPay: roundCurrency(totals.techPay),
      tipFee: roundCurrency(totals.tipFee),
      techAssistantFee: roundCurrency(totals.techAssistantFee),
      specialDeduction: roundCurrency(totals.specialDeduction),
      commissionDiff: roundCurrency(
        providers.reduce((sum, row) => sum + (row.commissionComparison?.deltaAmount || 0), 0)
      ),
    };

    res.json({
      weekStart,
      weekEnd,
      totals: totalsRounded,
      providers: providers.map(row => ({
        providerId: row.providerId,
        providerName: row.providerName,
        servicePercentage: row.servicePercentage,
        tipFeePercentage: row.tipFeePercentage,
        specialDeduction: row.specialDeduction,
        totalSales: row.totalSales,
        tips: row.tips,
        housePay: row.housePay,
        techPay: row.techPay,
        tipFeeAmount: row.tipFeeAmount,
        techAssistantFee: row.techAssistantFee,
        commissionComparison: row.commissionComparison,
        transactions: row.transactions,
      })),
    });
  } catch (err: any) {
    console.error("/paysheet/data failed", err);
    res.status(500).json({ error: err?.message || "Failed to load paysheet data" });
  }
});

router.post("/percentage", async (req: Request, res: Response) => {
  try {
    const providerId = typeof req.body?.providerId === "string" ? req.body.providerId.trim() : "";
    if (!providerId) {
      return res.status(400).json({ error: "providerId is required" });
    }

    const body = req.body ?? {};
    const hasServiceField =
      Object.prototype.hasOwnProperty.call(body, "servicePercentage") ||
      Object.prototype.hasOwnProperty.call(body, "percentage");
    const hasTipField =
      Object.prototype.hasOwnProperty.call(body, "tipFeePercentage") ||
      Object.prototype.hasOwnProperty.call(body, "tipFee");
    const hasDeductionField = Object.prototype.hasOwnProperty.call(body, "specialDeduction");

    if (!hasServiceField && !hasTipField && !hasDeductionField) {
      return res.status(400).json({ error: "No configuration values provided" });
    }

    let serviceValue: number | null | undefined = undefined;
    if (hasServiceField) {
      try {
        serviceValue = parsePercentage(body.servicePercentage ?? body.percentage);
      } catch (parseErr: any) {
        return res
          .status(400)
          .json({ error: parseErr?.message || "Invalid service percentage value" });
      }
    }

    let tipFeeValue: number | null | undefined = undefined;
    if (hasTipField) {
      try {
        tipFeeValue = parsePercentage(body.tipFeePercentage ?? body.tipFee);
      } catch (parseErr: any) {
        return res
          .status(400)
          .json({ error: parseErr?.message || "Invalid tip fee percentage value" });
      }
    }

    let specialDeductionValue: number | null | undefined = undefined;
    if (hasDeductionField) {
      try {
        specialDeductionValue = parseCurrency(body.specialDeduction);
      } catch (parseErr: any) {
        return res
          .status(400)
          .json({ error: parseErr?.message || "Invalid special deduction amount" });
      }
    }

    const existing = await prisma.providerPercentage.findUnique({ where: { providerId } });

    const effectiveService =
      hasServiceField ? serviceValue ?? null : existing?.servicePercentage ?? null;
    const effectiveTipFee = hasTipField ? tipFeeValue ?? null : existing?.tipFeePercentage ?? null;
    const effectiveSpecialDeduction = hasDeductionField
      ? specialDeductionValue ?? null
      : existing?.specialDeduction ?? null;

    if (effectiveService === null && effectiveTipFee === null && effectiveSpecialDeduction === null) {
      if (existing) {
        await prisma.providerPercentage
          .delete({ where: { providerId } })
          .catch(() => undefined);
      }
      return res.json({
        providerId,
        servicePercentage: null,
        tipFeePercentage: null,
        specialDeduction: null,
      });
    }

    const record = await prisma.providerPercentage.upsert({
      where: { providerId },
      update: {
        ...(hasServiceField ? { servicePercentage: serviceValue ?? null } : {}),
        ...(hasTipField ? { tipFeePercentage: tipFeeValue ?? null } : {}),
        ...(hasDeductionField ? { specialDeduction: specialDeductionValue ?? null } : {}),
      },
      create: {
        providerId,
        servicePercentage: effectiveService,
        tipFeePercentage: effectiveTipFee,
        specialDeduction: effectiveSpecialDeduction,
      },
    });

    res.json({
      providerId: record.providerId,
      servicePercentage: record.servicePercentage,
      tipFeePercentage: record.tipFeePercentage,
      specialDeduction: record.specialDeduction,
    });
  } catch (err: any) {
    console.error("/paysheet/percentage failed", err);
    res.status(500).json({ error: err?.message || "Failed to save percentage" });
  }
});

function resolveWeekRange(input: string | undefined) {
  let base = input ? parseDate(input) : startOfWeek(new Date());
  if (!base) {
    throw new Error("Invalid weekStart; expected YYYY-MM-DD");
  }
  const start = startOfWeek(base);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return { weekStart: formatDate(start), weekEnd: formatDate(end) };
}

function parseDate(value: string): Date | null {
  const trimmed = (value || "").trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfWeek(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay();
  const diff = day; // Sunday start
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

function formatDate(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundPercentage(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function parsePercentage(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error("Percentage must be a number");
  }

  if (numeric < 0 || numeric > 100) {
    throw new Error("Percentage must be between 0 and 100");
  }

  return Math.round(numeric * 100) / 100;
}

function parseCurrency(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Amount must be a finite number");
    }
    return roundCurrency(value);
  }

  if (typeof value === "string") {
    const cleaned = value.replace(/[$,\s]/g, "");
    if (!cleaned) {
      return null;
    }
    const numeric = Number(cleaned);
    if (!Number.isFinite(numeric)) {
      throw new Error("Amount must be a number");
    }
    if (numeric < 0) {
      throw new Error("Amount must be zero or positive");
    }
    return roundCurrency(numeric);
  }

  throw new Error("Amount must be a number or string");
}

export default router;
