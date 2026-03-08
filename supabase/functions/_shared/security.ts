// supabase/functions/_shared/security.ts

// ── Platform Kill Switch ───────────────────────────────────────────────────────

const CHANNEL_FLAG_MAP: Record<string, string> = {
  sms: "sms_sending_disabled",
  voice: "voice_sending_disabled",
  whatsapp: "whatsapp_sending_disabled",
  rcs: "rcs_sending_disabled",
  messenger: "messenger_sending_disabled",
  email: "email_sending_disabled",
};

export type PlatformFlagCheck =
  | { ok: true; blocked: boolean; flag: string | null }
  | { ok: false; error: string };

/**
 * Checks platform_control_flags for global_execution_pause and (optionally)
 * the channel-specific flag. Fail-closed: if the query errors, treat as blocked.
 */
export async function checkPlatformControlFlags(
  supabase: any,
  channel?: string,
): Promise<PlatformFlagCheck> {
  const flagsToCheck = ["global_execution_pause"];
  if (channel && CHANNEL_FLAG_MAP[channel]) {
    flagsToCheck.push(CHANNEL_FLAG_MAP[channel]);
  }

  const { data, error } = await supabase
    .from("platform_control_flags")
    .select("flag, enabled")
    .in("flag", flagsToCheck);

  if (error) return { ok: false, error: error.message };

  const enabledFlag = (data ?? []).find((r: any) => r.enabled === true);
  return { ok: true, blocked: !!enabledFlag, flag: enabledFlag?.flag ?? null };
}

/**
 * EXECUTOR gate for platform kill switch.
 * Call this BEFORE the org-level kill switch.
 */
export async function enforcePlatformKillSwitchForTaskExecutor(
  supabase: any,
  task_id: string | null,
  channel?: string,
): Promise<{ allow: true } | { allow: false; response: Response }> {
  const check = await checkPlatformControlFlags(supabase, channel);

  if (!check.ok) {
    const reason = `PLATFORM_FLAG_CHECK_FAILED: ${check.error}`;
    if (task_id) {
      await markTaskSecurityTerminal(supabase, { task_id, status: "failed_security_policy", reason });
    }
    return { allow: false, response: new Response(reason, { status: 500 }) };
  }

  if (check.blocked) {
    const reason = `PLATFORM_FLAG_BLOCKED: ${check.flag}`;
    if (task_id) {
      await markTaskSecurityTerminal(supabase, { task_id, status: "blocked", reason });
    }
    return { allow: false, response: new Response("BLOCKED_PLATFORM_FLAG", { status: 200 }) };
  }

  return { allow: true };
}

/**
 * DISPATCHER gate for platform kill switch.
 * Call this BEFORE invoking the executor for each task.
 */
export async function enforcePlatformKillSwitchForDispatcher(
  supabase: any,
  task_id: string,
  channel?: string,
): Promise<
  | { action: "allow" }
  | { action: "blocked"; reason: string }
  | { action: "failed_security_policy"; reason: string }
> {
  const check = await checkPlatformControlFlags(supabase, channel);

  if (!check.ok) {
    const reason = `PLATFORM_FLAG_CHECK_FAILED: ${check.error}`;
    await markTaskSecurityTerminal(supabase, { task_id, status: "failed_security_policy", reason });
    return { action: "failed_security_policy", reason };
  }

  if (check.blocked) {
    const reason = `PLATFORM_FLAG_BLOCKED: ${check.flag}`;
    await markTaskSecurityTerminal(supabase, { task_id, status: "blocked", reason });
    return { action: "blocked", reason };
  }

  return { action: "allow" };
}

/**
 * CAMPAIGN gate for platform kill switch.
 * Call this BEFORE the org-level kill switch in campaign_ticker.
 */
