import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertVaultAuth } from "@/lib/auth";
import { jsonError } from "@/lib/api";
import { createSupabaseAdmin } from "@/lib/supabase-server";
import { recordSyncRun } from "@/lib/sync-log";

export const runtime = "nodejs";

const requestSchema = z.object({
  observationStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default("2020-01-01"),
  limit: z.coerce.number().int().min(1).max(10000).default(10000),
  dryRun: z.boolean().default(false)
});

const fiscalDataBaseUrl = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/";

const dtsSeries = [
  {
    seriesCode: "TREASURY_TGA_OPEN",
    name: "Treasury General Account Opening Balance",
    unit: "millions of dollars",
    accountType: "Treasury General Account (TGA) Opening Balance"
  },
  {
    seriesCode: "TREASURY_TGA_CLOSE",
    name: "Treasury General Account Closing Balance",
    unit: "millions of dollars",
    accountType: "Treasury General Account (TGA) Closing Balance"
  },
  {
    seriesCode: "TREASURY_TGA_DEPOSITS",
    name: "Treasury General Account Deposits",
    unit: "millions of dollars",
    accountType: "Total TGA Deposits (Table II)"
  },
  {
    seriesCode: "TREASURY_TGA_WITHDRAWALS",
    name: "Treasury General Account Withdrawals",
    unit: "millions of dollars",
    accountType: "Total TGA Withdrawals (Table II) (-)"
  }
] as const;

const debtSeries = [
  {
    seriesCode: "TREASURY_DEBT_TOTAL",
    name: "Total Public Debt Outstanding",
    unit: "dollars",
    field: "tot_pub_debt_out_amt"
  },
  {
    seriesCode: "TREASURY_DEBT_HELD_PUBLIC",
    name: "Debt Held by the Public",
    unit: "dollars",
    field: "debt_held_public_amt"
  },
  {
    seriesCode: "TREASURY_DEBT_INTRAGOV",
    name: "Intragovernmental Holdings",
    unit: "dollars",
    field: "intragov_hold_amt"
  }
] as const;

type FiscalDataRow = Record<string, unknown>;
type NormalizedObservation = { date: string; value: number; metadata: Record<string, unknown> };

type NormalizedSeries = {
  seriesCode: string;
  name: string;
  unit: string;
  dataset: string;
  sourceUrl: string;
  rows: NormalizedObservation[];
  metadata: Record<string, unknown>;
};

