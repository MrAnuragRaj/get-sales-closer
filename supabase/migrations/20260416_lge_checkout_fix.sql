-- Fix: add lead_gen ($299/mo) to create_checkout_intent (3-param billing/pricing version)
-- Root cause: has_lge was never declared or priced, so toggling only LGE produced
-- final_invoice_amount = 0 → "Invalid Total Price" exception → "Failed to generate invoice"

CREATE OR REPLACE FUNCTION public.create_checkout_intent(payload jsonb, intent_source text, billing_cycle text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id uuid;
  v_org_id uuid;

  -- Service flags
  is_s boolean; is_b boolean; is_a boolean; is_l boolean;

  -- Addon flags
  has_intake boolean; has_safe_voice boolean; has_priority boolean;
  has_chatbot boolean; has_install boolean; has_ge boolean; has_lge boolean;

  -- Channel flags
  ch_sms boolean; ch_wa boolean; ch_fb boolean;
  channel_count int := 0;

  -- Social flags
  sce_on boolean; sce_plan text;
  eb_on boolean; eb_plan text;

  -- Pricing variables
  monthly_base numeric(10,2) := 0;
  monthly_channel_cost numeric(10,2) := 0;
  monthly_addon_cost numeric(10,2) := 0;
  install_cost numeric(10,2) := 0;
  recurring_total numeric(10,2) := 0;
  annual_before_discount numeric(10,2) := 0;
  final_invoice_amount numeric(10,2) := 0;

  -- Outputs
  new_intent_id uuid;
  new_ref_id text;
  full_snapshot jsonb;
begin
  -- A. VALIDATION
  if intent_source not in ('pricing', 'billing') then
    raise exception 'Invalid intent source. Must be pricing or billing.';
  end if;
  if billing_cycle not in ('monthly', 'yearly') then
    raise exception 'Invalid billing cycle';
  end if;

  -- B. AUTH
  v_user_id := auth.uid();
  if v_user_id is null then raise exception 'Not authenticated'; end if;

  -- C. RESOLVE ORG
  select org_id into v_org_id from members where user_id = v_user_id limit 1 for update;
  if v_org_id is null then
    select om.org_id into v_org_id from org_members om where om.user_id = v_user_id limit 1;
  end if;
  if v_org_id is null then
    insert into organizations (name) values ('Personal Workspace') returning id into v_org_id;
    insert into members (user_id, org_id, role) values (v_user_id, v_org_id, 'owner');
  end if;

  -- D. PARSE SERVICES
  is_s := coalesce((payload->'services'->>'sentinel')::boolean, false);
  is_b := coalesce((payload->'services'->>'brain')::boolean, false);
  is_a := coalesce((payload->'services'->>'architect')::boolean, false);
  is_l := coalesce((payload->'services'->>'voice')::boolean, false);

  -- E. PARSE ADDONS
  has_intake     := coalesce((payload->'addons'->>'intake')::boolean, false);
  has_safe_voice := coalesce((payload->'addons'->>'safe_voice')::boolean, false);
  has_priority   := coalesce((payload->'addons'->>'priority')::boolean, false);
  has_chatbot    := coalesce((payload->'addons'->>'chatbot')::boolean, false);
  has_install    := coalesce((payload->'addons'->>'installation')::boolean, false);
  has_ge         := coalesce((payload->'addons'->>'growth_engine')::boolean, false);
  has_lge        := coalesce((payload->'addons'->>'lead_gen')::boolean, false);
  sce_on         := coalesce((payload->'addons'->>'sce')::boolean, false);
  sce_plan       := coalesce(payload->'addons'->>'sce_plan', '');
  eb_on          := coalesce((payload->'addons'->>'eb')::boolean, false);
  eb_plan        := coalesce(payload->'addons'->>'eb_plan', '');

  -- F. PARSE CHANNELS
  ch_sms := coalesce((payload->'channels'->>'sms')::boolean, false);
  ch_wa  := coalesce((payload->'channels'->>'whatsapp')::boolean, false);
  ch_fb  := coalesce((payload->'channels'->>'fb')::boolean, false);
  if ch_sms then channel_count := channel_count + 1; end if;
  if ch_wa  then channel_count := channel_count + 1; end if;
  if ch_fb  then channel_count := channel_count + 1; end if;

  -- G. BASE PRICING
  if is_l then
    if is_s and is_b and is_a then monthly_base := 349.00;
    elsif is_s and is_b       then monthly_base := 299.00;
    elsif is_s and is_a       then monthly_base := 249.00;
    elsif is_b and is_a       then monthly_base := 299.00;
    elsif is_s                then monthly_base := 199.00;
    elsif is_b                then monthly_base := 249.00;
    elsif is_a                then monthly_base := 199.00;
    else                           monthly_base := 149.00; end if;
  elsif is_s then
    if is_b and is_a then
      monthly_base := 249.00;
    elsif is_b then
      monthly_base := 199.00;
    elsif is_a then
      monthly_base := 149.00;
    else
      monthly_base := 49.00 + greatest(0, (channel_count - 1) * 10);
    end if;
  end if;

  -- H. CHANNEL COST (baked into base for S-alone; 0 for all other combos)
  monthly_channel_cost := 0;

  -- I. ADDON COSTS
  if has_intake     then monthly_addon_cost := monthly_addon_cost + 149.00; end if;
  if has_safe_voice then monthly_addon_cost := monthly_addon_cost + 199.00; end if;
  if has_priority   then monthly_addon_cost := monthly_addon_cost + 99.00;  end if;
  if has_chatbot    then monthly_addon_cost := monthly_addon_cost + 149.00; end if;
  if has_ge         then monthly_addon_cost := monthly_addon_cost + 660.00; end if;
  if has_lge        then monthly_addon_cost := monthly_addon_cost + 299.00; end if;

  -- SCE plan pricing
  if sce_on then
    case sce_plan
      when '199' then monthly_addon_cost := monthly_addon_cost + 199.00;
      when '299' then monthly_addon_cost := monthly_addon_cost + 299.00;
      when '399' then monthly_addon_cost := monthly_addon_cost + 399.00;
      else null;
    end case;
  end if;

  -- EB plan pricing
  if eb_on then
    case eb_plan
      when '99'  then monthly_addon_cost := monthly_addon_cost + 99.00;
      when '199' then monthly_addon_cost := monthly_addon_cost + 199.00;
      else null;
    end case;
  end if;

  -- J. ONE-TIME INSTALL
  if has_install then install_cost := 99.00; end if;

  -- K. TOTALS
  recurring_total := monthly_base + monthly_channel_cost + monthly_addon_cost;
  annual_before_discount := recurring_total * 12;

  if billing_cycle = 'yearly' then
    final_invoice_amount := round((recurring_total * 12 * 0.88), 2) + install_cost;
  else
    final_invoice_amount := recurring_total + install_cost;
  end if;

  if final_invoice_amount <= 0 then
    raise exception 'Invalid Total Price: select at least one service';
  end if;

  -- L. BUILD SNAPSHOT
  full_snapshot := jsonb_build_object(
    'version', 4,
    'billing_cycle', billing_cycle,
    'applied_discount_pct', (case when billing_cycle = 'yearly' then 12 else 0 end),
    'inputs', payload,
    'breakdown', jsonb_build_object(
      'monthly_base', monthly_base,
      'monthly_channels', monthly_channel_cost,
      'monthly_addons', monthly_addon_cost,
      'recurring_monthly_subtotal', recurring_total,
      'one_time_install', install_cost,
      'annual_total_undiscounted', annual_before_discount
    ),
    'final_invoice_amount', final_invoice_amount
  );

  new_ref_id := 'GSC-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS');

  insert into billing_intents (
    org_id, reference_id, pricing_snapshot, status, expires_at, source, billing_cycle,
    services, addons, channels
  ) values (
    v_org_id, new_ref_id, full_snapshot, 'created',
    now() + interval '30 minutes',
    intent_source, billing_cycle,
    payload->'services', payload->'addons', payload->'channels'
  ) returning id into new_intent_id;

  return jsonb_build_object('intent_id', new_intent_id, 'reference_id', new_ref_id);
end;
$function$;
