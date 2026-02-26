// supabase/functions/_shared/security.ts

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
