BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.ussd_agents (
  id BIGSERIAL PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  msisdn TEXT NOT NULL UNIQUE,
  pin_hash TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT ussd_agents_agent_id_key UNIQUE (agent_id),
  CONSTRAINT ussd_agents_msisdn_format_chk CHECK (msisdn ~ '^\+233[2356789][0-9]{8}$')
);

CREATE INDEX IF NOT EXISTS idx_ussd_agents_agent_id ON public.ussd_agents(agent_id);
CREATE INDEX IF NOT EXISTS idx_ussd_agents_is_active ON public.ussd_agents(is_active);

ALTER TABLE public.ussd_agents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role can manage ussd agents" ON public.ussd_agents;
CREATE POLICY "Service role can manage ussd agents" ON public.ussd_agents
FOR ALL USING (auth.role() = 'service_role')
WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Agents can view their own ussd profile" ON public.ussd_agents;
CREATE POLICY "Agents can view their own ussd profile" ON public.ussd_agents
FOR SELECT USING (auth.uid() = agent_id);

CREATE OR REPLACE FUNCTION public.update_ussd_agents_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS update_ussd_agents_updated_at ON public.ussd_agents;
CREATE TRIGGER update_ussd_agents_updated_at
BEFORE UPDATE ON public.ussd_agents
FOR EACH ROW
EXECUTE FUNCTION public.update_ussd_agents_updated_at();