export async function enforcePlatformKillSwitchForCampaign(
  supabase: any,
  channel?: string,
): Promise<{ allow: true } | { allow: false; blocked: boolean; reason: string }> {
  const check = await checkPlatformControlFlags(supabase, channel);

  if (!check.ok) {
    return { allow: false, blocked: false, reason: `PLATFORM_FLAG_CHECK_FAILED: ${check.error}` };
  }

  if (check.blocked) {
    return { allow: false, blocked: true, reason: `PLATFORM_FLAG_BLOCKED: ${check.flag}` };
  }

  return { allow: true };
}

// ── Global Rate Limiter ────────────────────────────────────────────────────────

/**
 * Per-channel default limits (per-org per-minute, platform per-minute).
 * These are enforced atomically by check_and_increment_rate_limit_v1.
 * Voice is low because VAPI calls consume significant resources.
 */
export const RATE_LIMIT_DEFAULTS: Record<string, { org: number; platform: number }> = {
  sms:       { org: 30,  platform: 1000 },
  email:     { org: 30,  platform: 500  },
  voice:     { org: 5,   platform: 50   },
  whatsapp:  { org: 30,  platform: 500  },
  rcs:       { org: 30,  platform: 500  },
  messenger: { org: 30,  platform: 500  },
};

/**
 * EXECUTOR gate for global rate limiter.
 * Call AFTER all kill-switch / cancellation gates, BEFORE token consumption and provider send.
 *
 * Fail-OPEN on RPC error: a rate-limit check failure should not halt legitimate traffic.
 * Fail-CLOSED on limit exceeded: reschedules the task 60s out and returns HTTP 429.
 * Token consumption NEVER happens when this returns allow=false.
 */
export async function enforceRateLimitForTaskExecutor(
  supabase: any,
  task_id: string,
  org_id: string,
  channel: string,
): Promise<{ allow: true } | { allow: false; response: Response }> {
  const limits = RATE_LIMIT_DEFAULTS[channel] ?? { org: 30, platform: 500 };

  const { data, error } = await supabase.rpc("check_and_increment_rate_limit_v1", {
    p_org_id:         org_id,
    p_channel:        channel,
    p_org_limit:      limits.org,
    p_platform_limit: limits.platform,
  });

  if (error) {
    // Fail-open: log prominently but allow traffic through
    console.error(`[rate_limit] RPC check_and_increment_rate_limit_v1 failed — org=${org_id} channel=${channel}: ${error.message}`);
    return { allow: true };
  }

  const result = data as {
    allowed: boolean;
    blocked_by: string | null;
    org_count: number;
    platform_count: number;
    org_limit: number;
    platform_limit: number;
  } | null;

  if (!result?.allowed) {
    const scope = result?.blocked_by ?? "unknown";
    const reason = `RATE_LIMIT_EXCEEDED: ${scope} (org=${result?.org_count}/${result?.org_limit} platform=${result?.platform_count}/${result?.platform_limit} channel=${channel})`;

    // Reschedule — NOT terminal. Release lease, delay 60s so window resets.
    await supabase
      .from("execution_tasks")
      .update({
        status: "pending",
        scheduled_for: new Date(Date.now() + 60_000).toISOString(),
        last_error: reason,
        locked_by: null,
        locked_until: null,
      })
      .eq("id", task_id)
      .in("status", ["pending", "running"]);

    // Audit (best-effort — do not fail-close on audit insert failure)
    await supabase.from("audit_events").insert({
      org_id,
      actor_type: "system",
      actor_id: null,
      object_type: "execution_task",
      object_id: task_id,
      action: scope === "org" ? "rate_limit_blocked_org" : "rate_limit_blocked_platform",
      reason,
      before_state: { channel, org_limit: result?.org_limit, platform_limit: result?.platform_limit },
      after_state: { org_count: result?.org_count, platform_count: result?.platform_count, scope },
    }).catch(() => {});

    return { allow: false, response: new Response("RATE_LIMIT_EXCEEDED", { status: 429 }) };
  }

  return { allow: true };
}

// ── Org-level Kill Switch ──────────────────────────────────────────────────────

export type KillSwitchCheck =
  | { ok: true; enabled: boolean }
  | { ok: false; error: string };

