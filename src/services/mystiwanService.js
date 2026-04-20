import { createClient } from "@supabase/supabase-js";

const PROVIDERS = {
  "1": { displayName: "MTN", networkKey: "mtn" },
  "2": { displayName: "Telecel", networkKey: "telecel" },
  "3": { displayName: "AirtelTigo", networkKey: "airteltigo" }
};

const PIN_REGEX = /^\d{4}$/;
const GHANA_MOBILE_E164_REGEX = /^\+233[2356789]\d{8}$/;

export class UssdServiceError extends Error {
  constructor(message) {
    super(message);
    this.name = "UssdServiceError";
  }
}

let supabaseAdmin = null;

function getSupabaseAdmin() {
  const supabaseUrl = (process.env.SUPABASE_URL || "").trim();
  const supabaseServiceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new UssdServiceError("USSD backend is not configured. Contact support.");
  }

  if (!supabaseAdmin) {
    supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
  }

  return supabaseAdmin;
}

function normalizePhone(phoneNumber) {
  const raw = String(phoneNumber || "").trim();
  const digits = raw.replace(/\D/g, "");

  if (!digits) {
    return "";
  }

  if (digits.startsWith("233") && digits.length === 12) {
    return `+${digits}`;
  }

  if (digits.startsWith("0") && digits.length === 10) {
    return `+233${digits.slice(1)}`;
  }

  if (digits.length === 9) {
    return `+233${digits}`;
  }

  if (raw.startsWith("+")) {
    return `+${digits}`;
  }

  return `+${digits}`;
}

function normalizeAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function getProvider(providerCode) {
  return PROVIDERS[providerCode] || null;
}

function normalizeAndValidatePhone(phoneNumber) {
  const normalized = normalizePhone(phoneNumber);
  if (!GHANA_MOBILE_E164_REGEX.test(normalized)) {
    throw new UssdServiceError("Invalid Ghana phone number format.");
  }

  return normalized;
}

