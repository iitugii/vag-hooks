import path from "path";
import { Request, Response, Router } from "express";

import { prisma } from "../lib/prisma";
import { lookupProviderName, providerServicePercentages, resolveProviderId } from "./employees";
import { excludedServiceSet } from "./excludeservice";

const router = Router();
const AUTO_SPECIAL_DEDUCTION_AMOUNT = 42;

router.get("/", (_req: Request, res: Response) => {
  res.sendFile(path.resolve(__dirname, "../../public/paysheet.html"));
});

type WeeklySummaryRow = {
  provider_id: string | null;
  total_sales: number | null;
  total_amount_due: number | null;
  total_cash_delta: number | null;
  total_cc_delta: number | null;
  total_gc_redemption: number | null;
  total_tips: number | null;
  service_percentage: number | null;
  tip_fee_percentage: number | null;
  special_deduction: number | null;
  special_addition: number | null;
  transactions: unknown;
};

type ProviderSummary = {
  providerId: string;
  providerName: string | null;
  totalSales: number;
  totalAmountDue: number;
  totalCashDelta: number;
  totalCcDelta: number;
  totalGcRedemption: number;
  totalNewService: number;
  tips: number;
  servicePercentage: number | null;
  tipFeePercentage: number | null;
  specialDeduction: number;
  specialAddition: number;
  specialDeductionAutoApplied: boolean;
  housePay: number;
  techPay: number;
  tipFeeAmount: number;
  techAssistantFee: number;
  commissionComparison: CommissionComparison | null;
  transactions: ProviderTransaction[];
  formulaComponents: ProviderFormulaComponents;
};

type ProviderFormulaComponents = {
  cashAmount: number;
  amountDue: number;
  cardAmount: number;
  giftCard: number;
  tip: number;
};

