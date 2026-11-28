import { type Transaction, expense, income, shortDate } from "./domain";

export type DailyPoint = {
    date: string;
    label: string;
    fullLabel: string;
    income: number;
    expense: number;
    dow: number;
};

export type WeeklyPoint = {
    label: string;
    fullLabel: string;
    income: number;
    expense: number;
};

export type CalendarDayStat = {
    inc: number;
    exp: number;
    items: Transaction[];
};

export type DonutPartition = {
    positive: { name: string; amount: number }[];
    credits: { name: string; amount: number }[];
    positiveTotal: number;
};

export function aggregateDailyTransactions(
    transactions: Transaction[],
    startIso: string,
    endIso: string
): DailyPoint[] {
    const startMs = new Date(startIso + "T12:00:00").getTime();
    const endMs = new Date(endIso + "T12:00:00").getTime();
    const daysCount = Math.max(1, Math.round((endMs - startMs) / 86400000) + 1);

    const series: DailyPoint[] = Array.from({ length: daysCount }, (_, i) => {
        const d = new Date(startMs + i * 86400000);
        const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        return {
            date: iso,
            label: String(d.getDate()),
            fullLabel: shortDate(iso),
            income: 0,
            expense: 0,
            dow: d.getDay(),
        };
    });
    const idxByDate = new Map(series.map((d, i) => [d.date, i]));
    for (const tx of transactions) {
        const idx = idxByDate.get(tx.date.slice(0, 10));
        if (idx !== undefined) {
            series[idx].income += income(tx);
            series[idx].expense += expense(tx);
        }
    }
    return series;
}

export function aggregateWeeklySeries(dailySeries: DailyPoint[], weekStart: number): WeeklyPoint[] {
    const weeklySeries: WeeklyPoint[] = [];
    let currentWeek: { startDate: string; endDate: string; income: number; expense: number } | null = null;
    for (const d of dailySeries) {
        if (!currentWeek || d.dow === weekStart) {
            if (currentWeek) {
                const lbl = `${shortDate(currentWeek.startDate)} – ${shortDate(currentWeek.endDate)}`;
                weeklySeries.push({ label: lbl, fullLabel: lbl, income: currentWeek.income, expense: currentWeek.expense });
            }
            currentWeek = { startDate: d.date, endDate: d.date, income: d.income, expense: d.expense };
        } else {
            currentWeek.endDate = d.date;
            currentWeek.income += d.income;
            currentWeek.expense += d.expense;
        }
    }
    if (currentWeek) {
        const lbl = `${shortDate(currentWeek.startDate)} – ${shortDate(currentWeek.endDate)}`;
        weeklySeries.push({ label: lbl, fullLabel: lbl, income: currentWeek.income, expense: currentWeek.expense });
    }
    return weeklySeries;
}

export function aggregateCalendarByDate(transactions: Transaction[]): {
    byDate: Map<string, CalendarDayStat>;
    maxDailyExp: number;
} {
    const byDate = new Map<string, CalendarDayStat>();
    for (const t of transactions) {
        const d = t.date.slice(0, 10);
        const cur = byDate.get(d) || { inc: 0, exp: 0, items: [] };
        cur.inc += income(t);
        cur.exp += expense(t);
        cur.items.push(t);
        byDate.set(d, cur);
    }
    let maxDailyExp = 1;
    for (const stat of byDate.values()) {
        if (stat.exp > maxDailyExp) maxDailyExp = stat.exp;
    }
    return { byDate, maxDailyExp };
}

export function partitionDonutItems(items: { name: string; amount: number }[]): DonutPartition {
    const positive: { name: string; amount: number }[] = [];
    const credits: { name: string; amount: number }[] = [];
    let positiveTotal = 0;
    for (const item of items) {
        if (item.amount > 0) {
            positive.push(item);
            positiveTotal += item.amount;
        } else if (item.amount < 0) {
            credits.push(item);
        }
    }
    return { positive, credits, positiveTotal };
}
