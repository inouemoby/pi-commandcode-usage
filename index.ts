import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type ExtensionAPI, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

const PROVIDER_ID = "commandcode";
const DISPLAY_NAME = "Command Code";
const DEFAULT_API_BASE = "https://api.commandcode.ai";
const CACHE_MS = 60_000;
const IDLE_REFRESH_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const PLAN_MONTHLY_CREDITS: Record<string, number> = {
  go: 10,
  goat: 70,
  pro: 80,
  "max-10x": 150,
  "max-20x": 300,
  "team-pro": 40,
};

interface CommandCodeUsageData {
  planId: string | null;
  // ── Monthly (Core) ──
  monthlyCredits: number;
  purchasedCredits: number;
  freeCredits: number;
  remainingCredits: number;
  monthlyPercent: number; // calculated if plan credit cap is known or monthlyCredits given
  periodEndMs: number;
  // ── Rolling Windows ──
  fiveHourPercent: number;
  fiveHourResetMs: number;
  weeklyPercent: number;
  weeklyResetMs: number;
  // ── Summary ──
  totalCost: number;
  _ts: number;
}

function humanDuration(untilMs: number): string {
  if (untilMs <= 0) return "now";
  const m = Math.floor(untilMs / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mins = m % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${mins}m`;
  return `${mins}m`;
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1e6) return `${Math.round(count / 1000)}k`;
  if (count < 1e7) return `${(count / 1e6).toFixed(1)}M`;
  return `${Math.round(count / 1e6)}M`;
}

function usageSeverity(pct: number, windowMs: number, resetMs: number): number {
  if (pct < 0 || resetMs <= 0) return 0;
  const remainingMs = resetMs - Date.now();
  const elapsedMs = Math.max(0, windowMs - remainingMs);
  const elapsedRatio = elapsedMs / windowMs;
  const expectedPct = elapsedRatio * 100;

  if (pct > expectedPct * 1.5) return 2;
  if (pct > expectedPct) return 1;
  return 0;
}

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR
    || path.join(process.env.USERPROFILE || process.env.HOME || ".", ".pi", "agent");
}

function readApiKey(): string {
  if (process.env.COMMAND_CODE_API_KEY?.trim()) return process.env.COMMAND_CODE_API_KEY.trim();
  if (process.env.COMMANDCODE_API_KEY?.trim()) return process.env.COMMANDCODE_API_KEY.trim();

  try {
    const credential = readStoredCredential(PROVIDER_ID);
    if (credential?.type === "api_key" && credential.key) return credential.key;
  } catch {
    // Fall back to reading auth.json directly.
  }

  try {
    const authPath = path.join(getAgentDir(), "auth.json");
    if (fs.existsSync(authPath)) {
      const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
      const record = auth[PROVIDER_ID] || auth["command-code"];
      if (typeof record === "string") return record;
      if (record?.type === "api_key" && typeof record.key === "string") return record.key;
      if (record?.type === "api" && typeof record.key === "string") return record.key;
      if (typeof record?.key === "string") return record.key;
    }
  } catch {
    // Auth unreadable.
  }

  try {
    const home = process.env.USERPROFILE || process.env.HOME || ".";
    const ccAuth = path.join(home, ".commandcode", "auth.json");
    if (fs.existsSync(ccAuth)) {
      const data = JSON.parse(fs.readFileSync(ccAuth, "utf8"));
      if (typeof data?.apiKey === "string") return data.apiKey;
    }
  } catch {
    // Ignore.
  }

  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeResetAt(value: unknown): number | null {
  let timestamp: number | undefined;
  if (typeof value === "number" && Number.isFinite(value)) timestamp = value;
  if (typeof value === "string" && value.length > 0) {
    const trimmed = value.trim();
    timestamp = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
  }
  if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp < 0) return null;
  return timestamp < 1e12 ? timestamp * 1000 : timestamp;
}

async function fetchRemoteQuota(apiKey: string): Promise<CommandCodeUsageData> {
  const baseUrl = (process.env.COMMANDCODE_API_BASE || DEFAULT_API_BASE).replace(/\/provider\/v1\/?$/, "");
  const headers = {
    accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...(process.env.CMD_ZDR === "1" ? { "x-cmd-zdr": "1" } : {}),
  };

  const req = async (apiPath: string): Promise<unknown> => {
    const resp = await fetch(`${baseUrl}${apiPath}`, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Command Code HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    return resp.json();
  };

  const whoamiRaw = await req("/alpha/whoami");
  if (!isRecord(whoamiRaw)) throw new Error("Invalid /alpha/whoami response");

  const orgId = isRecord(whoamiRaw.org) && typeof whoamiRaw.org.id === "string" ? whoamiRaw.org.id : undefined;
  const orgParam = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";

  const [creditsRaw, subRaw] = await Promise.all([
    req(`/alpha/billing/credits${orgParam}`).catch(() => null),
    req(`/alpha/billing/subscriptions${orgParam}`).catch(() => null),
  ]);

  let monthlyCredits = 0;
  let purchasedCredits = 0;
  let freeCredits = 0;
  let remainingCredits = 0;

  let fiveHourPercent = -1;
  let fiveHourResetMs = 0;
  let weeklyPercent = -1;
  let weeklyResetMs = 0;

  if (isRecord(creditsRaw)) {
    if (isRecord(creditsRaw.credits)) {
      monthlyCredits = numberValue(creditsRaw.credits.monthlyCredits) ?? 0;
      purchasedCredits = numberValue(creditsRaw.credits.purchasedCredits) ?? 0;
      freeCredits = numberValue(creditsRaw.credits.freeCredits) ?? 0;
      remainingCredits = monthlyCredits + purchasedCredits + freeCredits;
    }
    const wl = creditsRaw.windowLimits;
    if (isRecord(wl)) {
      if (isRecord(wl.fiveHour)) {
        const u = numberValue(wl.fiveHour.used);
        const c = numberValue(wl.fiveHour.cap);
        if (u !== undefined && c !== undefined && c > 0) {
          fiveHourPercent = +(u / c * 100).toFixed(1);
        }
        const r = normalizeResetAt(wl.fiveHour.resetAt);
        if (r) fiveHourResetMs = r;
      }
      if (isRecord(wl.weekly)) {
        const u = numberValue(wl.weekly.used);
        const c = numberValue(wl.weekly.cap);
        if (u !== undefined && c !== undefined && c > 0) {
          weeklyPercent = +(u / c * 100).toFixed(1);
        }
        const r = normalizeResetAt(wl.weekly.resetAt);
        if (r) weeklyResetMs = r;
      }
    }
  }

  let planId: string | null = null;
  let periodEndMs = 0;
  if (isRecord(subRaw) && isRecord(subRaw.data)) {
    if (typeof subRaw.data.planId === "string") planId = subRaw.data.planId.toLowerCase();
    const end = normalizeResetAt(subRaw.data.currentPeriodEnd);
    if (end) periodEndMs = end;
  }

  // Calculate monthly quota percent
  // If plan has a known monthly allowance, used = cap - monthlyCredits
  let monthlyPercent = -1;
  const knownCap = planId ? PLAN_MONTHLY_CREDITS[planId] : undefined;
  if (knownCap && knownCap > 0) {
    const used = Math.max(0, knownCap - monthlyCredits);
    monthlyPercent = +(used / knownCap * 100).toFixed(1);
  }

  let totalCost = 0;
  try {
    const summaryRaw = await req(`/alpha/usage/summary${orgParam}`);
    if (isRecord(summaryRaw) && typeof summaryRaw.totalCost === "number") {
      totalCost = summaryRaw.totalCost;
    }
  } catch {
    // Optional.
  }

  return {
    planId,
    monthlyCredits,
    purchasedCredits,
    freeCredits,
    remainingCredits,
    monthlyPercent,
    periodEndMs,
    fiveHourPercent,
    fiveHourResetMs,
    weeklyPercent,
    weeklyResetMs,
    totalCost,
    _ts: Date.now(),
  };
}

export default function piCommandCodeUsage(pi: ExtensionAPI): void {
  let usage: CommandCodeUsageData | null = null;
  let usagePromise: Promise<CommandCodeUsageData> | null = null;
  let footerOn = false;
  let _tui: any = null;
  let latestCtx: any = null;
  let agentBusy = false;
  let thinkingLevel = "off";
  let idleTimer: ReturnType<typeof setInterval> | null = null;

  function isCommandCode(ctx: any): boolean {
    return ctx?.model?.provider === PROVIDER_ID;
  }

  async function getUsage(force = false): Promise<CommandCodeUsageData> {
    if (!force && usage && Date.now() - usage._ts < CACHE_MS) {
      return usage;
    }
    if (usagePromise) return usagePromise;
    const apiKey = readApiKey();
    if (!apiKey) throw new Error("No Command Code API key found");

    usagePromise = fetchRemoteQuota(apiKey)
      .then((data) => {
        usage = data;
        return data;
      })
      .finally(() => {
        usagePromise = null;
      });
    return usagePromise;
  }

  function trigger() {
    setTimeout(() => {
      try {
        _tui?.requestRender?.();
      } catch {
        /* footer unmounted */
      }
    }, 0);
  }

  async function refresh(ctx: any, force = false): Promise<void> {
    if (!isCommandCode(ctx)) {
      if (usage) {
        usage = null;
        toggleFooter(ctx);
      }
      return;
    }
    try {
      await getUsage(force);
      trigger();
    } catch {
      /* silent */
    }
  }

  function toggleFooter(ctx: any): void {
    if (isCommandCode(ctx) && readApiKey()) {
      if (!footerOn) {
        ctx.ui.setFooter(buildFooter(ctx));
        footerOn = true;
      }
    } else {
      if (footerOn) {
        _tui = null;
        ctx.ui.setFooter(undefined as any);
        footerOn = false;
      }
    }
  }

  function buildFooter(ctx: any) {
    return (tui: any, theme: any, fd: any) => {
      _tui = tui;
      const unsub = fd.onBranchChange(() => tui.requestRender());

      return {
        dispose: () => {
          unsub();
          _tui = null;
          footerOn = false;
        },
        invalidate() {},
        render(width: number): string[] {
          const sm = ctx.sessionManager;

          // ── Line 1: pwd ──────────────────────────────────
          const home = process.env.HOME || process.env.USERPROFILE || "";
          let pwd = ctx.cwd || sm.getCwd?.() || "";
          if (home && pwd.startsWith(home)) pwd = "~" + pwd.slice(home.length);
          const branch = fd.getGitBranch();
          if (branch) pwd += ` (${branch})`;
          const sname = sm.getSessionName?.();
          if (sname) pwd += ` • ${sname}`;
          const ln1 = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));

          // ── Line 2: stats ────────────────────────────────
          let ti = 0, to = 0, tr = 0, tw = 0, tc = 0;
          for (const e of sm.getEntries()) {
            if (e.type === "message" && e.message?.role === "assistant") {
              const u = (e.message as AssistantMessage).usage;
              ti += u.input; to += u.output;
              tr += u.cacheRead; tw += u.cacheWrite;
              tc += u.cost?.total || 0;
            }
          }
          const parts: string[] = [];
          const cachePartIndexes: number[] = [];
          let costPartIndex = -1;
          if (ti) parts.push(`↑${formatTokens(ti)}`);
          if (to) parts.push(`↓${formatTokens(to)}`);
          if (tr) { cachePartIndexes.push(parts.length); parts.push(`R${formatTokens(tr)}`); }
          if (tw) { cachePartIndexes.push(parts.length); parts.push(`W${formatTokens(tw)}`); }
          if (tc) { costPartIndex = parts.length; parts.push(`$${tc.toFixed(3)}`); }

          // Context %
          const cu = ctx.getContextUsage();
          const cw = cu?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const raw = cu?.percent;
          const cp = raw !== null && raw !== undefined ? raw.toFixed(1) : "?";
          let cpStr: string;
          if (cp === "?") cpStr = `?/${formatTokens(cw)} (auto)`;
          else if (parseFloat(cp) > 90) cpStr = theme.fg("error", `${cp}%/${formatTokens(cw)} (auto)`);
          else if (parseFloat(cp) > 70) cpStr = theme.fg("warning", `${cp}%/${formatTokens(cw)} (auto)`);
          else cpStr = `${cp}%/${formatTokens(cw)} (auto)`;
          parts.push(cpStr);

          // ── Command Code Quota segment ──
          // Keep the balance visible. Rolling windows are deliberately compact:
          // `5h:X%Wk:Y%` has no separator between the two window meters.
          // Like Codex, progressively remove less important information when
          // the footer is narrow instead of truncating the important meters.
          let usageFull = "";
          let usageCompact = "";
          let usageBalanceOnly = "";
          let usageIdx = -1;
          if (usage) {
            const balance = `B:$${usage.remainingCredits.toFixed(2)}`;
            const monthly = usage.monthlyPercent >= 0 ? `Mo:${usage.monthlyPercent}%` : "";
            const has5h = usage.fiveHourPercent >= 0;
            const hasWk = usage.weeklyPercent >= 0;
            const rolling: string[] = [];
            if (has5h) {
              const severity = usageSeverity(usage.fiveHourPercent, FIVE_HOUR_MS, usage.fiveHourResetMs);
              const flag = severity === 2 ? "!!" : severity === 1 ? "!" : "";
              rolling.push(`${flag}5h:${usage.fiveHourPercent}%`);
            }
            if (hasWk) {
              const severity = usageSeverity(usage.weeklyPercent, WEEK_MS, usage.weeklyResetMs);
              const flag = severity === 2 ? "!!" : severity === 1 ? "!" : "";
              rolling.push(`${flag}Wk:${usage.weeklyPercent}%`);
            }
            const rollingText = rolling.join("");
            usageBalanceOnly = balance;
            usageCompact = [balance, rollingText].filter(Boolean).join(" ");
            usageFull = [balance, monthly, rollingText].filter(Boolean).join(" ");
            usageIdx = parts.length;
            parts.push(usageFull);
          }

          let left = parts.join(" ");

          // Right side: model info
          const m = ctx.model;
          let right = m?.id || "no-model";
          if (m?.reasoning) {
            const tl = thinkingLevel;
            right = tl === "off" ? `${right} • thinking off` : `${right} • ${tl}`;
          }
          const withProv = `(${PROVIDER_ID}) ${right}`;
          if (visibleWidth(left) + 2 + visibleWidth(withProv) <= width) {
            right = withProv;
          }

          // Match Codex's compacting order: omit provider, cache counters,
          // cost, then less important Command Code quota details.
          if (visibleWidth(left) + 2 + visibleWidth(right) > width) {
            for (const index of cachePartIndexes) parts[index] = "";
            left = parts.filter(Boolean).join(" ");
          }
          if (visibleWidth(left) + 2 + visibleWidth(right) > width && costPartIndex >= 0) {
            parts[costPartIndex] = "";
            left = parts.filter(Boolean).join(" ");
          }
          if (visibleWidth(left) + 2 + visibleWidth(right) > width && usageIdx >= 0) {
            parts[usageIdx] = usageCompact;
            left = parts.filter(Boolean).join(" ");
          }
          if (visibleWidth(left) + 2 + visibleWidth(right) > width && usageIdx >= 0) {
            parts[usageIdx] = usageBalanceOnly;
            left = parts.filter(Boolean).join(" ");
          }

          const lw = visibleWidth(left);
          const rw = visibleWidth(right);

          let ln2: string;
          if (lw + 2 + rw <= width) {
            ln2 = left + " ".repeat(width - lw - rw) + right;
          } else if (lw + 2 < width) {
            ln2 = truncateToWidth(left + "  " + right, width, "");
          } else {
            ln2 = truncateToWidth(left, width, "...");
          }

          return [ln1, theme.fg("dim", ln2)];
        },
      };
    };
  }

  function startIdleTimer() {
    stopIdleTimer();
    idleTimer = setInterval(async () => {
      if (agentBusy) return;
      if (!readApiKey()) return;
      const ctx = latestCtx;
      if (!ctx || !isCommandCode(ctx)) return;
      await refresh(ctx);
    }, IDLE_REFRESH_MS);
    (idleTimer as any).unref?.();
  }

  function stopIdleTimer() {
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = null;
  }

  // ── Events ─────────────────────────────────────────────────
  pi.on("session_start", async (_e, ctx) => {
    latestCtx = ctx;
    thinkingLevel = pi.getThinkingLevel?.() || "off";
    footerOn = false;
    toggleFooter(ctx);
    if (readApiKey()) refresh(ctx);
    startIdleTimer();
  });

  pi.on("session_shutdown", async () => {
    stopIdleTimer();
  });

  pi.on("agent_start", async (_e, ctx) => {
    latestCtx = ctx;
    agentBusy = true;
  });

  pi.on("agent_end", async (_e, ctx) => {
    latestCtx = ctx;
    agentBusy = false;
    if (readApiKey()) refresh(ctx);
  });

  pi.on("model_select", async (_e, ctx) => {
    latestCtx = ctx;
    if (isCommandCode(ctx)) {
      setTimeout(() => {
        toggleFooter(ctx);
        if (readApiKey()) refresh(ctx);
      }, 0);
    } else {
      toggleFooter(ctx);
      if (readApiKey()) refresh(ctx);
    }
  });

  pi.on("thinking_level_select", async (event: any) => {
    thinkingLevel = event?.level || "off";
    trigger();
  });

  // ── /commandcode ───────────────────────────────────────────
  pi.registerCommand("commandcode", {
    description: "Show Command Code usage, monthly credits, and limits",
    handler: async (_args, ctx) => {
      try {
        const d = await getUsage(true);
        const lines: string[] = ["══ Command Code Usage ══"];
        if (d.planId) lines.push(`Plan:        ${d.planId}`);
        lines.push(`Monthly:     $${d.monthlyCredits.toFixed(2)} remaining${d.monthlyPercent >= 0 ? ` (${d.monthlyPercent}% used)` : ""}`);
        if (d.periodEndMs > 0) {
          lines.push(`Resets in:   ${humanDuration(d.periodEndMs - Date.now())}`);
        }
        if (d.purchasedCredits > 0 || d.freeCredits > 0) {
          lines.push(`Extra:       $${(d.purchasedCredits + d.freeCredits).toFixed(2)} (purchased/free)`);
          lines.push(`Total pool:  $${d.remainingCredits.toFixed(2)}`);
        }
        if (d.fiveHourPercent >= 0) {
          lines.push(`5h window:   ${d.fiveHourPercent}% used (resets in ${humanDuration(d.fiveHourResetMs - Date.now())})`);
        }
        if (d.weeklyPercent >= 0) {
          lines.push(`Weekly:      ${d.weeklyPercent}% used (resets in ${humanDuration(d.weeklyResetMs - Date.now())})`);
        }
        if (d.totalCost > 0) {
          lines.push(`Period cost: $${d.totalCost.toFixed(4)}`);
        }
        lines.push(`Refreshed:   ${new Date(d._ts).toLocaleTimeString()}`);
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (err: any) {
        ctx.ui.notify(`Command Code usage error: ${err.message}`, "error");
      }
    },
  });

  // ── Tool ───────────────────────────────────────────────────
  pi.registerTool({
    name: "commandcode_usage",
    label: "Command Code Usage",
    description: "Get current Command Code monthly credits, quota and rolling limit status.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const d = await getUsage(true);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              plan: d.planId,
              monthly: {
                creditsRemaining: d.monthlyCredits,
                percentUsed: d.monthlyPercent >= 0 ? d.monthlyPercent : null,
                resetsIn: d.periodEndMs > 0 ? humanDuration(d.periodEndMs - Date.now()) : null,
              },
              totalRemainingCredits: d.remainingCredits,
              fiveHour: d.fiveHourPercent >= 0 ? {
                percentUsed: d.fiveHourPercent,
                resetsIn: humanDuration(d.fiveHourResetMs - Date.now()),
              } : null,
              weekly: d.weeklyPercent >= 0 ? {
                percentUsed: d.weeklyPercent,
                resetsIn: humanDuration(d.weeklyResetMs - Date.now()),
              } : null,
              periodCost: d.totalCost,
            }, null, 2),
          }],
          details: d,
        };
      } catch (err: any) {
        throw new Error(`Command Code usage check failed: ${err.message}`);
      }
    },
  });
}