type ProviderTransaction = {
  eventId: string;
  timestamp: string | null;
  sale: number;
  tip: number;
  amountDue: number;
  cashAmount: number;
  cashDelta: number;
  ccAmount: number;
  ccDelta: number;
  gcRedemption: number;
  newServiceValue: number;
  itemSold: string | null;
  excludedFromAssistantFee: boolean;
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
  amountDue?: number | null;
  cashAmount?: number | null;
  ccAmount?: number | null;
  gcRedemption?: number | null;
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
          )::double precision AS tender_total,
          COALESCE(
            (payload->>'cashAmount')::numeric,
            (payload->'payload'->>'cashAmount')::numeric,
            0
          )::double precision AS cash_amount_raw,
          COALESCE(
            (payload->>'ccAmount')::numeric,
            (payload->'payload'->>'ccAmount')::numeric,
            0
          )::double precision AS cc_amount_raw,
          COALESCE(
            (payload->>'gcRedemption')::numeric,
            (payload->'payload'->>'gcRedemption')::numeric,
            0
          )::double precision AS gc_redemption_raw
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
          amount_due_raw,
          cash_amount_raw,
          cc_amount_raw,
          gc_redemption_raw,
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
          amount_due_raw,
          cash_amount_raw,
          cc_amount_raw,
          gc_redemption_raw,
          item_sold
        FROM normalized_final
        ORDER BY event_id, ts_local DESC
      )
      SELECT
        d.provider_id,
        SUM(GREATEST(d.sale_amount - d.tip_amount, 0)) AS total_sales,
        SUM(COALESCE(d.amount_due_raw, 0)) AS total_amount_due,
        SUM(COALESCE(d.cash_amount_raw, 0) - COALESCE(d.amount_due_raw, 0)) AS total_cash_delta,
        SUM(COALESCE(d.cc_amount_raw, 0) + COALESCE(d.gc_redemption_raw, 0) - COALESCE(d.tip_amount, 0)) AS total_cc_delta,
        SUM(COALESCE(d.gc_redemption_raw, 0)) AS total_gc_redemption,
        SUM(d.tip_amount) AS total_tips,
        MAX(pwc."servicePercentage") AS service_percentage,
        MAX(pwc."tipFeePercentage") AS tip_fee_percentage,
        MAX(pwc."specialDeduction") AS special_deduction,
        MAX(pwc."specialAddition") AS special_addition,
        COALESCE(
          json_agg(
            json_build_object(
              'eventId', d.event_id,
              'timestamp', d.ts_local,
              'sale', d.sale_amount,
              'tip', d.tip_amount,
              'amountDue', d.amount_due_raw,
              'cashAmount', d.cash_amount_raw,
              'ccAmount', d.cc_amount_raw,
              'gcRedemption', d.gc_redemption_raw,
              'itemSold', d.item_sold
            )
            ORDER BY d.ts_local
          ),
          '[]'::json
        ) AS transactions
      FROM deduped d
      LEFT JOIN "ProviderWeekConfig" pwc
        ON pwc."providerId" = d.provider_id
       AND pwc."weekStart" = ${weekStart}::date
      GROUP BY d.provider_id
      ORDER BY d.provider_id;
    `;

    // Merge rows by canonical provider id (handles manual uploads sending names instead of IDs)
    const merged: WeeklySummaryRow[] = [];
    const acc = new Map<string, WeeklySummaryRow>();

    for (const row of rows) {
      const rawId = typeof row.provider_id === "string" ? row.provider_id.trim() : "";
      const canonicalId = resolveProviderId(rawId) || rawId || "(unknown)";
      const key = canonicalId;
      const transactionsArray = Array.isArray(row.transactions) ? (row.transactions as RawTransaction[]) : [];
      const existing = acc.get(key);

      if (!existing) {
        acc.set(key, {
          provider_id: canonicalId,
          total_sales: Number(row.total_sales || 0),
          total_amount_due: Number(row.total_amount_due || 0),
          total_cash_delta: Number(row.total_cash_delta || 0),
          total_cc_delta: Number(row.total_cc_delta || 0),
          total_gc_redemption: Number(row.total_gc_redemption || 0),
          total_tips: Number(row.total_tips || 0),
          service_percentage: row.service_percentage,
          tip_fee_percentage: row.tip_fee_percentage,
          special_deduction: row.special_deduction,
          special_addition: row.special_addition,
          transactions: transactionsArray,
        });
      } else {
        existing.total_sales = Number(existing.total_sales || 0) + Number(row.total_sales || 0);
        existing.total_amount_due = Number(existing.total_amount_due || 0) + Number(row.total_amount_due || 0);
        existing.total_cash_delta = Number(existing.total_cash_delta || 0) + Number(row.total_cash_delta || 0);
        existing.total_cc_delta = Number(existing.total_cc_delta || 0) + Number(row.total_cc_delta || 0);
        existing.total_gc_redemption = Number(existing.total_gc_redemption || 0) + Number(row.total_gc_redemption || 0);
        existing.total_tips = Number(existing.total_tips || 0) + Number(row.total_tips || 0);
        existing.service_percentage = existing.service_percentage ?? row.service_percentage;
        existing.tip_fee_percentage = existing.tip_fee_percentage ?? row.tip_fee_percentage;
        existing.special_deduction = existing.special_deduction ?? row.special_deduction;
        existing.special_addition = existing.special_addition ?? row.special_addition;
        const existingTx = Array.isArray(existing.transactions) ? (existing.transactions as RawTransaction[]) : [];
        existing.transactions = existingTx.concat(transactionsArray);
      }
    }

    merged.push(...acc.values());

    const providers: ProviderSummary[] = merged.map((row: WeeklySummaryRow) => {
      const providerId = (typeof row.provider_id === "string" ? row.provider_id.trim() : row.provider_id) || "(unknown)";
      const providerName = lookupProviderName(providerId) || row.provider_id || null;
      const totalSalesRaw = Number(row.total_sales || 0);
      const totalAmountDueRaw = Number(row.total_amount_due || 0);
      const totalCashDeltaRaw = Number(row.total_cash_delta || 0);
      const totalCcDeltaRaw = Number(row.total_cc_delta || 0);
      const totalGcRedemptionRaw = Number(row.total_gc_redemption || 0);
      const totalSales = roundCurrency(totalSalesRaw);
      const totalAmountDue = roundCurrency(totalAmountDueRaw);
      const totalCashDelta = roundCurrency(totalCashDeltaRaw);
      const totalCcDelta = roundCurrency(totalCcDeltaRaw);
      const totalGcRedemption = roundCurrency(totalGcRedemptionRaw);
      const tips = roundCurrency(Number(row.total_tips || 0));

      const rawTransactions = Array.isArray(row.transactions)
        ? (row.transactions as RawTransaction[])
        : [];

      const transactions: ProviderTransaction[] = rawTransactions
        .map(tx => {
          const eventId = tx?.eventId ? String(tx.eventId) : "";
          if (!eventId) return null;
          const itemSold = typeof tx?.itemSold === "string" && tx.itemSold.trim() ? tx.itemSold.trim() : null;
          const amountDue = Number(tx?.amountDue ?? 0);
          const cashAmount = Number(tx?.cashAmount ?? 0);
          const ccAmount = Number(tx?.ccAmount ?? 0);
          const gcAmount = Number(tx?.gcRedemption ?? 0);
          const cashDelta = cashAmount - amountDue;
          const ccDelta = ccAmount + gcAmount - Number(tx?.tip ?? 0);
          const newServiceValue = cashDelta + ccDelta;
          const excludedFromAssistantFee = !!(itemSold && excludedServiceSet.has(itemSold.toLowerCase()));
          return {
            eventId,
            timestamp: typeof tx?.timestamp === "string" ? tx.timestamp : null,
            sale: Number(tx?.sale || 0),
            tip: Number(tx?.tip || 0),
            amountDue: Number.isFinite(amountDue) ? amountDue : 0,
            cashAmount: Number.isFinite(cashAmount) ? cashAmount : 0,
            cashDelta: Number.isFinite(cashDelta) ? cashDelta : 0,
            ccAmount: Number.isFinite(ccAmount) ? ccAmount : 0,
            ccDelta: Number.isFinite(ccDelta) ? ccDelta : 0,
            gcRedemption: Number.isFinite(gcAmount) ? gcAmount : 0,
            newServiceValue: Number.isFinite(newServiceValue) ? newServiceValue : 0,
            itemSold,
            excludedFromAssistantFee,
          };
        })
        .filter((tx): tx is ProviderTransaction => tx !== null);

      const formulaComponents = transactions.reduce<ProviderFormulaComponents>(
        (acc, tx) => {
          const addIfFinite = (current: number, value: number) =>
            current + (Number.isFinite(value) ? value : 0);
          acc.cashAmount = addIfFinite(acc.cashAmount, tx.cashAmount);
          acc.amountDue = addIfFinite(acc.amountDue, tx.amountDue);
          acc.cardAmount = addIfFinite(acc.cardAmount, tx.ccAmount);
          acc.giftCard = addIfFinite(acc.giftCard, tx.gcRedemption);
          acc.tip = addIfFinite(acc.tip, tx.tip);
          return acc;
        },
        { cashAmount: 0, amountDue: 0, cardAmount: 0, giftCard: 0, tip: 0 }
      );

      const totalNewServiceRaw =
        (formulaComponents.cashAmount - formulaComponents.amountDue) +
        ((formulaComponents.cardAmount + formulaComponents.giftCard) - formulaComponents.tip);
      const totalNewService = roundCurrency(totalNewServiceRaw);

      let servicePercentage: number | null = null;
      if (row.service_percentage !== null && row.service_percentage !== undefined) {
        const numeric = Number(row.service_percentage);
        if (Number.isFinite(numeric)) {
          servicePercentage = numeric;
        }
      }
      if (servicePercentage === null) {
        const fallback = providerServicePercentages[providerId];
        if (typeof fallback === "number" && Number.isFinite(fallback)) {
          servicePercentage = fallback;
        }
      }

      const tipFeePercentage =
        row.tip_fee_percentage === null || row.tip_fee_percentage === undefined
          ? null
          : Number(row.tip_fee_percentage);

      const specialDeductionConfiguredRaw =
        row.special_deduction === null || row.special_deduction === undefined
          ? null
          : Number(row.special_deduction);
      const specialAdditionRaw =
        row.special_addition === null || row.special_addition === undefined
          ? 0
          : Number(row.special_addition);
      const shouldAutoApplySpecialDeduction =
        servicePercentage !== null &&
        servicePercentage >= 50 &&
        specialDeductionConfiguredRaw === null;

      const specialDeductionRaw = shouldAutoApplySpecialDeduction
        ? AUTO_SPECIAL_DEDUCTION_AMOUNT
        : specialDeductionConfiguredRaw ?? 0;

      const serviceBaseRaw = totalNewServiceRaw;
      const techServiceRaw =
        servicePercentage === null ? 0 : serviceBaseRaw * (servicePercentage / 100);
      const houseServiceRaw = serviceBaseRaw - techServiceRaw;

      const tipFeePct = tipFeePercentage === null ? 0 : tipFeePercentage;
      const tipFeeRaw = tips * (tipFeePct / 100);
      const techTipRaw = tips - tipFeeRaw;

      const assistantRateBase =
        servicePercentage === null ? 0 : servicePercentage >= 50 ? 2 : 1;
      // 45% techs use base $1; 50%+ use $2. Services with "and" count double.
      const techAssistantFeeRaw = transactions.reduce((sum, tx) => {
        if (tx.excludedFromAssistantFee) {
          return sum;
        }
        const serviceValue = Math.max(tx.sale - tx.tip, 0);
        if (serviceValue < 1) {
          return sum;
        }
        const descriptor = typeof tx.itemSold === "string" ? tx.itemSold.toLowerCase() : "";
        const multiplier = descriptor.includes(" and ") ? 2 : 1;
        return sum + assistantRateBase * multiplier;
      }, 0);

      const housePay = roundCurrency(
        houseServiceRaw + tipFeeRaw + techAssistantFeeRaw + specialDeductionRaw - specialAdditionRaw
      );
      const techPay = roundCurrency(
        Math.max(
          techServiceRaw + tips - tipFeeRaw - techAssistantFeeRaw - specialDeductionRaw + specialAdditionRaw,
          0
        )
      );
      const techAssistantFee = roundCurrency(techAssistantFeeRaw);
      const tipFeeAmount = roundCurrency(tipFeeRaw);
      const specialDeduction = roundCurrency(specialDeductionRaw);
      const specialAddition = roundCurrency(specialAdditionRaw);
      const specialDeductionAutoApplied = shouldAutoApplySpecialDeduction;

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
        totalAmountDue,
        totalCashDelta,
        totalCcDelta,
        totalGcRedemption,
        totalNewService,
        tips,
        servicePercentage,
        tipFeePercentage,
        specialDeduction,
        specialAddition,
        specialDeductionAutoApplied,
        housePay,
        techPay,
        tipFeeAmount,
        techAssistantFee,
        commissionComparison,
        transactions,
        formulaComponents,
      };
    });

    providers.sort((a, b) => {
      const nameA = (a.providerName || a.providerId || "").toLowerCase();
      const nameB = (b.providerName || b.providerId || "").toLowerCase();
      if (nameA === nameB) {
        return (a.providerId || "").localeCompare(b.providerId || "");
      }
      return nameA.localeCompare(nameB);
    });

    const totals = providers.reduce(
      (acc, row) => {
        acc.totalSales += row.totalSales;
        acc.totalAmountDue += row.totalAmountDue;
        acc.totalCashDelta += row.totalCashDelta;
        acc.totalCcDelta += row.totalCcDelta;
        acc.totalGcRedemption += row.totalGcRedemption;
        acc.tips += row.tips;
        acc.housePay += row.housePay;
        acc.techPay += row.techPay;
        acc.tipFee += row.tipFeeAmount;
        acc.techAssistantFee += row.techAssistantFee;
        acc.specialDeduction += row.specialDeduction;
        acc.specialAddition += row.specialAddition;
        acc.formulaComponents.cashAmount += row.formulaComponents.cashAmount;
        acc.formulaComponents.amountDue += row.formulaComponents.amountDue;
        acc.formulaComponents.cardAmount += row.formulaComponents.cardAmount;
        acc.formulaComponents.giftCard += row.formulaComponents.giftCard;
        acc.formulaComponents.tip += row.formulaComponents.tip;
        return acc;
      },
      {
        totalSales: 0,
        totalAmountDue: 0,
        totalCashDelta: 0,
        totalCcDelta: 0,
        totalGcRedemption: 0,
        tips: 0,
        housePay: 0,
        techPay: 0,
        tipFee: 0,
        techAssistantFee: 0,
        specialDeduction: 0,
        specialAddition: 0,
        formulaComponents: {
          cashAmount: 0,
          amountDue: 0,
          cardAmount: 0,
          giftCard: 0,
          tip: 0,
        },
      }
    );

    const totalsRounded = {
      totalSales: roundCurrency(totals.totalSales),
      totalAmountDue: roundCurrency(totals.totalAmountDue),
      totalCashDelta: roundCurrency(totals.totalCashDelta),
      totalCcDelta: roundCurrency(totals.totalCcDelta),
      totalGcRedemption: roundCurrency(totals.totalGcRedemption),
      oldServiceTotal: roundCurrency(totals.totalSales),
      newServiceTotal: roundCurrency(
        (totals.formulaComponents.cashAmount - totals.formulaComponents.amountDue) +
          ((totals.formulaComponents.cardAmount + totals.formulaComponents.giftCard) - totals.formulaComponents.tip)
      ),
      tips: roundCurrency(totals.tips),
      housePay: roundCurrency(totals.housePay),
      techPay: roundCurrency(totals.techPay),
      tipFee: roundCurrency(totals.tipFee),
      techAssistantFee: roundCurrency(totals.techAssistantFee),
      specialDeduction: roundCurrency(totals.specialDeduction),
      specialAddition: roundCurrency(totals.specialAddition),
      commissionDiff: roundCurrency(
        providers.reduce((sum, row) => sum + (row.commissionComparison?.deltaAmount || 0), 0)
      ),
      formulaComponents: {
        cashAmount: roundCurrency(totals.formulaComponents.cashAmount),
        amountDue: roundCurrency(totals.formulaComponents.amountDue),
        cardAmount: roundCurrency(totals.formulaComponents.cardAmount),
        giftCard: roundCurrency(totals.formulaComponents.giftCard),
        tip: roundCurrency(totals.formulaComponents.tip),
      },
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
        specialAddition: row.specialAddition,
        specialDeductionAutoApplied: row.specialDeductionAutoApplied,
        totalSales: row.totalSales,
        totalAmountDue: row.totalAmountDue,
        totalCashDelta: row.totalCashDelta,
        totalCcDelta: row.totalCcDelta,
        totalGcRedemption: row.totalGcRedemption,
        oldServiceTotal: row.totalSales,
        newServiceTotal: row.totalNewService,
        tips: row.tips,
        housePay: row.housePay,
        techPay: row.techPay,
        tipFeeAmount: row.tipFeeAmount,
        techAssistantFee: row.techAssistantFee,
        commissionComparison: row.commissionComparison,
        transactions: row.transactions,
        formulaComponents: row.formulaComponents,
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
    const weekStartRaw =
      typeof body.weekStart === "string" ? body.weekStart.trim() : "";
    if (!weekStartRaw) {
      return res.status(400).json({ error: "weekStart is required" });
    }

    const parsedWeekStart = parseDate(weekStartRaw);
    if (!parsedWeekStart) {
      return res.status(400).json({ error: "Invalid weekStart; expected YYYY-MM-DD" });
    }

    const normalizedWeekStart = startOfWeek(parsedWeekStart);

    const hasServiceField =
      Object.prototype.hasOwnProperty.call(body, "servicePercentage") ||
      Object.prototype.hasOwnProperty.call(body, "percentage");
    const hasTipField =
      Object.prototype.hasOwnProperty.call(body, "tipFeePercentage") ||
      Object.prototype.hasOwnProperty.call(body, "tipFee");
    const hasDeductionField = Object.prototype.hasOwnProperty.call(body, "specialDeduction");
    const hasAdditionField = Object.prototype.hasOwnProperty.call(body, "specialAddition");

    if (!hasServiceField && !hasTipField && !hasDeductionField && !hasAdditionField) {
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

    let specialAdditionValue: number | null | undefined = undefined;
    if (hasAdditionField) {
      try {
        specialAdditionValue = parseCurrency(body.specialAddition);
      } catch (parseErr: any) {
        return res
          .status(400)
          .json({ error: parseErr?.message || "Invalid special addition amount" });
      }
    }

    const existing = await prisma.providerWeekConfig.findUnique({
      where: {
        providerId_weekStart: {
          providerId,
          weekStart: normalizedWeekStart,
        },
      },
    });

    const effectiveService =
      hasServiceField ? serviceValue ?? null : existing?.servicePercentage ?? null;
    const effectiveTipFee = hasTipField ? tipFeeValue ?? null : existing?.tipFeePercentage ?? null;
    const effectiveSpecialDeduction = hasDeductionField
      ? specialDeductionValue ?? null
      : existing?.specialDeduction ?? null;
    const effectiveSpecialAddition = hasAdditionField
      ? specialAdditionValue ?? null
      : existing?.specialAddition ?? null;

    if (
      effectiveService === null &&
      effectiveTipFee === null &&
      effectiveSpecialDeduction === null &&
      effectiveSpecialAddition === null
    ) {
      if (existing) {
        await prisma.providerWeekConfig
          .delete({
            where: {
              providerId_weekStart: {
                providerId,
                weekStart: normalizedWeekStart,
              },
            },
          })
          .catch(() => undefined);
      }
      return res.json({
        providerId,
        weekStart: formatDate(normalizedWeekStart),
        servicePercentage: null,
        tipFeePercentage: null,
        specialDeduction: null,
        specialAddition: null,
      });
    }

    const updateData: any = {
      ...(hasServiceField ? { servicePercentage: serviceValue ?? null } : {}),
      ...(hasTipField ? { tipFeePercentage: tipFeeValue ?? null } : {}),
      ...(hasDeductionField ? { specialDeduction: specialDeductionValue ?? null } : {}),
      ...(hasAdditionField ? { specialAddition: specialAdditionValue ?? null } : {}),
    };

    const createData: any = {
      providerId,
      weekStart: normalizedWeekStart,
      servicePercentage: effectiveService,
      tipFeePercentage: effectiveTipFee,
      specialDeduction: effectiveSpecialDeduction,
      specialAddition: effectiveSpecialAddition,
    };

    const record = await prisma.providerWeekConfig.upsert({
      where: {
        providerId_weekStart: {
          providerId,
          weekStart: normalizedWeekStart,
        },
      },
      update: updateData,
      create: createData,
    });

    res.json({
      providerId: record.providerId,
      weekStart: formatDate(normalizedWeekStart),
      servicePercentage: record.servicePercentage,
      tipFeePercentage: record.tipFeePercentage,
      specialDeduction: record.specialDeduction,
      specialAddition: record.specialAddition ?? null,
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