CREATE OR REPLACE FUNCTION public.normalize_ghana_msisdn(p_phone TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_digits TEXT;
BEGIN
  v_digits := regexp_replace(COALESCE(p_phone, ''), '[^0-9]', '', 'g');

  IF v_digits = '' THEN
    RETURN NULL;
  END IF;

  IF left(v_digits, 3) = '233' AND length(v_digits) = 12 THEN
    RETURN '+' || v_digits;
  END IF;

  IF left(v_digits, 1) = '0' AND length(v_digits) = 10 THEN
    RETURN '+233' || substring(v_digits FROM 2);
  END IF;

  IF length(v_digits) = 9 THEN
    RETURN '+233' || v_digits;
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.upsert_ussd_agent(
  p_agent_id UUID,
  p_msisdn TEXT,
  p_pin TEXT,
  p_is_active BOOLEAN DEFAULT true
)
RETURNS public.ussd_agents
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_msisdn TEXT;
  v_record public.ussd_agents;
BEGIN
  IF p_agent_id IS NULL THEN
    RAISE EXCEPTION 'AGENT_ID_REQUIRED';
  END IF;

  IF COALESCE(p_pin, '') !~ '^\d{4}$' THEN
    RAISE EXCEPTION 'PIN_MUST_BE_4_DIGITS';
  END IF;

  v_msisdn := public.normalize_ghana_msisdn(p_msisdn);
  IF v_msisdn IS NULL OR v_msisdn !~ '^\+233[2356789][0-9]{8}$' THEN
    RAISE EXCEPTION 'INVALID_MSISDN';
  END IF;

  INSERT INTO public.ussd_agents (agent_id, msisdn, pin_hash, is_active)
  VALUES (
    p_agent_id,
    v_msisdn,
    crypt(p_pin, gen_salt('bf', 12)),
    COALESCE(p_is_active, true)
  )
  ON CONFLICT (agent_id)
  DO UPDATE SET
    msisdn = EXCLUDED.msisdn,
    pin_hash = EXCLUDED.pin_hash,
    is_active = EXCLUDED.is_active,
    updated_at = NOW()
  RETURNING * INTO v_record;

  RETURN v_record;
END;
$$;

CREATE OR REPLACE FUNCTION public.ussd_get_wallet_balance(
  p_msisdn TEXT,
  p_pin TEXT
)
RETURNS NUMERIC(10,2)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_msisdn TEXT;
  v_agent_id UUID;
  v_pin_hash TEXT;
  v_balance NUMERIC(10,2);
BEGIN
  v_msisdn := public.normalize_ghana_msisdn(p_msisdn);
  IF v_msisdn IS NULL THEN
    RAISE EXCEPTION 'INVALID_MSISDN';
  END IF;

  IF COALESCE(p_pin, '') !~ '^\d{4}$' THEN
    RAISE EXCEPTION 'INVALID_PIN_FORMAT';
  END IF;

  SELECT ua.agent_id, ua.pin_hash
  INTO v_agent_id, v_pin_hash
  FROM public.ussd_agents ua
  WHERE ua.msisdn = v_msisdn
    AND ua.is_active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'AGENT_NOT_FOUND';
  END IF;

  IF crypt(p_pin, v_pin_hash) <> v_pin_hash THEN
    RAISE EXCEPTION 'INVALID_PIN';
  END IF;

  SELECT aw.balance
  INTO v_balance
  FROM public.agent_wallet aw
  WHERE aw.agent_id = v_agent_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND';
  END IF;

  RETURN COALESCE(v_balance, 0)::NUMERIC(10,2);
END;
$$;

CREATE OR REPLACE FUNCTION public.ussd_create_agent_order(
  p_msisdn TEXT,
  p_pin TEXT,
  p_offer_id INTEGER,
  p_offer_title TEXT,
  p_network TEXT,
  p_data_amount TEXT,
  p_amount NUMERIC,
  p_recipient_phone TEXT DEFAULT NULL,
  p_recipient_name TEXT DEFAULT 'USSD Customer'
)
RETURNS TABLE(order_id INTEGER, reference TEXT, new_balance NUMERIC(10,2))
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_msisdn TEXT;
  v_recipient_phone TEXT;
  v_agent_id UUID;
  v_pin_hash TEXT;
  v_current_balance NUMERIC(10,2);
  v_new_balance NUMERIC(10,2);
BEGIN
  v_msisdn := public.normalize_ghana_msisdn(p_msisdn);
  IF v_msisdn IS NULL THEN
    RAISE EXCEPTION 'INVALID_MSISDN';
  END IF;

  IF COALESCE(p_pin, '') !~ '^\d{4}$' THEN
    RAISE EXCEPTION 'INVALID_PIN_FORMAT';
  END IF;

  IF p_offer_id IS NULL THEN
    RAISE EXCEPTION 'OFFER_REQUIRED';
  END IF;

  IF COALESCE(NULLIF(trim(p_offer_title), ''), '') = '' THEN
    RAISE EXCEPTION 'OFFER_TITLE_REQUIRED';
  END IF;

  IF COALESCE(NULLIF(trim(p_network), ''), '') = '' THEN
    RAISE EXCEPTION 'NETWORK_REQUIRED';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

  SELECT ua.agent_id, ua.pin_hash
  INTO v_agent_id, v_pin_hash
  FROM public.ussd_agents ua
  WHERE ua.msisdn = v_msisdn
    AND ua.is_active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'AGENT_NOT_FOUND';
  END IF;

  IF crypt(p_pin, v_pin_hash) <> v_pin_hash THEN
    RAISE EXCEPTION 'INVALID_PIN';
  END IF;

  SELECT aw.balance
  INTO v_current_balance
  FROM public.agent_wallet aw
  WHERE aw.agent_id = v_agent_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_NOT_FOUND';
  END IF;

  IF COALESCE(v_current_balance, 0) < p_amount THEN
    RAISE EXCEPTION 'INSUFFICIENT_BALANCE';
  END IF;

  v_new_balance := ROUND((COALESCE(v_current_balance, 0) - p_amount)::NUMERIC, 2);

  UPDATE public.agent_wallet
  SET balance = v_new_balance
  WHERE agent_id = v_agent_id;

  v_recipient_phone := COALESCE(public.normalize_ghana_msisdn(p_recipient_phone), v_msisdn);

  INSERT INTO public.agent_orders (
    agent_id,
    offer_id,
    offer_title,
    network,
    channel,
    device_token,
    recipient_name,
    recipient_phone,
    amount,
    data_amount,
    status,
    transaction_status
  ) VALUES (
    v_agent_id,
    p_offer_id,
    p_offer_title,
    p_network,
    'USSD',
    v_recipient_phone,
    COALESCE(NULLIF(trim(p_recipient_name), ''), 'USSD Customer'),
    v_recipient_phone,
    ROUND(p_amount::NUMERIC, 2),
    COALESCE(NULLIF(trim(p_data_amount), ''), p_offer_title),
    'pending',
    'pending'
  )
  RETURNING id INTO order_id;

  reference := 'AGENT-' || order_id;
  new_balance := v_new_balance;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_ussd_agent(UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ussd_get_wallet_balance(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ussd_create_agent_order(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.upsert_ussd_agent(UUID, TEXT, TEXT, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION public.ussd_get_wallet_balance(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.ussd_create_agent_order(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT) TO service_role;

COMMIT;
