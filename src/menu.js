import {
  createDataOrder,
  getBundleSelection,
  getBundleMenu,
  getProviderMenu,
  getWalletBalance,
  UssdServiceError
} from "./services/mystiwanService.js";

function con(message) {
  return `CON ${message}`;
}

function end(message) {
  return `END ${message}`;
}

function normalizeText(text) {
  if (!text) {
    return "";
  }
  return String(text).trim();
}

function splitPath(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return [];
  }
  return normalized.split("*").filter(Boolean);
}

function mainMenu(serviceName) {
  return [
    `Welcome to ${serviceName}`,
    "1. Buy Data Bundle",
    "2. Check Wallet Balance",
    "3. Help",
    "4. Exit"
  ].join("\n");
}

function invalid(menu) {
  return con(["Invalid choice.", menu].join("\n"));
}

async function handleDataFlow(path, payload) {
  const providersMenu = getProviderMenu();

  if (path.length === 1) {
    return con(providersMenu);
  }

  const providerCode = path[1];
  let bundlesMenu;
  try {
    bundlesMenu = await getBundleMenu({
      phoneNumber: payload.phoneNumber,
      providerCode
    });
  } catch (error) {
    if (error instanceof UssdServiceError) {
      return end(error.message);
    }
    throw error;
  }

  if (!bundlesMenu) {
    return invalid(providersMenu);
  }

  if (path.length === 2) {
    return con(bundlesMenu);
  }

  const bundleCode = path[2];
  const bundle = await getBundleSelection({
    phoneNumber: payload.phoneNumber,
    providerCode,
    bundleCode
  });

  if (!bundle) {
    return invalid(bundlesMenu);
  }

  if (path.length === 3) {
    return con(
      [
        `Confirm Purchase`,
        `${bundle.providerName} ${bundle.volume} for GHS ${bundle.amount.toFixed(2)}`,
        `Phone: ${payload.phoneNumber}`,
        "1. Continue",
        "2. Cancel"
      ].join("\n")
    );
  }

  const decision = path[3];

  if (decision === "2") {
    return end("Transaction cancelled.");
  }

  if (decision !== "1") {
    return invalid(
      [
        "Confirm Purchase",
        `${bundle.providerName} ${bundle.volume} for GHS ${bundle.amount.toFixed(2)}`,
        "1. Continue",
        "2. Cancel"
      ].join("\n")
    );
  }

  if (path.length === 4) {
    return con("Enter your 4-digit wallet PIN:");
  }

  const pin = path[4];

  if (!/^\d{4}$/.test(pin)) {
    return con("Invalid PIN. Enter your 4-digit wallet PIN:");
  }

  try {
    const order = await createDataOrder({
      phoneNumber: payload.phoneNumber,
      providerCode,
      bundleCode,
      pin
    });

    return end(
      [
        "Purchase submitted successfully.",
        `Ref: ${order.reference}`,
        `${order.providerName} ${order.volume}`,
        `Amount: GHS ${order.amount.toFixed(2)}`,
        `Wallet: GHS ${order.balanceAfter.toFixed(2)}`
      ].join("\n")
    );
  } catch (error) {
    if (error instanceof UssdServiceError) {
      return end(error.message);
    }
    throw error;
  }
}

async function handleWalletFlow(path, payload) {
  if (path.length === 1) {
    return con("Enter your 4-digit wallet PIN:");
  }

  const pin = path[1];

  if (!/^\d{4}$/.test(pin)) {
    return con("Invalid PIN format. Enter a 4-digit PIN:");
  }

  try {
    const balance = await getWalletBalance({
      phoneNumber: payload.phoneNumber,
      pin
    });

    return end(`Wallet balance: GHS ${Number(balance).toFixed(2)}`);
  } catch (error) {
    if (error instanceof UssdServiceError) {
      return end(error.message);
    }
    throw error;
  }
}

function handleHelpFlow() {
  return end(
    [
      "Mystiwan USSD Help",
      "For support call: +233XXXXXXXXX",
      "WhatsApp: +233XXXXXXXXX"
    ].join("\n")
  );
}

export async function handleUssdRequest(payload) {
  const serviceName =
    process.env.USSD_SERVICE_NAME && process.env.USSD_SERVICE_NAME.trim()
      ? process.env.USSD_SERVICE_NAME.trim()
      : "Mystiwan E-Business";

  const path = splitPath(payload.text);
  const topLevelChoice = path[0];

  if (!topLevelChoice) {
    return con(mainMenu(serviceName));
  }

  if (topLevelChoice === "1") {
    return handleDataFlow(path, payload);
  }

  if (topLevelChoice === "2") {
    return handleWalletFlow(path, payload);
  }

  if (topLevelChoice === "3") {
    return handleHelpFlow();
  }

  if (topLevelChoice === "4") {
    return end("Thank you for using Mystiwan.");
  }

  return invalid(mainMenu(serviceName));
}