function mapRpcError(error, fallbackMessage) {
  const composed = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`.toUpperCase();

  if (composed.includes("AGENT_NOT_FOUND")) {
    return new UssdServiceError("No USSD agent profile found for this number.");
  }
  if (composed.includes("INVALID_MSISDN")) {
    return new UssdServiceError("Invalid Ghana phone number format.");
  }
  if (composed.includes("INVALID_PIN_FORMAT")) {
    return new UssdServiceError("PIN must be 4 digits.");
  }
  if (composed.includes("INVALID_PIN")) {
    return new UssdServiceError("Invalid PIN.");
  }
  if (composed.includes("WALLET_NOT_FOUND")) {
    return new UssdServiceError("No agent wallet found for this number.");
  }
  if (composed.includes("INSUFFICIENT_BALANCE")) {
    return new UssdServiceError("Insufficient wallet balance.");
  }
  if (composed.includes("OFFER_REQUIRED") || composed.includes("INVALID_AMOUNT")) {
    return new UssdServiceError("Invalid bundle configuration.");
  }

  return new UssdServiceError(fallbackMessage);
}

async function getAgentContextByPhone(phoneNumber) {
  const normalizedPhone = normalizeAndValidatePhone(phoneNumber);
  const supabase = getSupabaseAdmin();

  const { data: agent, error } = await supabase
    .from("ussd_agents")
    .select("agent_id,msisdn,is_active")
    .eq("msisdn", normalizedPhone)
    .maybeSingle();

  if (error) {
    throw new UssdServiceError("Unable to verify USSD profile right now.");
  }

  if (!agent) {
    throw new UssdServiceError("No USSD agent profile found for this number.");
  }

  if (!agent.is_active) {
    throw new UssdServiceError("USSD access is disabled for this account.");
  }

  return {
    agentId: agent.agent_id,
    msisdn: agent.msisdn
  };
}

function assertPinFormat(pin) {
  if (!PIN_REGEX.test(String(pin || ""))) {
    throw new UssdServiceError("PIN must be 4 digits.");
  }
}

function mapOffersToBundles(offers, provider) {
  return (offers || []).map((offer, index) => {
    const amount = normalizeAmount(offer.price);
    const displayVolume = offer.data_amount || offer.title || "Data Bundle";

    return {
      code: String(index + 1),
      offerId: offer.id,
      amount,
      providerName: provider.displayName,
      networkKey: provider.networkKey,
      offerTitle: offer.title || displayVolume,
      displayVolume,
      label: `${displayVolume} - GHS ${amount.toFixed(2)}`
    };
  });
}

async function fetchAvailableBundles(providerCode, agentId) {
  const provider = getProvider(providerCode);
  if (!provider) {
    return [];
  }

  const supabase = getSupabaseAdmin();
  const commonSelect = "id,title,price,network,data_amount,description,is_active";

  const { data: agentOffers, error: agentOfferError } = await supabase
    .from("agent_offers")
    .select(commonSelect)
    .eq("agent_id", agentId)
    .eq("network", provider.networkKey)
    .eq("is_active", true)
    .order("price", { ascending: true })
    .limit(9);

  if (!agentOfferError && agentOffers && agentOffers.length > 0) {
    return mapOffersToBundles(agentOffers, provider);
  }

  const { data: offers, error: offersError } = await supabase
    .from("offers")
    .select(commonSelect)
    .eq("network", provider.networkKey)
    .eq("is_active", true)
    .order("price", { ascending: true })
    .limit(9);

  if (offersError) {
    throw new UssdServiceError("Unable to load bundles right now.");
  }

  return mapOffersToBundles(offers, provider);
}

export function getProviderMenu() {
  return ["Select Network:", "1. MTN", "2. Telecel", "3. AirtelTigo"].join("\n");
}

export async function getBundleMenu({ phoneNumber, providerCode }) {
  const provider = getProvider(providerCode);
  if (!provider) {
    return null;
  }

  const { agentId } = await getAgentContextByPhone(phoneNumber);
  const bundles = await fetchAvailableBundles(providerCode, agentId);

  if (!bundles.length) {
    throw new UssdServiceError(`No active ${provider.displayName} bundles found.`);
  }

  return [
    `Select ${provider.displayName} bundle:`,
    ...bundles.map((bundle) => `${bundle.code}. ${bundle.label}`)
  ].join("\n");
}

export async function getBundleSelection({ phoneNumber, providerCode, bundleCode }) {
  const { agentId } = await getAgentContextByPhone(phoneNumber);
  const bundles = await fetchAvailableBundles(providerCode, agentId);

  return bundles.find((bundle) => bundle.code === String(bundleCode || "")) || null;
}

export async function createDataOrder({ phoneNumber, providerCode, bundleCode, pin }) {
  assertPinFormat(pin);
  const agent = await getAgentContextByPhone(phoneNumber);

  const bundle = await getBundleSelection({ phoneNumber, providerCode, bundleCode });
  if (!bundle) {
    throw new UssdServiceError("Invalid bundle selection.");
  }

  const supabase = getSupabaseAdmin();
  const recipientPhone = normalizeAndValidatePhone(phoneNumber);
  const { data, error } = await supabase.rpc("ussd_create_agent_order", {
    p_msisdn: agent.msisdn,
    p_pin: String(pin),
    p_offer_id: bundle.offerId,
    p_offer_title: bundle.offerTitle,
    p_network: bundle.networkKey,
    p_data_amount: bundle.displayVolume,
    p_amount: bundle.amount,
    p_recipient_phone: recipientPhone,
    p_recipient_name: "USSD Customer"
  });

  if (error) {
    throw mapRpcError(error, "Unable to complete purchase right now.");
  }

  const result = Array.isArray(data) ? data[0] : data;

  if (!result || !result.order_id) {
    throw new UssdServiceError("Order processing failed. Please try again.");
  }

  try {
    await supabase.functions.invoke("send-notification", {
      body: {
        sendToAdmins: true,
        title: "New USSD Agent Order",
        message: `Agent ${agent.agentId} purchased ${bundle.displayVolume} for GHS ${bundle.amount.toFixed(2)} via USSD.`,
        type: "agent_order"
      }
    });
  } catch (error) {
    console.error("USSD admin notification error:", error);
  }

  const orderId = Number(result.order_id);

  return {
    orderId,
    reference: result.reference || `AGENT-${orderId}`,
    providerName: bundle.providerName,
    amount: bundle.amount,
    volume: bundle.displayVolume,
    balanceAfter: normalizeAmount(result.new_balance)
  };
}

export async function getWalletBalance({ phoneNumber, pin }) {
  assertPinFormat(pin);
  const agent = await getAgentContextByPhone(phoneNumber);
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase.rpc("ussd_get_wallet_balance", {
    p_msisdn: agent.msisdn,
    p_pin: String(pin)
  });

  if (error) {
    throw mapRpcError(error, "Unable to check wallet balance right now.");
  }

  return normalizeAmount(data);
}