function numberValue(value: unknown) {
  if (value === null || value === undefined || value === "" || value === "null") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function fetchFiscalData(endpoint: string, params: Record<string, string>) {
  const url = new URL(endpoint, fiscalDataBaseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Treasury FiscalData request failed for ${endpoint}: HTTP ${response.status}`);
  }

  const payload = await response.json();
  const rows = Array.isArray(payload?.data) ? (payload.data as FiscalDataRow[]) : [];
  return { rows, sourceUrl: url.toString() };
}

function rowsForDtsSeries(rows: FiscalDataRow[], sourceUrl: string) {
  return dtsSeries.map<NormalizedSeries>((series) => ({
    seriesCode: series.seriesCode,
    name: series.name,
    unit: series.unit,
    dataset: "daily_treasury_statement_operating_cash_balance",
    sourceUrl,
    metadata: {
      source: "U.S. Treasury FiscalData",
      dataset: "Daily Treasury Statement Operating Cash Balance",
      accountType: series.accountType,
      sourceUrl
    },
    rows: rows
      .filter((row) => stringValue(row.account_type) === series.accountType)
      .map<NormalizedObservation | null>((row) => {
        const date = stringValue(row.record_date);
        const value = numberValue(row.open_today_bal);
        if (!date || value === null) return null;
        return {
          date,
          value,
          metadata: {
            source: "FiscalData DTS",
            accountType: series.accountType
          }
        };
      })
      .filter((row): row is NormalizedObservation => row !== null)
  }));
}

function rowsForDebtSeries(rows: FiscalDataRow[], sourceUrl: string) {
  return debtSeries.map<NormalizedSeries>((series) => ({
    seriesCode: series.seriesCode,
    name: series.name,
    unit: series.unit,
    dataset: "debt_to_the_penny",
    sourceUrl,
    metadata: {
      source: "U.S. Treasury FiscalData",
      dataset: "Debt to the Penny",
      field: series.field,
      sourceUrl
    },
    rows: rows
      .map<NormalizedObservation | null>((row) => {
        const date = stringValue(row.record_date);
        const value = numberValue(row[series.field]);
        if (!date || value === null) return null;
        return {
          date,
          value,
          metadata: {
            source: "FiscalData Debt to the Penny",
            field: series.field
          }
        };
      })
      .filter((row): row is NormalizedObservation => row !== null)
  }));
}

export async function POST(request: NextRequest) {
  const authError = assertVaultAuth(request);
  if (authError) return authError;

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const supabase = createSupabaseAdmin();

  try {
    const body = request.headers.get("content-length") === "0" ? {} : await request.json().catch(() => ({}));
    const input = requestSchema.parse(body);
    const [dts, debt] = await Promise.all([
      fetchFiscalData("v1/accounting/dts/operating_cash_balance", {
        fields: "record_date,account_type,open_today_bal",
        filter: `record_date:gte:${input.observationStart}`,
        sort: "record_date",
        "page[size]": String(input.limit)
      }),
      fetchFiscalData("v2/accounting/od/debt_to_penny", {
        fields: "record_date,debt_held_public_amt,intragov_hold_amt,tot_pub_debt_out_amt",
        filter: `record_date:gte:${input.observationStart}`,
        sort: "record_date",
        "page[size]": String(input.limit)
      })
    ]);
    const normalizedSeries = [...rowsForDtsSeries(dts.rows, dts.sourceUrl), ...rowsForDebtSeries(debt.rows, debt.sourceUrl)];

    if (input.dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        totalSeries: normalizedSeries.length,
        totalObservations: normalizedSeries.reduce((sum, series) => sum + series.rows.length, 0),
        synced: normalizedSeries.map((series) => ({
          seriesCode: series.seriesCode,
          observations: series.rows.length,
          latest: series.rows.at(-1) ?? null
        })),
        timestamp: new Date().toISOString()
      });
    }

    const synced = [];

    for (const item of normalizedSeries) {
      const { data: series, error: seriesError } = await supabase
        .from("macro_series")
        .upsert(
          {
            provider: "treasury_fiscaldata",
            series_code: item.seriesCode,
            name: item.name,
            country_code: "US",
            unit: item.unit,
            metadata: item.metadata,
            last_synced: new Date().toISOString()
          },
          { onConflict: "provider,series_code,country_code" }
        )
        .select("id, series_code")
        .single();

      if (seriesError) throw seriesError;

      if (item.rows.length > 0) {
        const { error: obsError } = await supabase.from("macro_observations").upsert(
          item.rows.map((row) => ({
            series_id: series.id,
            date: row.date,
            value: row.value,
            metadata: row.metadata
          })),
          { onConflict: "series_id,date" }
        );

        if (obsError) throw obsError;
      }

      synced.push({
        seriesCode: series.series_code,
        observations: item.rows.length
      });
    }

    const totalObservations = synced.reduce((sum, item) => sum + item.observations, 0);

    await recordSyncRun(supabase, {
      connector: "treasury_fiscaldata",
      action: "fiscal_liquidity",
      status: "success",
      startedAt,
      durationMs: Date.now() - startedMs,
      totalSeries: synced.length,
      totalObservations,
      details: {
        observationStart: input.observationStart,
        synced
      }
    });

    return NextResponse.json({
      ok: true,
      totalSeries: synced.length,
      totalObservations,
      synced,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    await recordSyncRun(supabase, {
      connector: "treasury_fiscaldata",
      action: "fiscal_liquidity",
      status: "failed",
      startedAt,
      durationMs: Date.now() - startedMs,
      failedCount: 1,
      error: error instanceof Error ? error.message : "Unknown Treasury FiscalData sync error"
    });

    return jsonError(error);
  }
}