export async function checkKillSwitchOrg(
  supabase: any,
  org_id: string
): Promise<KillSwitchCheck> {
  const { data, error } = await supabase.rpc("is_kill_switch_enabled_v1", { p_org_id: org_id });
  if (error) return { ok: false, error: error.message };
  return { ok: true, enabled: Boolean(data) };
}

/**
 * Race-safe terminal update for security outcomes.
 * Only updates tasks that are pending/running and always clears locks.
 */
export async function markTaskSecurityTerminal(
  supabase: any,
  args: {
    task_id: string;
    status: "blocked" | "failed_security_policy";
    reason: string;
    executed_at?: string;
  }
): Promise<{ ok: boolean; error?: string }> {
  const executed_at = args.executed_at ?? new Date().toISOString();

  const { error } = await supabase
    .from("execution_tasks")
    .update({
      status: args.status,
      last_error: args.reason,
      executed_at,
      locked_by: null,
      locked_until: null,
    })
    .eq("id", args.task_id)
    .in("status", ["pending", "running"]);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * EXECUTOR semantic gate:
 * - check fail -> (if task_id provided) failed_security_policy + HTTP 500
 * - enabled    -> (if task_id provided) blocked + HTTP 200 "BLOCKED_KILL_SWITCH"
 *
 * If task_id is null (e.g., voice_turn), we do NOT attempt task updates.
 */
export async function enforceKillSwitchForTaskExecutor(
  supabase: any,
  org_id: string,
  task_id: string | null
): Promise<{ allow: true } | { allow: false; response: Response }> {
  const ks = await checkKillSwitchOrg(supabase, org_id);

  if (!ks.ok) {
    const reason = `KILL_SWITCH_CHECK_FAILED: ${ks.error}`;

    if (task_id) {
      const upd = await markTaskSecurityTerminal(supabase, {
        task_id,
        status: "failed_security_policy",
        reason,
      });

      return {
        allow: false,
        response: new Response(
          upd.ok ? reason : `FAILED_SECURITY_UPDATE_FAILED: ${upd.error}`,
          { status: 500 }
        ),
      };
    }

    // No task_id: fail-closed but do not try DB task update
    return {
      allow: false,
      response: new Response(reason, { status: 500 }),
    };
  }

  if (ks.enabled) {
    if (task_id) {
      const upd = await markTaskSecurityTerminal(supabase, {
        task_id,
        status: "blocked",
        reason: "KILL_SWITCH_ENABLED",
      });

      return {
        allow: false,
        response: new Response(
          upd.ok ? "BLOCKED_KILL_SWITCH" : `BLOCKED_UPDATE_FAILED: ${upd.error}`,
          { status: upd.ok ? 200 : 500 }
        ),
      };
    }

    // No task_id: block politely (transport surface)
    return {
      allow: false,
      response: new Response("BLOCKED_KILL_SWITCH", { status: 200 }),
    };
  }

  return { allow: true };
}

/**
 * DISPATCHER semantic gate:
 * - check fail -> failed_security_policy (terminal) and skip invoking executor
 * - enabled    -> blocked (terminal) and skip invoking executor
 */
export async function enforceKillSwitchForDispatcherTask(
  supabase: any,
  org_id: string,
  task_id: string
): Promise<
  | { action: "allow" }
  | { action: "blocked"; reason: string; update_error?: string }
  | { action: "failed_security_policy"; reason: string; update_error?: string }
> {
  const ks = await checkKillSwitchOrg(supabase, org_id);

  if (!ks.ok) {
    const reason = `KILL_SWITCH_CHECK_FAILED: ${ks.error}`;
    const upd = await markTaskSecurityTerminal(supabase, {
      task_id,
      status: "failed_security_policy",
      reason,
    });
    return {
      action: "failed_security_policy",
      reason,
      update_error: upd.ok ? undefined : upd.error,
    };
  }

  if (ks.enabled) {
    const upd = await markTaskSecurityTerminal(supabase, {
      task_id,
      status: "blocked",
      reason: "KILL_SWITCH_ENABLED",
    });
    return {
      action: "blocked",
      reason: "KILL_SWITCH_ENABLED",
      update_error: upd.ok ? undefined : upd.error,
    };
  }

  return { action: "allow" };
}

// ── Cancellation gate ─────────────────────────────────────────────────────────

export async function checkOrgCancellation(
  supabase: any,
  org_id: string,
): Promise<{ ok: true; cancelled: boolean } | { ok: false; error: string }> {
  const { data, error } = await supabase.rpc("is_org_cancelled_v1", { p_org_id: org_id });
  if (error) return { ok: false, error: error.message };
  return { ok: true, cancelled: Boolean(data) };
}

/**
 * EXECUTOR semantic gate for cancellation.
 * Same shape as enforceKillSwitchForTaskExecutor — call it right after kill-switch.
 */
export async function enforceOrgCancellationForTaskExecutor(
  supabase: any,
  org_id: string,
  task_id: string | null,
): Promise<{ allow: true } | { allow: false; response: Response }> {
  const check = await checkOrgCancellation(supabase, org_id);

  if (!check.ok) {
    const reason = `CANCELLATION_CHECK_FAILED: ${check.error}`;
    if (task_id) {
      await markTaskSecurityTerminal(supabase, { task_id, status: "failed_security_policy", reason });
    }
    return { allow: false, response: new Response(reason, { status: 500 }) };
  }

  if (check.cancelled) {
    if (task_id) {
      await markTaskSecurityTerminal(supabase, { task_id, status: "blocked", reason: "ORG_CANCELLED" });
    }
    return { allow: false, response: new Response("BLOCKED_ORG_CANCELLED", { status: 200 }) };
  }

  return { allow: true };
}

/**
 * DISPATCHER semantic gate for cancellation.
 */
export async function enforceOrgCancellationForDispatcher(
  supabase: any,
  org_id: string,
  task_id: string,
): Promise<
  | { action: "allow" }
  | { action: "blocked"; reason: string }
  | { action: "failed_security_policy"; reason: string }
> {
  const check = await checkOrgCancellation(supabase, org_id);

  if (!check.ok) {
    const reason = `CANCELLATION_CHECK_FAILED: ${check.error}`;
    await markTaskSecurityTerminal(supabase, { task_id, status: "failed_security_policy", reason });
    return { action: "failed_security_policy", reason };
  }

  if (check.cancelled) {
    await markTaskSecurityTerminal(supabase, { task_id, status: "blocked", reason: "ORG_CANCELLED" });
    return { action: "blocked", reason: "ORG_CANCELLED" };
  }

  return { action: "allow" };
}

/**
 * CAMPAIGN semantic gate for cancellation.
 * - check fail -> fail-closed (pause campaign)
 * - cancelled  -> pause campaign
 */
export async function enforceOrgCancellationForCampaign(
  supabase: any,
  org_id: string,
): Promise<{ allow: true } | { allow: false; cancelled: boolean; reason: string }> {
  const check = await checkOrgCancellation(supabase, org_id);

  if (!check.ok) {
    return { allow: false, cancelled: false, reason: `CANCELLATION_CHECK_FAILED: ${check.error}` };
  }

  if (check.cancelled) {
    return { allow: false, cancelled: true, reason: "ORG_CANCELLED" };
  }

  return { allow: true };
}

/**
 * CAMPAIGN semantic gate:
 * - check fail -> fail-closed; caller should pause to avoid thrash
 * - enabled    -> fail-closed (enabled)
 */
export async function enforceKillSwitchForCampaign(
  supabase: any,
  org_id: string
): Promise<{ allow: true } | { allow: false; enabled: boolean; reason: string }> {
  const ks = await checkKillSwitchOrg(supabase, org_id);

  if (!ks.ok) {
    return {
      allow: false,
      enabled: false,
      reason: `KILL_SWITCH_CHECK_FAILED: ${ks.error}`,
    };
  }

  if (ks.enabled) {
    return {
      allow: false,
      enabled: true,
      reason: "KILL_SWITCH_ENABLED",
    };
  }

  return { allow: true };
}
